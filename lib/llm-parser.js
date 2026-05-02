/**
 * LLM-based notice parser
 * Supports: MiniMax (Anthropic Messages API), OpenRouter, DeepSeek, OpenAI, Anthropic
 * Uses native https module — no external dependencies
 */

const https = require('https');
const http = require('http');

const SYSTEM_PROMPT = `你是一个高校通知解析助手。请分析用户提供的微信群通知文本，提取结构化信息并返回严格的JSON数组。

## 分类 (type字段，12选1)
- 科研：科研项目、基金申报、科技厅、课题、学术讲座、讲坛、论文、专利、获奖
- 教学：本科教学、毕设、课程、答辩、教务、教材、停课调课、成绩、考试、选课
- 研究生：研究生院、硕士、博士、导师、学位、推免保研、开题、中期考核
- 学工：辅导员、学生工作、奖助学金、评优、就业创业、挑战杯、竞赛
- 党务：党建、党委、党支部、党员、党校、入党、党课、政治学习
- 人事：招聘、人才引进、职称、岗位、人事调动
- 保密：保密制度、涉密、定密
- 国资：国有资产、设备采购、招标、固定资产
- 安全：实验室安全、消防、应急、防疫、卫生
- 国合：国际合作、全球、境外、海外、出国、留学生、交换生、访学
- 全院：全院大会、全体教职工、院领导、@所有人
- 其他：以上都不匹配

## 重要性 (importance: 1低|2中|3高)
- 3(高)：含"紧急""务必""必须""@所有人""截止""严禁""马上""立即""下班前"，或标题含"紧急"
- 2(中)：含"请""报名""欢迎""按时""安排""申报"
- 1(低)：纯参考/了解性质

## 日期规则
- publishDate：通知发布日期 YYYY-MM-DD。通知头有日期(如"4.30-")则用该日期，否则用今天
- deadline：截止日 YYYY-MM-DD 或 null
- "X月X日前"的截止日=当天；日期区间"X月X日—X月X日"结束日=deadline
- "预计X.X前"→ deadline；没有年份默认2026年
- 无截止日则deadline=null

## 联系人 (owner)
- "负责人：XX""联系人：XX""咨询：XX"→ 提取
- "XX 电话/邮箱"→ 姓名+联系方式
- 邮箱地址/电话号码也提取
- 都没有→ "未指定"

## 地点 (location)
- 会议室/报告厅/办公室(含数字)："学院楼113报告厅""515会议室""综合楼612"
- 广场/公园/大门："西大门内国旗广场"
- 不提取机构名(教务处/教育部不是地点)
- 没有→ null

## 关键信息 (keyPoints, 最多5条)
- 每个截止时间/提交要求/关键指令/重要条件
- 不包含问候语(各位老师好)、纯链接
- 每条≤70字

## 链接 (links)
- 所有https?://链接，最多5个

## 切分规则
- 【标题】标记独立通知；【时间】【地点】【联系人】【报名时间】【路线】等是子字段，合并到父通知
- 子字段内容放入body；title去除【】和日期前缀

## 返回格式（仅返回JSON数组，不要markdown标记）
[{"type":"科研","title":"通知标题","body":"正文内容","publishDate":"2026-05-02","deadline":"2026-05-08","importance":2,"owner":"张三 电话 138xxx","location":"综合楼612","links":[],"keyPoints":["要点1","要点2"]}]`;

// Default provider configs
const PROVIDER_DEFAULTS = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    model: 'MiniMax-M2.7',
    apiFormat: 'anthropic',  // Anthropic Messages API
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
function buildPrompt(rawText) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  return {
    system: SYSTEM_PROMPT,
    user: `请解析以下通知文本（今天日期：${todayStr}）：\n\n${rawText}`,
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
    body = JSON.stringify({
      model: model,
      max_tokens: 2048,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });
  } else {
    // OpenAI Chat Completions API format
    headers['Authorization'] = `Bearer ${config.apiKey}`;
    body = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.1,
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

  if (PROVIDER_DEFAULTS[provider]?.apiFormat === 'anthropic' ||
      provider === 'minimax' || provider === 'anthropic') {
    // Anthropic Messages API format
    if (data.content && Array.isArray(data.content)) {
      content = data.content.map(c => c.text || '').join('');
    } else {
      content = JSON.stringify(data);
    }
  } else {
    // OpenAI Chat Completions format
    content = data.choices?.[0]?.message?.content || '';
  }

  if (!content) throw new Error('Empty LLM response content');

  // Extract JSON from markdown code blocks if present
  let jsonStr = content.trim();
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
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
  notice.deadline = /^\d{4}-\d{2}-\d{2}$/.test(dd) ? dd : null;

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
  const prompt = buildPrompt(rawText);

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

  console.log(`[LLM] Parsed ${validated.length} notices successfully`);
  return validated;
}

module.exports = { parseWithLLM, SYSTEM_PROMPT };
