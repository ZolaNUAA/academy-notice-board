/**
 * LLM-based notice parser
 * Supports: MiniMax (Anthropic Messages API), OpenRouter, DeepSeek, OpenAI, Anthropic
 * Uses native https module — no external dependencies
 */

const https = require('https');
const http = require('http');

const SYSTEM_PROMPT = `你是高校通知解析器。从微信群通知文本中提取结构化JSON。严格返回JSON数组，不要markdown。

输出格式：
[{"type":"科研","title":"关于组织申报...","body":"通知正文","publishDate":"2026-04-30","deadline":"2026-05-08","importance":2,"owner":"霍然 电话 84892758","location":"综合楼612","links":[],"keyPoints":["5月8日前报送申报意向至科研院","限项：有在研项目者不得牵头","配套经费不低于1:2","咨询基础办霍然84892758"]}]

字段要求：
- type: 科研|教学|研究生|学工|党务|人事|保密|国资|安全|国合|全院|其他
- importance: 1一般 2需要注意 3紧急
- publishDate: 标题头有日期(m.d-)则用，否则今天
- deadline: 报名/提交/申报截止日。区分多个日期中哪个是真正的截止日。无则null
- owner: 联系人+联系方式。无则"未指定"
- location: 活动具体地点(不要填机构名)。无则null
- keyPoints: 用你自己的话总结3-5个关键行动点。每条≤50字。不要复制原文句子`

// Default provider configs
const PROVIDER_DEFAULTS = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com/v1/chat/completions',
    model: 'MiniMax-M2.7',
    apiFormat: 'openai',  // OpenAI Chat Completions API
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-sonnet-4.6',
    apiFormat: 'openai',  // OpenAI Chat Completions API
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    apiFormat: 'openai',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiFormat: 'openai',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
    apiFormat: 'anthropic',
  },
};

// Build prompt
function buildPrompt(rawText, parserConfig) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // Protect images and file links from being stripped by LLM
  const mediaMap = {};
  let mediaIdx = 0;
  let protectedText = rawText
    // Image markdown: ![alt](url)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full) => {
      const key = `__MEDIA_${mediaIdx}__`;
      mediaMap[key] = full;
      mediaIdx++;
      return key + ' (已上传的图片)';
    })
    // Attachment/file links already in body
    .replace(/\[([^\]]+)\]\((\/[^\s)]+)\)/g, (full) => {
      const key = `__MEDIA_${mediaIdx}__`;
      mediaMap[key] = full;
      mediaIdx++;
      return key + ' (已上传的附件)';
    });

  // Truncate extremely long text to avoid timeout (keep first 2500 chars)
  const MAX_TEXT = 2500;
  const text = protectedText.length > MAX_TEXT ? protectedText.substring(0, MAX_TEXT) + '\n...(文本过长已截断)' : protectedText;

  // Use config prompt if set, otherwise use built-in default
  const defaultInstruction = `从以下高校通知中提取结构化JSON。先列出关键要点，再输出JSON。
今天：${todayStr}

输出格式：
[{"type":"科研|教学|研究生|学工|党务|人事|保密|国资|安全|国合|全院|其他","title":"通知标题","body":"正文原文","publishDate":"YYYY-MM-DD","deadline":"YYYY-MM-DD或null","importance":1|2|3,"owner":"联系人或未指定","location":"地点或null","links":[],"keyPoints":["提炼的要点"]}]

keyPoints写法要求：
- 读完通知后，用你自己的话总结老师最需要知道的3-5件事
- 每条≤40字，像写备忘录
- 示例：["5月7日前提交申报材料","全校仅3个名额"]`;

  const systemPrompt = parserConfig.systemPrompt || '';
  let userPrompt = parserConfig.userPromptTemplate || defaultInstruction;
  // Replace variables in user prompt
  userPrompt = userPrompt.replace(/\{\{today\}\}/g, todayStr);

  return {
    prompt: { system: systemPrompt, user: `${userPrompt}\n\n${text}` },
    mediaMap,
  };
}

// Build HTTP request params for each provider
function buildRequest(provider, config, prompt) {
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.minimax;
  const apiUrl = config.apiUrl || defaults.baseUrl;
  const model = config.model || defaults.model;

  const url = new URL(apiUrl);
  const isHttps = url.protocol === 'https:';
  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (defaults.apiFormat === 'anthropic') {
    // Anthropic Messages API format
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const reqBody = { model: model, max_tokens: 2048, temperature: 0.3, messages: [{ role: 'user', content: prompt.user }] };
    if (prompt.system) reqBody.system = prompt.system;
    body = JSON.stringify(reqBody);
  } else {
    // OpenAI Chat Completions API format
    headers['Authorization'] = `Bearer ${config.apiKey}`;
    const msgs = [];
    if (prompt.system) msgs.push({ role: 'system', content: prompt.system });
    msgs.push({ role: 'user', content: prompt.user });
    body = JSON.stringify({
      model: model,
      messages: msgs,
      temperature: 0.3,
      max_tokens: 2048,
    });
  }

  // OpenRouter needs extra headers
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://nuaacs.site';
    headers['X-Title'] = 'Academy Notice Board';
  }

  return { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
           path: url.pathname + url.search, method: 'POST', headers, body, isHttps };
}

// Make HTTPS request with timeout
function makeRequest(params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = params.isHttps ? https : http;
    const req = lib.request(params, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const respText = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(respText);
        } else {
          let errMsg = `LLM HTTP ${res.statusCode}`;
          try {
            const err = JSON.parse(respText);
            errMsg += `: ${err.error?.message || err.error || respText.substring(0, 200)}`;
          } catch { errMsg += `: ${respText.substring(0, 200)}`; }
          reject(new Error(errMsg));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`LLM request failed: ${e.message}`)));
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('LLM request timeout')); });

    if (params.body) req.write(params.body);
    req.end();
  });
}

// Parse LLM response to extract JSON notice array
function parseLLMResponse(responseText, provider) {
  const data = JSON.parse(responseText);
  let content;

  // Try OpenAI Chat Completions format first (most common)
  if (data.choices?.[0]?.message?.content) {
    content = data.choices[0].message.content;
  }
  // Then Anthropic Messages format
  else if (data.content && Array.isArray(data.content)) {
    content = data.content.map(c => c.text || '').join('');
  }
  // Then direct text response
  else if (typeof data === 'string') {
    content = data;
  }
  // Last resort
  else {
    content = JSON.stringify(data);
  }

  if (!content) throw new Error('Empty LLM response content');

  // Strip <think>...</think> tags (MiniMax chain-of-thought)
  let jsonStr = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Extract JSON from markdown code blocks if present
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

  // Try to find JSON array
  const arrayMatch = jsonStr.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    return JSON.parse(arrayMatch[0]);
  }

  // Fallback: try entire string
  return JSON.parse(jsonStr);
}

// Valid notice types
const VALID_TYPES = new Set([
  '科研', '教学', '研究生', '学工', '党务', '人事',
  '保密', '国资', '安全', '国合', '全院', '其他'
]);

// Validate and normalize a parsed notice object
function validateNotice(obj, idx) {
  if (!obj || typeof obj !== 'object') return null;

  const notice = {};

  // type: validate against allowed set
  notice.type = VALID_TYPES.has(obj.type) ? obj.type : '其他';

  // typeClass: derive from type
  const typeClassMap = {
    '科研':'cat-research','教学':'cat-teaching','研究生':'cat-postgrad',
    '学工':'cat-student','党务':'cat-party','人事':'cat-personnel',
    '保密':'cat-confidential','国资':'cat-state-assets','安全':'cat-safety',
    '国合':'cat-international','全院':'cat-admin','其他':'cat-other'
  };
  notice.typeClass = typeClassMap[notice.type] || 'cat-other';

  // title: string, max 80 chars
  notice.title = String(obj.title || '通知').trim().substring(0, 80);

  // body: string, required
  notice.body = String(obj.body || obj.title || '').trim();

  // publishDate: YYYY-MM-DD format, default to today
  const pd = String(obj.publishDate || '');
  notice.publishDate = /^\d{4}-\d{2}-\d{2}$/.test(pd) ? pd :
    new Date().toISOString().substring(0, 10);

  // deadline: YYYY-MM-DD or null
  const dd = String(obj.deadline || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(dd)) {
    // Sanity check: if the month in deadline doesn't appear anywhere in body, might be a hallucination
    const ddMonth = parseInt(dd.substring(5, 7), 10);
    const ddDay = parseInt(dd.substring(8, 10), 10);
    const body = String(obj.body || obj.title || '');
    const monthInBody = new RegExp(String(ddMonth) + '\\s*月', 'g').test(body) ||
                        new RegExp(String(ddMonth) + '[./-]').test(body);
    const dayInBody = new RegExp(String(ddDay) + '\\s*日', 'g').test(body) ||
                      new RegExp('[^\\d]' + String(ddDay) + '[^\\d]').test(body);
    if (ddMonth >= 1 && ddMonth <= 12 && ddDay >= 1 && ddDay <= 31) {
      // Accept even if month not in body (short texts may not mention month)
      // But flag suspicious cases where month is wrong
      if (!monthInBody && !dayInBody && body.length > 50) {
        // Month and day not found in body — possibly hallucinated, but keep it
        // Could log a warning here
      }
      notice.deadline = dd;
    } else {
      notice.deadline = null;
    }
  } else {
    notice.deadline = null;
  }

  // If no deadline, infer based on importance
  if (!notice.deadline) {
    const imp = parseInt(obj.importance) || 2;
    const days = imp === 3 ? 7 : imp === 2 ? 14 : 30;
    const inferred = new Date();
    inferred.setDate(inferred.getDate() + days);
    notice.deadline = inferred.toISOString().substring(0, 10);
  }

  // importance: 1-3
  notice.importance = Math.min(3, Math.max(1, parseInt(obj.importance) || 2));

  // owner: string, default "未指定"
  notice.owner = (obj.owner && String(obj.owner).trim()) || '未指定';

  // location: string or null
  notice.location = obj.location ? String(obj.location).trim() : null;

  // links: array of strings, max 5
  notice.links = (Array.isArray(obj.links) ? obj.links : [])
    .map(l => String(l).trim())
    .filter(l => l.startsWith('http'))
    .slice(0, 5);

  // keyPoints: array of strings, max 5, each ≤100 chars
  notice.keyPoints = (Array.isArray(obj.keyPoints) ? obj.keyPoints : [])
    .map(k => String(k).trim().substring(0, 100))
    .filter(k => k.length > 3)
    .slice(0, 5);

  // Generate ID
  const ts = Date.now();
  notice.id = `n-${idx}-${ts}-${Math.random().toString(36).slice(2,6)}`;

  // expired
  notice.expired = notice.deadline ? new Date(notice.deadline) < new Date() : false;

  return notice;
}

// Main entry point
async function parseWithLLM(rawText, parserConfig) {
  if (!parserConfig || !parserConfig.apiKey) {
    throw new Error('LLM parser not configured (missing apiKey)');
  }

  const provider = parserConfig.provider || 'minimax';
  const timeout = parserConfig.timeout || 30000;
  const { prompt, mediaMap } = buildPrompt(rawText, parserConfig);
  // mediaMap is embedded as a property for restoration after parsing

  console.log(`[LLM] Parsing with ${provider}/${parserConfig.model || 'default'}...`);

  const requestParams = buildRequest(provider, parserConfig, prompt);
  const responseText = await makeRequest(requestParams, timeout);

  const rawNotices = parseLLMResponse(responseText, provider);

  if (!Array.isArray(rawNotices) || rawNotices.length === 0) {
    throw new Error('LLM returned no valid notice array');
  }

  const validated = rawNotices
    .map((obj, i) => validateNotice(obj, i))
    .filter(n => n !== null);

  if (validated.length === 0) {
    throw new Error('No notices passed validation');
  }

  // Restore protected image/attachment placeholders in bodies
  for (const n of validated) {
    if (n.body && mediaMap && Object.keys(mediaMap).length > 0) {
      for (const [key, original] of Object.entries(mediaMap)) {
        n.body = n.body.split(key).join(original);
        // Also restore in keyPoints if the placeholder leaked there
        for (let i = 0; i < n.keyPoints.length; i++) {
          n.keyPoints[i] = n.keyPoints[i].split(key).join('').replace(/\s*\(已上传的[^)]+\)/g, '').trim();
        }
      }
    }
  }

  console.log(`[LLM] Parsed ${validated.length} notices successfully`);
  return validated;
}

// Step 2: Body HTML enhancement (separate LLM call)
async function enhanceBody(bodyText, parserConfig) {
  if (!parserConfig || !parserConfig.bodyEnhancePrompt) return bodyText;

  const prompt = String(parserConfig.bodyEnhancePrompt).replace(/\{\{body\}\}/g, bodyText);
  const timeout = parserConfig.timeout || 30000;
  const reqConfig = { ...parserConfig, systemPrompt: '' };
  const requestParams = buildRequest(parserConfig.provider || 'minimax', reqConfig, { system: '', user: prompt });

  try {
    const responseText = await makeRequest(requestParams, timeout);
    let content;
    try {
      const data = JSON.parse(responseText);
      if (data.content && Array.isArray(data.content)) {
        content = data.content.map(c => c.text || '').join('');
      } else if (data.choices?.[0]?.message?.content) {
        content = data.choices[0].message.content;
      }
    } catch { content = responseText; }
    if (content && content.trim().length > 10 && content.includes(bodyText.substring(0, 15))) {
      return content.trim();
    }
  } catch(e) {
    console.error('[LLM] Body enhance failed:', e.message);
  }
  return bodyText; // fallback
}

module.exports = { parseWithLLM, enhanceBody, SYSTEM_PROMPT };
