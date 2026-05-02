const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;
const SERVER_START_TIME = new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
// 检测/mnt是否可用（存在且可写）
const BASE_DIR = process.env.STORAGE_MNT || '/mnt';
let USE_MNT = false;
try {
  USE_MNT = fs.existsSync(BASE_DIR) && fs.statSync(BASE_DIR).isDirectory();
  if (USE_MNT) {
    // 测试写入权限
    const testFile = path.join(BASE_DIR, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  }
} catch (e) {
  USE_MNT = false;
  console.warn('[Server] /mnt not writable, using local storage');
}

const DATA_DIR = USE_MNT ? path.join(BASE_DIR, 'data') : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notices.json');
const CONFIG_FILE = USE_MNT ? path.join(BASE_DIR, 'config.json') : path.join(__dirname, 'config.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOG_FILE = path.join(DATA_DIR, 'operation.log');

// Ensure backup directory exists
try {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
} catch(e) { console.warn('[Backup] Failed to create backup dir:', e.message); }
// When deployed on cloud, set BASE_URL to the public URL of the service
// e.g., https://notice-board2-252176-5-1259025170.sh.run.tcloudbase.com
const BASE_URL = process.env.BASE_URL || 'https://notice-board2-252176-5-1259025170.sh.run.tcloudbase.com';

// 访问验证码（可配置到环境变量）
const VERIFY_CODE = process.env.VERIFY_CODE || 'nuaa16';

// GitHub backup config
const GITHUB_BRANCH = 'main';
const GITHUB_DATA_PATH = 'data/notices.json';
const GITHUB_CONFIG_PATH = 'data/config.json';
let lastBackupTime = 0;
const BACKUP_DEBOUNCE_MS = 5000;

// Git operation retry config
const GIT_MAX_RETRIES = 3;
const GIT_RETRY_DELAY_MS = 2000;

function getDataFileContent() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch { return []; }
}

// Enhanced Git operation logger
function logGitOp(action, target, status, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    category: 'GIT',
    action,
    target,
    status, // 'SUCCESS', 'FAILED', 'RETRY', 'SKIPPED'
    ...details
  };
  const line = JSON.stringify(entry);
  console.log(`[GitOp] ${action} ${target} -> ${status}`, details.error ? `(${details.error})` : '');
  logOperation('GIT_OP', entry);
  return entry;
}

// Commit data to GitHub with retry logic
async function commitToGitHub(message, filePath, data, retries = GIT_MAX_RETRIES) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logGitOp('COMMIT', filePath, 'SKIPPED', { reason: 'GITHUB_TOKEN not configured' });
    return false;
  }

  const now = Date.now();
  if (now - lastBackupTime < BACKUP_DEBOUNCE_MS) {
    logGitOp('COMMIT', filePath, 'SKIPPED', { reason: 'Debounce active' });
    return false;
  }
  lastBackupTime = now;

  const https = require('https');
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const repo = 'ZolaNUAA/academy-notice-board';

  const getSha = (path) => {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AcademyNoticeBoard/1.0', 'Accept': 'application/vnd.github.v3+json' }
      };
      const req = https.request(options, (res) => {
        let d = '';
        let statusCode = res.statusCode;
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (statusCode === 200) {
              resolve(parsed.sha);
            } else if (statusCode === 404) {
              logGitOp('GET_SHA', path, 'SUCCESS', { reason: 'File not found, will create new' });
              resolve(null);
            } else {
              logGitOp('GET_SHA', path, 'FAILED', { statusCode, error: parsed.message || 'Unknown error' });
              resolve(null);
            }
          } catch (e) {
            logGitOp('GET_SHA', path, 'FAILED', { error: 'JSON parse error: ' + e.message });
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        logGitOp('GET_SHA', path, 'FAILED', { error: 'Network error: ' + e.message });
        resolve(null);
      });
      req.end();
    });
  };

  const updateFile = async (sha, path, retryCount = 0) => {
    const body = { message: message || `backup: ${new Date().toISOString()}`, content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const postData = JSON.stringify(body);

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}`,
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AcademyNoticeBoard/1.0', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };

      let statusCode = 0;
      let responseData = '';

      const req = https.request(options, (res) => {
        statusCode = res.statusCode;
        res.on('data', c => responseData += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (statusCode === 200 || statusCode === 201) {
              logGitOp('COMMIT', path, 'SUCCESS', {
                sha: parsed.content?.sha?.substring(0, 7),
                commit: parsed.commit?.sha?.substring(0, 7),
                message
              });
              resolve(true);
            } else {
              const errorMsg = parsed.message || `HTTP ${statusCode}`;
              logGitOp('COMMIT', path, 'FAILED', { statusCode, error: errorMsg });

              // Retry logic
              if (retryCount < retries && (statusCode === 403 || statusCode === 500 || statusCode === 502 || statusCode === 503)) {
                logGitOp('COMMIT', path, 'RETRY', { attempt: retryCount + 1, maxRetries: retries });
                setTimeout(() => updateFile(sha, path, retryCount + 1).then(resolve), GIT_RETRY_DELAY_MS);
              } else {
                resolve(false);
              }
            }
          } catch (e) {
            logGitOp('COMMIT', path, 'FAILED', { error: 'Response parse error: ' + e.message });
            resolve(false);
          }
        });
      });
      req.on('error', (e) => {
        logGitOp('COMMIT', path, 'FAILED', { error: 'Network error: ' + e.message });
        if (retryCount < retries) {
          logGitOp('COMMIT', path, 'RETRY', { attempt: retryCount + 1, maxRetries: retries });
          setTimeout(() => updateFile(sha, path, retryCount + 1).then(resolve), GIT_RETRY_DELAY_MS);
        } else {
          resolve(false);
        }
      });
      req.write(postData);
      req.end();
    });
  };

  // Backup notices.json
  const sha = await getSha(filePath);
  return await updateFile(sha, filePath);
}

// Commit binary file to GitHub (for uploads)
async function commitFileToGitHub(localFilePath, githubPath, retries = GIT_MAX_RETRIES) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logGitOp('COMMIT_FILE', githubPath, 'SKIPPED', { reason: 'GITHUB_TOKEN not configured' });
    return false;
  }

  if (!fs.existsSync(localFilePath)) {
    logGitOp('COMMIT_FILE', githubPath, 'SKIPPED', { reason: 'Local file not found', localPath: localFilePath });
    return false;
  }

  const https = require('https');
  const fileContent = fs.readFileSync(localFilePath);
  const content = fileContent.toString('base64');
  const repo = 'ZolaNUAA/academy-notice-board';
  const fileSize = fileContent.length;

  const getSha = (path) => {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AcademyNoticeBoard/1.0', 'Accept': 'application/vnd.github.v3+json' }
      };
      const req = https.request(options, (res) => {
        let d = '';
        let statusCode = res.statusCode;
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(d);
            if (statusCode === 200) {
              resolve(parsed.sha);
            } else if (statusCode === 404) {
              resolve(null);
            } else {
              logGitOp('GET_SHA', path, 'FAILED', { statusCode, error: parsed.message || 'Unknown' });
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        logGitOp('GET_SHA', path, 'FAILED', { error: e.message });
        resolve(null);
      });
      req.end();
    });
  };

  const updateFile = async (sha, path, retryCount = 0) => {
    const message = `backup: upload ${path} (${(fileSize / 1024).toFixed(1)}KB)`;
    const body = { message, content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const postData = JSON.stringify(body);

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}`,
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AcademyNoticeBoard/1.0', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      };

      let statusCode = 0;
      let responseData = '';

      const req = https.request(options, (res) => {
        statusCode = res.statusCode;
        res.on('data', c => responseData += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (statusCode === 200 || statusCode === 201) {
              logGitOp('COMMIT_FILE', path, 'SUCCESS', {
                size: `${(fileSize / 1024).toFixed(1)}KB`,
                sha: parsed.content?.sha?.substring(0, 7)
              });
              resolve(true);
            } else {
              logGitOp('COMMIT_FILE', path, 'FAILED', { statusCode, error: parsed.message || `HTTP ${statusCode}` });
              if (retryCount < retries && (statusCode >= 500)) {
                setTimeout(() => updateFile(sha, path, retryCount + 1).then(resolve), GIT_RETRY_DELAY_MS);
              } else {
                resolve(false);
              }
            }
          } catch (e) {
            logGitOp('COMMIT_FILE', path, 'FAILED', { error: 'Response parse error' });
            resolve(false);
          }
        });
      });
      req.on('error', (e) => {
        logGitOp('COMMIT_FILE', path, 'FAILED', { error: e.message });
        resolve(false);
      });
      req.write(postData);
      req.end();
    });
  };

  logGitOp('COMMIT_FILE', githubPath, 'STARTING', { localPath: localFilePath, size: `${(fileSize / 1024).toFixed(1)}KB` });
  const sha = await getSha(githubPath);
  return await updateFile(sha, githubPath);
}

// Backup notices.json
async function backupNotices() {
  const data = getDataFileContent();
  logGitOp('BACKUP', 'notices.json', 'STARTING', { noticeCount: data.length });
  const success = await commitToGitHub('backup: auto-save notices data', GITHUB_DATA_PATH, data);
  if (!success) {
    logGitOp('BACKUP', 'notices.json', 'FAILED', { reason: 'commitToGitHub returned false' });
  }
  return success;
}

// Backup config.json
async function backupConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    logGitOp('BACKUP', 'config.json', 'STARTING');
    const success = await commitToGitHub('backup: auto-save config', GITHUB_CONFIG_PATH, cfg);
    if (!success) {
      logGitOp('BACKUP', 'config.json', 'FAILED', { reason: 'commitToGitHub returned false' });
    }
    return success;
  } catch (e) {
    logGitOp('BACKUP', 'config.json', 'FAILED', { error: e.message });
    return false;
  }
}

// Backup a single uploaded file
async function backupUploadFile(type, filename) {
  const localDir = type === 'image' ? IMAGES_DIR : ATTACHMENTS_DIR;
  const localPath = path.join(localDir, filename);
  const githubPath = `data/uploads/${type}s/${filename}`;
  return await commitFileToGitHub(localPath, githubPath);
}

// Backup all upload files to GitHub
async function backupAllUploads() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  logGitOp('BACKUP', 'uploads', 'STARTING', { type: 'all' });

  let successCount = 0;
  let failCount = 0;

  for (const type of ['image', 'attachment']) {
    const dir = type === 'image' ? IMAGES_DIR : ATTACHMENTS_DIR;
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const localPath = path.join(dir, file);
      const githubPath = `data/uploads/${type}s/${file}`;
      const ok = await commitFileToGitHub(localPath, githubPath);
      if (ok) successCount++;
      else failCount++;
    }
  }

  logGitOp('BACKUP', 'uploads', 'COMPLETED', { success: successCount, failed: failCount });
  return { successCount, failCount };
}

// Ensure upload directory exists
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (e) {
  console.warn(`[Server] Failed to create upload directory: ${e.message}`);
}

// ============ Operation Log ============
function logOperation(action, details) {
  try {
    const maxLogSize = config.limits?.maxLogSize || 10 * 1024 * 1024;
    // Check log file size and rotate if needed
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > maxLogSize) {
        const backup = LOG_FILE + '.old';
        if (fs.existsSync(backup)) fs.unlinkSync(backup);
        fs.renameSync(LOG_FILE, backup);
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      action,
      ...details
    };
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch(e) {
    console.error('Log write error:', e.message);
  }
}

// ============ Config & Password ============
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    // Create default config with root password
    const config = {
      admins: {
        'ChangeMe@2024': { role: 'root', hash: hashPassword('ChangeMe@2024') }
      },
      version: 1,
      visits: 0,
      lastVisit: null,
      limits: {
        maxBodySize: 2 * 1024 * 1024,
        maxFileSize: 5 * 1024 * 1024,
        requestTimeout: 30000,
        maxLogSize: 10 * 1024 * 1024,
        pageLimit: 30
      },
      parser: {
        enabled: false,
        provider: 'minimax',
        apiKey: '',
        apiUrl: '',
        model: 'MiniMax-M2.7',
        timeout: 30000,
        useOnSubmit: false,
        systemPrompt: '',
        userPromptTemplate: '',
        bodyEnhancePrompt: ''
      }
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('⚠️ 默认管理员密码: ChangeMe@2024 (请尽快修改!)');
    return config;
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  // Migrate old single password format
  if (cfg.password && !cfg.admins) {
    cfg.admins = { [Object.keys(cfg).find(k => k !== 'version' && k !== 'visits' && k !== 'lastVisit' && k !== 'webhookSecret') || 'admin']: { role: 'root', hash: cfg.password } };
    delete cfg.password;
    saveConfig(cfg);
  }
  if (typeof cfg.visits !== 'number') cfg.visits = 0;
  if (!cfg.lastVisit) cfg.lastVisit = null;
  // Ensure limits exist with defaults
  if (!cfg.limits) cfg.limits = {
    maxBodySize: 2 * 1024 * 1024,
    maxFileSize: 5 * 1024 * 1024,
    requestTimeout: 30000,
    maxLogSize: 10 * 1024 * 1024,
    pageLimit: 30
  };
  // Ensure parser config exists with defaults
  if (!cfg.parser) cfg.parser = {
    enabled: false,
    provider: 'minimax',
    apiKey: '',
    apiUrl: '',
    model: 'MiniMax-M2.7',
    timeout: 30000,
    useOnSubmit: false,
    systemPrompt: '',
    userPromptTemplate: '',
    bodyEnhancePrompt: ''
  };
  return cfg;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  // GitHub backup disabled - data stored in Tencent Cloud COS
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const computedHash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return computedHash === hash;
}

function isValidPassword(password) {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return false;
  return true;
}

// Check password and return admin info
function checkAdminPassword(password) {
  if (!password) return null;
  for (const [username, info] of Object.entries(config.admins)) {
    if (verifyPassword(password, info.hash)) {
      return { username, role: info.role };
    }
  }
  return null;
}

// Load config on startup
const config = loadConfig();

// Ensure data directory and file exist
if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}

// ============ Restore data from GitHub on startup ============
async function restoreFromGitHub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logGitOp('RESTORE', 'all', 'SKIPPED', { reason: 'GITHUB_TOKEN not configured' });
    return;
  }

  logGitOp('RESTORE', 'all', 'STARTING', { timestamp: new Date().toISOString() });

  const repo = 'ZolaNUAA/academy-notice-board';
  const https = require('https');

  const getFileContent = (path) => {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${path}?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AcademyNoticeBoard/1.0', 'Accept': 'application/vnd.github.v3+json' }
      };
      const req = https.request(options, (res) => {
        let d = '';
        let statusCode = res.statusCode;
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(d);
            if (data.content) {
              const content = Buffer.from(data.content, 'base64').toString('utf-8');
              logGitOp('RESTORE', path, 'SUCCESS', { size: `${(data.size || 0) / 1024}KB` });
              resolve(JSON.parse(content));
            } else if (statusCode === 404) {
              logGitOp('RESTORE', path, 'SKIPPED', { reason: 'File not found on GitHub' });
              resolve(null);
            } else {
              logGitOp('RESTORE', path, 'FAILED', { statusCode, error: data.message || 'Unknown error' });
              resolve(null);
            }
          } catch (e) {
            logGitOp('RESTORE', path, 'FAILED', { error: 'Parse error: ' + e.message });
            resolve(null);
          }
        });
      });
      req.on('error', (e) => {
        logGitOp('RESTORE', path, 'FAILED', { error: 'Network error: ' + e.message });
        resolve(null);
      });
      req.end();
    });
  };

  try {
    // Restore notices.json
    const notices = await getFileContent(GITHUB_DATA_PATH);
    if (notices && Array.isArray(notices) && notices.length > 0) {
      const localNotices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (localNotices.length === 0 || notices.length > localNotices.length) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(notices, null, 2), 'utf-8');
        logGitOp('RESTORE', 'notices.json', 'SUCCESS', {
          restoredCount: notices.length,
          previousLocalCount: localNotices.length
        });
      } else {
        logGitOp('RESTORE', 'notices.json', 'SKIPPED', {
          reason: 'Local data is same or newer',
          localCount: localNotices.length,
          githubCount: notices.length
        });
      }
    } else {
      logGitOp('RESTORE', 'notices.json', 'SKIPPED', { reason: 'No data on GitHub or parse failed' });
    }

    // Restore config.json
    const cfg = await getFileContent(GITHUB_CONFIG_PATH);
    if (cfg && cfg.admins) {
      const localConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (!localConfig.admins || Object.keys(localConfig.admins).length < Object.keys(cfg.admins).length) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
        logGitOp('RESTORE', 'config.json', 'SUCCESS', { restoredAdmins: Object.keys(cfg.admins).length });
      } else {
        logGitOp('RESTORE', 'config.json', 'SKIPPED', {
          reason: 'Local config is same or newer',
          localAdmins: Object.keys(localConfig.admins).length,
          githubAdmins: Object.keys(cfg.admins).length
        });
      }
    } else {
      logGitOp('RESTORE', 'config.json', 'SKIPPED', { reason: 'No valid config on GitHub' });
    }

    logGitOp('RESTORE', 'all', 'COMPLETED', { timestamp: new Date().toISOString() });
  } catch (e) {
    logGitOp('RESTORE', 'all', 'FAILED', { error: e.message });
  }
}

// 启动时不再从GitHub恢复数据 - 数据存储在腾讯云COS

// ============ Parser (same logic as frontend) ============
const CATEGORY_RULES = [
  { key: 'research', name: '科研', kws: ['科研','基金','申报','科技厅','项目','学术','讲坛','省科技厅','基础研究','课题','科研项目','自然科学','社科','成果','论文','专利','获奖'], weight: 2 },
  { key: 'teaching', name: '教学', kws: ['教学','本科','毕设','课程','答辩','教务','停课','调课','培养','上课','选课','重修','教材','考试','成绩','教学质量','教学改革','一流课程','精品课程'], weight: 2 },
  { key: 'postgrad', name: '研究生', kws: ['研究生','硕士','博士','导师','学位','研究生院','推免','保研','考研','博士生','硕士生','开题','中期考核','学术报告'], weight: 2 },
  { key: 'student', name: '学工', kws: ['学工','辅导员','学生工作','奖助','评优','学生','党支部','团支部','奖学金','助学金','助学贷款','勤工俭学','困难生','心理','就业','创业'], weight: 2 },
  { key: 'party', name: '党务', kws: ['党务','党建','党委','党支部','党员','党校','党组织','思想政治','主题教育','两学一做','三会一课','民主评议','组织生活','入党','积极分子','发展党员','预备党员','党课','党费','政治学习'], weight: 3 },
  { key: 'personnel', name: '人事', kws: ['人事','招聘','人才','引进','职称','岗位','绩效','工资','福利','教师','教职工','面试','调动','录用','试用期','转正','离职'], weight: 2 },
  { key: 'confidential', name: '保密', kws: ['保密','涉密','安全保密','机密','秘密','定密','密级','保密工作','保密制度'], weight: 3 },
  { key: 'state-assets', name: '国资', kws: ['国资','资产','设备采购','招标','采购','报废','固定资产','耗材','办公用品','家具','车辆'], weight: 2 },
  { key: 'safety', name: '安全', kws: ['安全','实验室','培训','应急','消防','防汛','防台','防疫','卫生','医疗','安全检查','安全隐患','安全教育','安全生产'], weight: 2 },
  { key: 'international', name: '国合', kws: ['国合','国际化','全球','境外','海外','外审','港澳台','出国','出境','留学生','交换生','访学','联合培养','国际会议','外籍','Foreign','International'], weight: 2 },
  { key: 'admin', name: '全院', kws: ['全院大会','全体教职工大会','全院会议','全院通知','全院性的','院领导','院长','党委书记'], weight: 3 },
];
const OTHER_CATEGORY = { key: 'other', name: '其他', kws: [], weight: 0 };

const IMPORTANCE_KWS = {
  high: ['重要','紧急','急','@所有人','务必','必须','截止','下班前','请于','从重','从严','严禁','零容忍','第一时间','马上','立即','尽快'],
  medium: ['请','按时','安排','报名','欢迎','邀请','希望大家','请各','请各部','请各科室'],
  low: ['参考','了解','可知','可查','可参阅'],
};

function normalizeText(raw) {
  if (!raw) return '';
  let text = String(raw);
  // Remove emojis and special unicode chars
  text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  // Normalize whitespace
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\u00a0/g, ' ');
  text = text.replace(/\u3000/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function splitNoticeBlocks(raw) {
  const text = normalizeText(raw);
  if (!text) return [];

  // If no 【】 markers, treat as one block
  if (!text.includes('【')) return [text];

  // Sub-field headers that are sections WITHIN a single notice, NOT separate notices
  const SUB_FIELD_PATTERNS = /^(?:时间|地点|路线|报名时间|报名方式|签到|主题|主讲人|主持人|联系人|联系方式|联系电话|邮箱|学分|备注|附件|要求|说明|补充|注意|议程|参会人员|参加人员|费用|主办|承办|协办|对象|适用|范围|经费|限项)[：:】\s]|^(?:新一代|人工智能|新能源|新材料|生物医药|高端装备|机器人|集成电路|种业科技|海洋科技|6G|信息)/;

  // Split by 【 at line starts (not inline 【 in body text)
  const parts = text.split(/\n(?=【)/).filter(p => p.trim());
  if (parts.length <= 1) {
    // Try splitting by all 【 (some notices have 【 right after text without newline)
    const altParts = text.split(/(?=【)/).filter(p => p.trim());
    if (altParts.length <= 1) return [text];
    return mergeSubFields(altParts);
  }
  return mergeSubFields(parts);
}

// Merge 【sub-field】 parts back into their parent notice
function mergeSubFields(parts) {
  // 括号内容只要完全匹配这些子字段名，就是子字段（不需要后面跟冒号）
  const SUB_FIELD_NAMES = new Set([
    '时间','地点','路线','报名时间','报名方式','签到','主题','主讲人','主持人',
    '联系人','联系方式','联系电话','邮箱','学分','备注','附件','要求','说明',
    '补充','注意','议程','参会人员','参加人员','费用','主办','承办','协办',
    '对象','适用','范围','经费','限项','公示期','申报材料','校内截止','校内联系',
    '相关事项','重点提示','补充说明'
  ]);
  const INLINE_CONTENT = /^【[^】]{30,}】/;  // Very long bracket content = inline, not a header

  const blocks = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Check if this part's 【content】 is a sub-field header or inline content
    const bracketMatch = trimmed.match(/^【([^】\n]+)】?/);
    const bracketContent = bracketMatch ? bracketMatch[1].trim() : '';
    // 子字段：括号内容完全匹配已知子字段名，或括号内容以子字段名开头后跟冒号
    const isSubField = bracketMatch && (
      SUB_FIELD_NAMES.has(bracketContent) ||
      /^(?:时间|地点|路线|报名时间|报名方式|签到|主题|主讲人|主持人|联系人|联系方式|联系电话|邮箱|学分|备注|附件|要求|说明|补充|注意|议程|参会人员|参加人员|费用|主办|承办|协办|对象|适用|范围|经费|限项|公示期|申报材料|校内截止|校内联系|相关事项|重点提示|补充说明)[：:】]/.test(bracketContent)
    );
    const isInlineLong = bracketMatch && INLINE_CONTENT.test(trimmed);
    const isListLike = bracketMatch && /^【[^】]*[、，,]/.test(trimmed) && bracketMatch[1].length > 8;

    if ((isSubField || isInlineLong || isListLike) && blocks.length > 0) {
      // Merge with previous block (it's a sub-section)
      blocks[blocks.length - 1] += '\n' + trimmed;
    } else {
      blocks.push(trimmed);
    }
  }
  return blocks;
}

// Enhanced category inference with weighted scoring
function inferCategory(text) {
  // First priority: check header (first line or 【】 brackets) for explicit category markers
  const firstLine = text.split('\n')[0];
  const headerText = firstLine || text.substring(0, 100);

  // Category name patterns to look for in header
  const categoryPatterns = [
    { pattern: /国合/, name: '国合' },
    { pattern: /科研/, name: '科研' },
    { pattern: /教学/, name: '教学' },
    { pattern: /研究生/, name: '研究生' },
    { pattern: /学工/, name: '学工' },
    { pattern: /人事/, name: '人事' },
    { pattern: /保密/, name: '保密' },
    { pattern: /国资/, name: '国资' },
    { pattern: /安全/, name: '安全' },
    { pattern: /全院/, name: '全院' },
  ];

  for (const { pattern, name } of categoryPatterns) {
    if (pattern.test(headerText)) {
      const rule = CATEGORY_RULES.find(r => r.name === name);
      if (rule) return rule;
    }
  }

  // Fallback: weighted scoring on full text
  let bestScore = 0;
  let bestRule = OTHER_CATEGORY;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const kw of rule.kws) {
      const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        let s = 1;
        // Title area (first 80 chars) gets higher weight
        if (match.index < 80) s *= 2;
        // Exact match at very start gets bonus
        if (match.index < 5) s *= 2;
        score += s * rule.weight;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }
  return bestRule;
}

// Enhanced importance inference
function inferImportance(text) {
  // 只在前200字符(通知核心区域)里判断重要度
  const core = text.substring(0, 200);

  // 高重要度：需同时满足2个高优先级关键词，或在开头10字符内有高优先词
  let highCount = 0;
  for (const kw of IMPORTANCE_KWS.high) {
    if (core.includes(kw)) highCount++;
    if (highCount >= 2) return 3;
  }
  // 开头有强信号：标题或首行含"紧急"、"@所有人"直接高
  const firstLine = text.split('\n')[0].substring(0, 50);
  if (/紧急|@所有人|务必|必须|严禁/.test(firstLine)) return 3;

  // 中重要度：至少1个高优先词，或多个中优先词
  let midCount = 0;
  for (const kw of IMPORTANCE_KWS.medium) {
    if (core.includes(kw)) midCount++;
    if (midCount >= 3) return 2;
  }
  if (highCount >= 1) return 2;
  if (midCount >= 1) return 2;

  // 检查低重要度
  for (const kw of IMPORTANCE_KWS.low) {
    if (core.includes(kw)) return 1;
  }

  return 1;
}

// Parse relative dates like 今天, 明天, 后天, 周一, 下周一 etc.
function parseRelativeDate(text) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const relativePatterns = [
    { pattern: /今天|今日|本日/g, days: 0 },
    { pattern: /明天|明日/g, days: 1 },
    { pattern: /后天|后日/g, days: 2 },
    { pattern: /大后天|三日后/g, days: 3 },
  ];

  for (const { pattern, days } of relativePatterns) {
    if (pattern.test(text)) {
      const d = new Date(today);
      d.setDate(d.getDate() + days);
      return d;
    }
  }

  // Parse day of week like "下周一", "下周二", "本周一" etc.
  // Uses Chinese week (Mon=0, Tue=1, ..., Sun=6) for correct week boundary
  const weekdayLower = ['周日','周一','周二','周三','周四','周五','周六'];

  // "下周一" etc — fixed: 之前公式对所有情况都+7，导致大部分情况多算一周
  const nextWeekMatch = text.match(/下周([日一二三四五六])/);
  if (nextWeekMatch) {
    const targetDay = weekdayLower.indexOf('周' + nextWeekMatch[1]);
    if (targetDay !== -1) {
      const d = new Date(today);
      const todayJsDow = d.getDay();           // JS: 0=Sun, 1=Mon
      const targetJsDow = targetDay;           // same scale

      // Days until the very next occurrence of targetDay (0-6)
      let diff = targetJsDow - todayJsDow;
      if (diff < 0) diff += 7;

      // "下周X" = the X that falls in the NEXT calendar week (Chinese: week starts Mon)
      // If the next occurrence is already in next week, don't add 7.
      const todayChinaDow = todayJsDow === 0 ? 6 : todayJsDow - 1;   // 0=Mon
      const targetChinaDow = targetJsDow === 0 ? 6 : targetJsDow - 1;
      if (diff === 0) {
        diff = 7;                           // today is target → next week +7
      } else if (targetChinaDow > todayChinaDow) {
        diff += 7;                          // next occurrence is this week → skip to next
      }
      // else: next occurrence is already next week → diff is correct as-is

      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // "本周一" etc — note: always gives future occurrence within 7 days
  const thisWeekMatch = text.match(/本周([日一二三四五六])/);
  if (thisWeekMatch) {
    const targetDay = weekdayLower.indexOf('周' + thisWeekMatch[1]);
    if (targetDay !== -1) {
      const d = new Date(today);
      const diff = (7 - d.getDay() + targetDay) % 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  return null;
}

// Parse time like "14:30", "下午3点", "上午9:30"
function parseTimeInDay(text) {
  // HH:mm or HH:mm:ss - only if preceded by time indicator (上午/下午/早上/晚上/中午)
  const timeMatch = text.match(/(?:上午|下午|早上|晚上|中午)\s*(\d{1,2})[.:：](\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    if (text.includes('下午') || text.includes('晚上')) {
      if (hours < 12) hours += 12;
    }
    return { hours, minutes, seconds };
  }
  // "下午3点" or "下午3点30分"
  const justHourMatch = text.match(/(?:上午|下午|早上|晚上|中午)\s*(\d{1,2})[点时](?:(\d{1,2})分)?(?:\s*(\d{1,2})秒)?/);
  if (justHourMatch) {
    let hours = parseInt(justHourMatch[1], 10);
    const minutes = justHourMatch[2] ? parseInt(justHourMatch[2], 10) : 0;
    const seconds = justHourMatch[3] ? parseInt(justHourMatch[3], 10) : 0;
    if (text.includes('下午') || text.includes('晚上')) {
      if (hours < 12) hours += 12;
    }
    return { hours, minutes, seconds };
  }
  return null;
}

// Enhanced date parsing
function parseDates(text, fallback) {
  const year = new Date().getFullYear();
  const hits = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Separate pub candidates and ddl candidates
  const pubCandidates = [];
  const ddlCandidates = [];

  // If fallback exists, it becomes the pub (from header)
  let pub = null;
  if (fallback) {
    const time = parseTimeInDay(text);
    if (time) {
      pub = new Date(year, fallback.month - 1, fallback.day, time.hours, time.minutes);
    } else {
      pub = new Date(year, fallback.month - 1, fallback.day, 12, 0, 0);
    }
    pubCandidates.push(pub);
  }

  // Check for deadline keywords - dates after these are likely deadlines
  const hasDeadlineKeyword = /(?:截止|截至|deadline|结束|终止|申报截止|报名截止|材料截止|缴费截止)/i.test(text);
  const hasPublishKeyword = /(?:发布|公布|通知|印发)/i.test(text);

  // Relative dates: 今天, 明天, 下周一 etc.
  const relDate = parseRelativeDate(text);
  if (relDate) {
    const time = parseTimeInDay(text);
    if (time) {
      relDate.setHours(time.hours, time.minutes, time.seconds || 0);
    } else {
      relDate.setHours(23, 59, 59, 0);
    }
    if (hasDeadlineKeyword) {
      ddlCandidates.push(relDate);
    } else {
      pubCandidates.push(relDate);
    }
  }

  // Format: yyyy-mm-dd or yyyy/mm/dd
  [...text.matchAll(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/g)].forEach(m => {
    try {
      const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 23, 59, 59);
      if (!isNaN(d.getTime())) {
        if (hasDeadlineKeyword || m[0].includes('截止') || m[0].includes('申报') || m[0].includes('报名')) {
          ddlCandidates.push(d);
        } else {
          pubCandidates.push(d);
        }
      }
    } catch(e) {}
  });

  // Format: yyyy-mm-dd with time
  [...text.matchAll(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})[日T]?\s*(\d{1,2})[:：](\d{2})/g)].forEach(m => {
    try {
      const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
        parseInt(m[4], 10), parseInt(m[5], 10), 59);
      if (!isNaN(d.getTime())) {
        ddlCandidates.push(d);
      }
    } catch(e) {}
  });

  // Date ranges: "5月30日—6月30日", "4月28日-4月30日", "4月15日—5月11日"
  // 提取结束日期为 deadline
  [...text.matchAll(/(\d{1,2})月(\d{1,2})日?\s*[—\-~～至到]\s*(\d{1,2})月(\d{1,2})日?/g)].forEach(m => {
    try {
      const startD = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), 0, 0, 0);
      const endD = new Date(year, parseInt(m[3], 10) - 1, parseInt(m[4], 10), 23, 59, 59);
      if (!isNaN(endD.getTime())) {
        // 日期区间的结束日期通常是截止日
        const idx = m.index;
        const contextBefore = text.substring(Math.max(0, idx - 20), idx);
        const contextAfter = text.substring(idx, Math.min(text.length, idx + m[0].length + 20));
        const isDeadlineContext = /截止|截至|deadline|申报|报名|提交|征题|活动|公示|开展|举办/.test(contextBefore + contextAfter);
        if (isDeadlineContext || hasDeadlineKeyword) {
          ddlCandidates.push(endD);
        }
        // 开始日期作为pub候选
        if (!isNaN(startD.getTime())) {
          pubCandidates.push(startD);
        }
      }
    } catch(e) {}
  });

  // Shorthand dates: "5.7前", "5.8前" (mm.dd without year)
  [...text.matchAll(/(?:于|预计|请于|务必于|在)?(\d{1,2})[.](\d{1,2})前/g)].forEach(m => {
    try {
      const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), 23, 59, 59);
      if (!isNaN(d.getTime())) ddlCandidates.push(d);
    } catch(e) {}
  });

  // Format: mm月dd日
  // 只有附近有截止关键词时才归为 deadline；否则归为发布日期候选
  [...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)].forEach(m => {
    try {
      let hours = 23, minutes = 59;
      const time = parseTimeInDay(text);
      if (time) { hours = time.hours; minutes = time.minutes; }
      const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), hours, minutes, 59);
      if (!isNaN(d.getTime())) {
        // 检查该日期前后30字符内是否有截止关键词
        const idx = m.index;
        const contextBefore = text.substring(Math.max(0, idx - 30), idx);
        const contextAfter = text.substring(idx, Math.min(text.length, idx + m[0].length + 30));
        const nearDeadlineKws = /截止|截至|deadline|申报截止|报名截止|提交截止|材料截止|请于|务必于|必须于|下班前/;
        if (hasDeadlineKeyword || nearDeadlineKws.test(contextBefore + contextAfter)) {
          ddlCandidates.push(d);
        } else {
          pubCandidates.push(d);
        }
      }
    } catch(e) {}
  });

  // Format: mm-dd or mm/dd (within current year) - likely deadlines if hasDeadlineKeyword
  [...text.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/g)].forEach(m => {
    try {
      const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), 23, 59, 59);
      if (!isNaN(d.getTime())) {
        if (hasDeadlineKeyword) {
          ddlCandidates.push(d);
        } else {
          pubCandidates.push(d);
        }
      }
    } catch(e) {}
  });

  // Remove duplicates
  const uniquePub = pubCandidates.filter((d, i, arr) =>
    arr.findIndex(x => x.getTime() === d.getTime()) === i
  );
  const uniqueDdl = ddlCandidates.filter((d, i, arr) =>
    arr.findIndex(x => x.getTime() === d.getTime()) === i
  );

  // If no pub from fallback, use earliest pub candidate
  if (!pub && uniquePub.length) {
    pub = new Date(uniquePub[0]);
    pub.setHours(12, 0, 0, 0);
  }

  // DDL: filter to future dates
  const futureDdl = uniqueDdl.filter(d => d >= new Date(today.getTime() - 86400000)).sort((a, b) => a - b);
  let ddl = null;
  if (futureDdl.length) {
    ddl = futureDdl[0];
  } else if (uniqueDdl.length > 1) {
    // If only past dates found but hasDeadlineKeyword, use earliest future-ish date
    ddl = uniqueDdl.sort((a, b) => a - b).at(-1);
  } else if (uniqueDdl.length === 1) {
    ddl = uniqueDdl[0];
  }

  // If still no ddl, try using second pub candidate as fallback ddl
  if (!ddl && uniquePub.length > 1) {
    const futurePub = uniquePub.filter(d => d >= new Date(today.getTime() - 86400000)).sort((a, b) => a - b);
    if (futurePub.length > 1) ddl = futurePub[1];
  }

  return { pub, ddl };
}

// Enhanced owner parsing
function parseOwner(text) {
  // Blacklist: 不应该被识别为联系人的常见短语
  const OWNER_BLACKLIST = new Set([
    '谢谢大家','谢谢各位','谢谢配合','谢谢支持','谢谢合作',
    '准时参加','提前入场','提前到场','请勿迟到',
    '请回复','收到请回复','敬请周知','相互转告',
    '截止日期','截止时间','报名截止','申报截止',
    '提交方式','提交要求','具体要求','注意事项',
    '欢迎参加','敬请光临','欢迎报名','欢迎踊跃',
    '请查收','请注意','请关注','请留意',
    '尽快完成','及时完成','按时完成',
    '特此通知','特此公告',
    '以上信息','以上通知','以上内容',
    '没有报名','无需报名',
    '访问权限','定位权限','位置信息','开启手机','扫码报名',
    '活动前必须','访问权限','位置信息',
    '敬请周知','特此周知',
  ]);

  // Pattern: 负责人/联系人/对接人：张三
  const contactPattern = /(?:负责人|联系人|对接人|经办人|审批人|发件人|报送人|报告人)\s*[:：]\s*([^\n，。,；;]+)/;

  const m = text.match(contactPattern);
  if (m) {
    let name = m[1].trim();
    name = name.replace(/[，。,；;.。]+$/, '');
    if (name.length >= 2 && name.length <= 20 && !OWNER_BLACKLIST.has(name)) return name;
  }

  // 检查负责人/联系人 独立行（无冒号分隔）
  const standaloneMatch = text.match(/(?:负责人|联系人)\s+(\S{2,10})/);
  if (standaloneMatch && !OWNER_BLACKLIST.has(standaloneMatch[1].trim())) {
    return standaloneMatch[1].trim();
  }

  // 人名+电话号码粘连，如 "霍然84892758"、"张小兰025-84892758"
  const gluedNamePhone = text.match(/(?:咨询|联系|致电)\s*([\u4e00-\u9fa5]{2,3})\s*(\d{3,4}[-－]?\d{7,8}|\d{7,8}|\d{11})/);
  if (gluedNamePhone) {
    const name = gluedNamePhone[1];
    const num = gluedNamePhone[2].replace(/[-－\s]/g, '');
    if (!OWNER_BLACKLIST.has(name)) return `${name} 电话 ${num}`;
  }
  // 更宽松的模式: 行末中文名+数字，如 "霍然84892758"
  const looseGlue = text.match(/([\u4e00-\u9fa5]{2,3})(\d{7,11})(?:[\s，,。；;]|$)/);
  if (looseGlue && !OWNER_BLACKLIST.has(looseGlue[1])) {
    return `${looseGlue[1]} 电话 ${looseGlue[2]}`;
  }

  // Email pattern
  const email = text.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (email) return `邮箱 ${email[1]}`;

  // Phone number pattern (various formats)
  const phone = text.match(/(?:电话|手机|联系方式|联系电话)[:：]?\s*(\d{3,4}[-－]?\d{7,8}|\d{11}|\d{3}[-－]\d{4}[-－]\d{4}|\(\d{3,4}\)\s*\d{7,8})/);
  if (phone) {
    const num = phone[1].replace(/[\(\)\s]/g, '');
    return `电话 ${num}`;
  }

  // WeChat/Tech team contact (只匹配明确的账号格式)
  const wx = text.match(/(?:微信|企微|钉钉|飞书)[：:]\s*(\S{3,30})/);
  if (wx && wx[1].length < 30 && !/[权限设置开启必须]{2,}/.test(wx[1]) && !OWNER_BLACKLIST.has(wx[1])) return wx[1];

  // Signature line at end (2-4 Chinese chars) — 加黑名单过滤
  const signMatch = text.match(/\n([\u4e00-\u9fa5]{2,4})\s*$/m);
  if (signMatch && !OWNER_BLACKLIST.has(signMatch[1])) return signMatch[1];

  // Last line with name-like pattern
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(lastLine) && !OWNER_BLACKLIST.has(lastLine)) return lastLine;
  }

  return '未指定';
}

// Enhanced link extraction
function extractLinks(text) {
  const links = new Set();

  // Standard URLs - stop at closing brackets/parentheses (including Chinese)
  const urlPattern = /https?:\/\/[^\s\uFF08\u2018\u2019\u300C<>"'\\（）\)\]\uff09\]]+/gi;

  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    // Clean trailing punctuation (including Chinese brackets)
    let url = match[0].replace(/[。，,.。;；)>\]\uff09\]]+$/, '');
    // Validate URL
    try {
      new URL(url.startsWith('http') ? url : 'http://' + url);
      links.add(url);
    } catch(e) {}
  }

  // PDF/Office document links
  const docPatterns = [
    /[a-zA-Z0-9_-]+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt)/gi,
  ];

  for (const pattern of docPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[0];
      if (!url.startsWith('http')) {
        // Skip if it looks like a filename, not a URL
        if (/^[a-zA-Z0-9_-]+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt)$/i.test(url)) {
          continue;
        }
        links.add(url);
      }
    }
  }

  return [...links].slice(0, 5); // Limit to 5 links
}

// Extract key information bullet points
// Extract location from text
function extractLocation(text) {
  // Pattern 1: 在XXX会议室|报告厅|办公室|教室|实验室
  // "于"前不加"便/对/由/关/属/至/在"等，避免"便于/对于/由于/关于"误匹配
  const venueMatch = text.match(/(?:在|地点[:：]|(?<![便对由关属至在])于)\s*([^\n，。,；;]{3,40}(?:会议室|报告厅|办公室|教室|实验室|广场|大厅|中心|基地|礼堂|活动室|接待室|橱窗))/);
  if (venueMatch) return venueMatch[1].trim();

  // Pattern 2: Building + Room: 学院楼113报告厅, 综合楼612, 515会议室
  const roomMatch = text.match(/([\u4e00-\u9fa5]{2,8}(?:楼|学院|校区|中心))?\s*(\d{3,4})\s*(?:室|会议室|报告厅|办公室|教室)/);
  if (roomMatch) {
    const building = roomMatch[1] || '';
    return (building + roomMatch[2] + (roomMatch[3] || '室')).trim();
  }

  // Pattern 3: "XXX学院XXX室" format
  const collegeRoom = text.match(/([\u4e00-\u9fa5]{2,6}学院)\s*(\d{3,4})\s*(?:室|会议室|报告厅|办公室)/);
  if (collegeRoom) return collegeRoom[0].trim();

  // Pattern 4: "地点：XXX" or "位置：XXX"
  const locLabel = text.match(/(?:地点|位置|地址)[：:]\s*([^\n，。,；;]{3,60})/);
  if (locLabel) return locLabel[1].trim();

  // Pattern 5: 地名+方位 (排除"便/对/由/关/属/至/在"后的"于")
  const placeMatch = text.match(/(?:在|(?<![便对由关属至在])于|至)\s*([^\n，。,；;]{2,30}(?:广场|公园|门口|大门|签到点|报到处|集合点|接待处|办事大厅|报告厅|会议室|教室|办公室|实验室|活动室|路|街|道|校园|校区|教学楼|行政楼))/);
  if (placeMatch) return placeMatch[1].trim();

  return null;
}

function extractKeyPoints(body) {
  const points = [];
  // 过滤纯问候行(长度<15才当问候)、无意义行
  const GREETING_ONLY = /^(各位老师好|老师好|大家好|各位老师)[！!，,。；;]*$/;
  let lines = body.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 4 && l.length < 200 && !GREETING_ONLY.test(l) && !/^\[/.test(l));

  // 如果行数太少(<=2行)但有长行，尝试按。；；分句
  if (lines.length <= 2 && lines.some(l => l.length > 60)) {
    const splitLines = [];
    for (const line of lines) {
      if (line.length > 60) {
        // 按中文标点切分并保留
        const parts = [];
        let current = '';
        for (const ch of line) {
          current += ch;
          if ('。；；'.includes(ch) && current.trim().length > 5) {
            parts.push(current.trim());
            current = '';
          }
        }
        if (current.trim().length > 5) parts.push(current.trim());
        for (const p of parts) {
          if (p.length > 5 && p.length < 150) splitLines.push(p);
        }
      } else {
        splitLines.push(line);
      }
    }
    if (splitLines.length > lines.length) lines = splitLines;
  }

  const importantKws = ['截止', '请于', '务必', '必须', '申请', '提交', '完成', '报名', '审核', '确认', '参会', '地点', '时间'];
  const dateRegex = /(\d+月\d+日|\d{1,2}[.\/-]\d{1,2})/;

  for (const line of lines.slice(0, 10)) {
    const cleaned = line.replace(/^[\s\d、.。:：•\-–—>【】\[\]]+/, '').replace(/[抱拳玫瑰庆祝花朵]+/g, '').trim();
    if (cleaned.length < 5 || cleaned.length > 180) continue;
    // 只过滤纯问候的短行
    if (cleaned.length < 15 && GREETING_ONLY.test(cleaned)) continue;

    let isKey = false;
    for (const kw of importantKws) {
      if (cleaned.includes(kw)) { isKey = true; break; }
    }
    if (!isKey && dateRegex.test(cleaned)) isKey = true;
    if (!isKey && /^(?:请|需|应|如|可|欢迎)/.test(cleaned)) isKey = true;

    if (isKey || points.length < 3) {
      if (!cleaned.startsWith('http') && !points.includes(cleaned)) {
        points.push(cleaned);
      }
    }
    if (points.length >= 5) break;
  }
  return points;
}

// Smart title extraction
function extractTitle(block) {
  // Try header format: 【标题】 or 【字段名】value
  // Support both 【标题】 and 【字段名】value (without closing bracket)
  const headerMatchWithBracket = block.match(/^【([^】]+)】/);
  const headerMatchWithoutBracket = block.match(/^【([^】\n]+)/);

  let workingBlock = block;
  let isFieldHeader = false;

  if (headerMatchWithBracket) {
    const title = headerMatchWithBracket[1].trim();
    if (title.length >= 2 && title.length <= 50) {
      if (!/^(时间|地点|负责人|联系人|电话|主办|组织|发布|截止|报名)/.test(title)) {
        return title;
      }
      // Field header detected - strip it from workingBlock
      isFieldHeader = true;
      workingBlock = block.replace(/^【[^】]+】/, '').trim();
      // Strip leading ： or : if present
      if (workingBlock.startsWith('：') || workingBlock.startsWith(':')) {
        workingBlock = workingBlock.slice(1).trim();
      }
    }
  } else if (headerMatchWithoutBracket) {
    const title = headerMatchWithoutBracket[1].trim();
    // Check if it's a field header - either starts with field name OR is very long (unclosed bracket case)
    const isLikelyFieldHeader = /^(时间|地点|负责人|联系人|电话|主办|组织|发布|截止|报名)/.test(title);
    const isTooLongForTitle = title.length > 30; // If > 30 chars, likely not a real title

    if (title.length >= 2 && (isLikelyFieldHeader || isTooLongForTitle)) {
      // Field header detected - strip it from workingBlock
      // Use a more precise pattern to handle 【时间】：... format
      isFieldHeader = true;
      workingBlock = block.replace(/^【[^】\n]*】?/, '').trim();
      // Also try to strip trailing ： or : if present
      if (workingBlock.startsWith('：') || workingBlock.startsWith(':')) {
        workingBlock = workingBlock.slice(1).trim();
      }
    } else if (title.length >= 2 && title.length <= 50) {
      return title;
    }
  }

  // First meaningful line from workingBlock (after field header is stripped)
  const lines = workingBlock.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    const cleaned = line.trim();
    // Skip if looks like a date (with optional spaces)
    if (/^\d{4}[\s\/-]*年/.test(cleaned)) continue;
    if (/^\d{3}[-]?\d{4,}/.test(cleaned)) continue;
    if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(cleaned)) continue;
    // Skip if starts with field header punctuation
    if (/^[：:、，,【】《》""''""''【】]/.test(cleaned)) continue;
    if (cleaned.length < 2) continue;

    // Return first 50 chars
    return cleaned.slice(0, 50);
  }

  // If all lines were skipped (e.g., content was only a date/time), try to extract content after the date
  // Pattern: YYYY年MM月DD日 or YYYY-MM-DD with optional spaces
  const dateMatch = workingBlock.match(/^(\d{4}[\s\/-]*年[\s\/-]*\d{1,2}[\s\/-]*月[\s\/-]*\d{1,2}[\s\/-]*[日号]?)/);
  if (dateMatch) {
    const afterDate = workingBlock.slice(dateMatch[0].length).trim();
    if (afterDate.length >= 2) {
      return afterDate.slice(0, 50);
    }
  }

  return '通知';
}

function toISO(dt) {
  if (!dt || isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

function parseNoticeBlock(block, idx) {
  const title = extractTitle(block);
  // Remove header from body - handle both closed and unclosed headers
  let body = block
    .replace(/^【[^】]+】/, '') // Remove 【标题】 format
    .replace(/^【[^】\n]+/, '') // Remove 【字段 without closing bracket
    .trim();
  // Also strip leading ： or : if present
  if (body.startsWith('：') || body.startsWith(':')) {
    body = body.slice(1).trim();
  }

  // Extract date from header if present
  const headerMatch = block.match(/^【([^】]+)】/);
  let fallback = null;
  if (headerMatch) {
    const compactDate = headerMatch[1].match(/(\d{1,2})[./-](\d{1,2})/);
    if (compactDate) {
      fallback = { month: +compactDate[1], day: +compactDate[2] };
    }
  }

  const { pub, ddl } = parseDates(body, fallback);
  const cat = inferCategory(`${title}\n${body}`);
  const imp = inferImportance(`${title}\n${body}`);
  const owner = parseOwner(body);
  const links = extractLinks(body);
  const keyPoints = extractKeyPoints(body);
  const location = extractLocation(body);
  const now = new Date();

  // 从标题/头部提取发布日期：如"4.30-科研-..."、"4.28-教学-..."
  let publishDate = toISO(now); // 默认今天
  let cleanTitle = title;
  const headerDateMatch = block.match(/^【(\d{1,2})[./-](\d{1,2})/);
  if (headerDateMatch) {
    const m = parseInt(headerDateMatch[1], 10);
    const d = parseInt(headerDateMatch[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      publishDate = `${now.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      // 去掉标题中的日期前缀 "4.30-科研-" → "科研-"
      cleanTitle = title.replace(/^\d{1,2}[.\/-]\d{1,2}\s*[-—–]\s*/, '');
    }
  }

  const expired = ddl ? ddl < now : false;

  // 无截止日期时自动推测：根据重要性给7-30天
  let finalDdl = ddl;
  if (!finalDdl) {
    const days = imp === 3 ? 7 : imp === 2 ? 14 : 30;
    const inferred = new Date(now);
    inferred.setDate(inferred.getDate() + days);
    inferred.setHours(23, 59, 59, 0);
    finalDdl = inferred;
  }

  return {
    id: `n-${idx}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: cat.name,
    typeClass: `cat-${cat.key}`,
    title: cleanTitle,
    body,
    publishDate,
    deadline: toISO(finalDdl),
    importance: imp,
    owner, location, links, keyPoints, expired,
  };
}

function parseRawInput(raw) {
  return splitNoticeBlocks(raw).map((b, i) => parseNoticeBlock(b, i));
}

// ============ Dual Parser Dispatch ============
async function dispatchParse(raw, parserConfig) {
  if (parserConfig && parserConfig.enabled && parserConfig.provider && parserConfig.apiKey) {
    try {
      const llmParser = require('./lib/llm-parser');
      const result = await llmParser.parseWithLLM(raw, parserConfig);
      if (result && Array.isArray(result) && result.length > 0) {
        // Step 2: Body HTML enhancement if configured
        if (parserConfig.bodyEnhancePrompt) {
          for (const n of result) {
            if (n.body) n.body = await llmParser.enhanceBody(n.body, parserConfig);
          }
        }
        logOperation('LLM_PARSE_SUCCESS', {
          count: result.length,
          provider: parserConfig.provider,
          model: parserConfig.model
        });
        return result;
      }
    } catch (e) {
      console.error('[LLM] Parse failed, falling back to local:', e.message);
      logOperation('LLM_PARSE_FAILED', {
        error: e.message?.substring(0, 200),
        provider: parserConfig.provider
      });
    }
  }
  // Fallback to local parser
  return parseRawInput(raw);
}

// ============ Data Operations ============
function readNotices() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch { return []; }
}

function _writeNotices(notices) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(notices, null, 2), 'utf-8');
}

// Promise-based write mutex — serializes all read-modify-write to prevent race conditions
let _writeMutex = Promise.resolve();

function modifyNotices(modifier) {
  const result = _writeMutex.then(async () => {
    const notices = readNotices();
    const updated = await modifier(notices);
    _writeNotices(updated);
    return updated;
  });
  // Keep the chain alive even if one operation fails
  _writeMutex = result.catch(() => {});
  return result;
}

// ============ Auth Handlers ============
const SESSION_COOKIE = 'anb_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function isHttps(req) {
  return !!(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https');
}

function buildSessionCookie(token, maxAgeSeconds, secure) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function createSession(admin, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, {
    username: admin.username,
    role: admin.role,
    expiresAt
  });
  return { token, expiresAt, secure: isHttps(req) };
}

function getSessionAdmin(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  const current = config.admins?.[session.username];
  if (!current) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return {
    username: session.username,
    role: current.role || session.role,
    token
  };
}

function invalidateSessionsForUser(username, exceptToken = '') {
  for (const [token, session] of sessions) {
    if (session.username === username && token !== exceptToken) {
      sessions.delete(token);
    }
  }
}

function requireAdmin(req, res) {
  const admin = getSessionAdmin(req);
  if (!admin) {
    sendJSON(res, 401, { error: '需要管理员登录' });
    return null;
  }
  return admin;
}

function requireRoot(req, res) {
  const admin = requireAdmin(req, res);
  if (!admin) return null;
  if (admin.role !== 'root') {
    sendJSON(res, 403, { error: '需要超级管理员权限' });
    return null;
  }
  return admin;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}, 30 * 60 * 1000);

// ============ 登录频率限制 ============
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;        // 最多失败5次
const LOGIN_WINDOW_MS = 10 * 60 * 1000;  // 10分钟窗口
const LOGIN_BAN_MS = 30 * 60 * 1000;     // 封30分钟

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record) {
    loginAttempts.set(ip, { count: 0, firstFail: now, banUntil: 0 });
    return { allowed: true };
  }

  // 检查是否在封禁中
  if (record.banUntil > now) {
    return { allowed: false, remaining: Math.ceil((record.banUntil - now) / 1000 / 60) };
  }

  // 如果窗口过期，重置
  if (now - record.firstFail > LOGIN_WINDOW_MS) {
    record.count = 0;
    record.firstFail = now;
  }

  return { allowed: true };
}

function recordLoginFail(ip) {
  const now = Date.now();
  let record = loginAttempts.get(ip);
  if (!record) {
    record = { count: 0, firstFail: now, banUntil: 0 };
    loginAttempts.set(ip, record);
  }

  record.count++;

  // 如果窗口过期，重置
  if (now - record.firstFail > LOGIN_WINDOW_MS) {
    record.count = 1;
    record.firstFail = now;
  }

  // 超过阈值则封禁
  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    record.banUntil = now + LOGIN_BAN_MS;
    console.log(`[Security] IP ${ip} banned for ${LOGIN_BAN_MS/1000/60} min (${record.count} failed attempts)`);
  }
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

// 每30分钟清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (record.banUntil < now && now - record.firstFail > LOGIN_WINDOW_MS * 2) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000);

async function handleLogin(req, res) {
  try {
    const { password } = await parseJSONBody(req);
    if (!password) return sendJSON(res, 400, { error: 'password required' });

    const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip = ipRaw.replace('::ffff:', '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';

    // 检查频率限制
    const rateCheck = checkLoginRateLimit(ip);
    if (!rateCheck.allowed) {
      logOperation('LOGIN_BANNED', { ip, remaining: rateCheck.remaining, userAgent: ua });
      return sendJSON(res, 429, { error: `登录尝试过于频繁，请 ${rateCheck.remaining} 分钟后再试` });
    }

    const admin = checkAdminPassword(password);

    if (admin) {
      const session = createSession(admin, req);
      recordLoginSuccess(ip);
      logOperation('LOGIN', {
        username: admin.username,
        role: admin.role,
        ip: ip,
        userAgent: ua
      });
      sendJSON(res, 200, { success: true, username: admin.username, role: admin.role }, {
        'Set-Cookie': buildSessionCookie(session.token, Math.floor(SESSION_TTL_MS / 1000), session.secure)
      });
    } else {
      recordLoginFail(ip);
      logOperation('LOGIN_FAILED', { password: password.substring(0, 4) + '***', ip, userAgent: ua });
      // 增加延迟防止时序攻击
      setTimeout(() => sendJSON(res, 401, { error: '密码错误' }), 500 + Math.random() * 500);
    }
  } catch(e) {
    sendJSON(res, 500, { error: 'Login error' });
  }
}

function handleLogout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  sendJSON(res, 200, { success: true }, {
    'Set-Cookie': buildSessionCookie('', 0, isHttps(req))
  });
}

// ============ Verify Code ============
// Visitor token management (for tracking verified visitors in recentAccess)
const VISITOR_TOKEN_TTL = 8 * 60 * 60 * 1000; // 8h
const visitorTokens = new Map(); // token -> expiresAt

async function handleVerify(req, res) {
  try {
    const { code } = await parseJSONBody(req);
    if (!code) return sendJSON(res, 400, { error: 'code required' });
    if (code === VERIFY_CODE) {
      // Issue visitor token so server can distinguish verified visitors from unauthenticated hits
      const token = crypto.randomBytes(16).toString('hex');
      visitorTokens.set(token, Date.now() + VISITOR_TOKEN_TTL);
      const maxAge = Math.floor(VISITOR_TOKEN_TTL / 1000);
      const secure = isHttps(req);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `anb_visitor=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
      });
      res.end(JSON.stringify({ success: true }));
      return;
    } else {
      sendJSON(res, 401, { error: '验证码错误' });
    }
  } catch(e) {
    sendJSON(res, 500, { error: 'Verify error' });
  }
}

// Clean up expired visitor tokens every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of visitorTokens) {
    if (expires <= now) visitorTokens.delete(token);
  }
}, 30 * 60 * 1000);

async function handleChangePassword(req, res) {
  try {
    const { oldPassword, newPassword, username, action, targetUsername } = await parseJSONBody(req);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';

    // Validate current user is admin
    const currentAdmin = checkAdminPassword(oldPassword);
    if (!currentAdmin) {
      return sendJSON(res, 401, { error: '原密码错误' });
    }

    // Root can manage other admins
    if (currentAdmin.role === 'root') {
      if (action === 'add') {
        if (!username || !newPassword) {
          return sendJSON(res, 400, { error: 'username and newPassword required' });
        }
        if (!isValidPassword(newPassword)) {
          return sendJSON(res, 400, { error: '新密码不符合要求' });
        }
        if (config.admins[username]) {
          return sendJSON(res, 400, { error: '用户名已存在' });
        }
        config.admins[username] = { role: 'admin', hash: hashPassword(newPassword) };
        saveConfig(config);
        logOperation('ADMIN_ADD', { admin: currentAdmin.username, target: username, ip, userAgent: ua });
        return sendJSON(res, 200, { success: true });
      }

      if (action === 'delete') {
        if (!targetUsername) {
          return sendJSON(res, 400, { error: 'targetUsername required' });
        }
        if (targetUsername === currentAdmin.username) {
          return sendJSON(res, 400, { error: '不能删除自己' });
        }
        if (!config.admins[targetUsername]) {
          return sendJSON(res, 404, { error: '用户不存在' });
        }
        delete config.admins[targetUsername];
        invalidateSessionsForUser(targetUsername);
        saveConfig(config);
        logOperation('ADMIN_DELETE', { admin: currentAdmin.username, target: targetUsername, ip, userAgent: ua });
        return sendJSON(res, 200, { success: true });
      }

      if (action === 'list') {
        const admins = Object.entries(config.admins).map(([name, info]) => ({
          username: name,
          role: info.role,
          isSelf: name === currentAdmin.username
        }));
        return sendJSON(res, 200, { admins });
      }
    }

    // Regular password change
    if (!newPassword) {
      return sendJSON(res, 400, { error: 'newPassword required' });
    }
    if (!isValidPassword(newPassword)) {
      return sendJSON(res, 400, { error: '新密码不符合要求' });
    }
    config.admins[currentAdmin.username].hash = hashPassword(newPassword);
    invalidateSessionsForUser(currentAdmin.username, parseCookies(req)[SESSION_COOKIE]);
    saveConfig(config);
    logOperation('PASSWORD_CHANGE', { admin: currentAdmin.username, ip, userAgent: ua });
    sendJSON(res, 200, { success: true });
  } catch(e) {
    sendJSON(res, 500, { error: 'Password change error: ' + e.message });
  }
}

// ============ HTTP Handlers ============
function sendJSON(res, status, data, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': extraHeaders['Set-Cookie'] ? '' : '*',
    ...extraHeaders
  };
  if (!headers['Access-Control-Allow-Origin']) delete headers['Access-Control-Allow-Origin'];
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    const maxBodySize = config.limits?.maxBodySize || 2 * 1024 * 1024;
    let body = '';
    let totalSize = 0;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > maxBodySize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// 将cloud://格式的fileID转换为临时签名URL
async function convertCloudURLs(notices) {
  // 检查是否在CloudBase环境
  const isCloudBase = !!(process.env.TCB_ENV_ID || process.env.TENCENTCLOUD_RUNENV);
  if (!isCloudBase) return notices;

  // 收集所有需要转换的cloud:// URL
  const fileIDList = [];
  const fileIDMap = new Map(); // fileID -> 原始字段路径

  notices.forEach((notice, noticeIdx) => {
    // 处理附件（兼容cloud://和fileID两种格式）
    if (notice.attachments) {
      notice.attachments.forEach((att, attIdx) => {
        if (att.fileID) {
          fileIDList.push(att.fileID);
          fileIDMap.set(att.fileID, { type: 'attachment', noticeIdx, attIdx });
        } else if (att.url && att.url.startsWith('cloud://')) {
          fileIDList.push(att.url);
          fileIDMap.set(att.url, { type: 'attachment', noticeIdx, attIdx });
        }
      });
    }
    // 处理正文中的图片链接
    if (notice.links) {
      notice.links.forEach((link, linkIdx) => {
        if (link && link.startsWith && link.startsWith('cloud://')) {
          fileIDList.push(link);
          fileIDMap.set(link, { type: 'link', noticeIdx, linkIdx });
        }
      });
    }
  });

  if (fileIDList.length === 0) return notices;

  // 批量获取临时URL（最多50个）
  try {
    const cloudbaseOptions = {
      envId: process.env.TCB_ENV_ID || process.env.NEXT_PUBLIC_TCB_ENV_ID,
    };
    const _secretId = process.env.TENCENTCLOUD_SECRETID || process.env.COS_SECRET_ID;
    const _secretKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.COS_SECRET_KEY;
    if (_secretId) cloudbaseOptions.secretId = _secretId;
    if (_secretKey) cloudbaseOptions.secretKey = _secretKey;
    if (process.env.TENCENTCLOUD_SESSIONTOKEN) {
      cloudbaseOptions.sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN;
    }
    const cloudbase = new (require('@cloudbase/node-sdk'))(cloudbaseOptions);

    const urlResult = await cloudbase.storage().getTempFileURL({ fileList: fileIDList });
    if (urlResult.fileList) {
      urlResult.fileList.forEach((item, idx) => {
        if (item.tempFileURL) {
          const mapping = fileIDMap.get(fileIDList[idx]);
          if (mapping) {
            if (mapping.type === 'attachment') {
              notices[mapping.noticeIdx].attachments[mapping.attIdx].url = item.tempFileURL;
            } else if (mapping.type === 'link') {
              notices[mapping.noticeIdx].links[mapping.linkIdx] = item.tempFileURL;
            }
          }
        }
      });
    }
  } catch (e) {
    console.error('[Server] Failed to convert cloud URLs:', e.message);
  }

  return notices;
}

async function handleGET(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let notices = readNotices();

  const type = url.searchParams.get('type');
  const expired = url.searchParams.get('expired');
  const search = url.searchParams.get('search');
  const defaultLimit = config.limits?.pageLimit || 30;
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || defaultLimit);

  if (type && type !== 'all') {
    notices = notices.filter(n => n.type === type);
  }
  if (expired === 'true') notices = notices.filter(n => n.expired);
  else if (expired === 'false') notices = notices.filter(n => !n.expired);
  if (search) {
    const kw = search.toLowerCase();
    notices = notices.filter(n =>
      n.title.toLowerCase().includes(kw) ||
      n.body.toLowerCase().includes(kw) ||
      n.owner.toLowerCase().includes(kw)
    );
  }

  // Sort: default publishDate desc, or by query param
  const sortBy = url.searchParams.get('sort') || 'publishDate';
  notices.sort((a, b) => {
    if (sortBy === 'publishDate' || sortBy === 'date') {
      if (!a.publishDate) return 1;
      if (!b.publishDate) return -1;
      return new Date(b.publishDate) - new Date(a.publishDate); // newest first
    }
    if (sortBy === 'deadline') {
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    }
    if (sortBy === 'importance') {
      if (a.importance !== b.importance) return b.importance - a.importance;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    }
    // type sort
    if (!a.type) return 1;
    if (!b.type) return -1;
    return a.type.localeCompare(b.type);
  });

  const total = notices.length;
  const totalPages = Math.ceil(total / limit);
  const startIndex = (page - 1) * limit;
  let paginatedNotices = notices.slice(startIndex, startIndex + limit);

  // 将cloud:// URL转换为临时签名URL
  paginatedNotices = await convertCloudURLs(paginatedNotices);

  sendJSON(res, 200, {
    notices: paginatedNotices,
    pagination: { page, limit, total, totalPages, hasMore: page < totalPages }
  });
}

// Simple multipart parser
function parseMultipart(buffer, boundary) {
  const parts = [];
  // Build boundary with proper format
  const boundaryBuffer = Buffer.from('--' + boundary);
  const endBoundaryBuffer = Buffer.from('--' + boundary + '--');

  let idx = 0;

  while (idx < buffer.length) {
    // Find next boundary
    const bIdx = buffer.indexOf(boundaryBuffer, idx);
    if (bIdx === -1) break;

    // Check if this is the end boundary
    const isEndBoundary = buffer.slice(bIdx, bIdx + endBoundaryBuffer.length).equals(endBoundaryBuffer);

    // Find end of this section (next boundary or end boundary)
    const searchStart = bIdx + boundaryBuffer.length + 2; // +2 for \r\n after boundary
    let endIdx;
    if (isEndBoundary) {
      endIdx = buffer.indexOf(Buffer.from('\r\n'), searchStart);
      if (endIdx === -1) endIdx = buffer.length;
    } else {
      endIdx = buffer.indexOf(boundaryBuffer, searchStart);
      if (endIdx === -1) break;
    }

    // Extract headers and content between boundaries
    const section = buffer.slice(bIdx, endIdx);
    const headerEndIdx = section.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEndIdx === -1) {
      idx = endIdx;
      continue;
    }

    const headerRaw = section.slice(0, headerEndIdx).toString();
    const content = section.slice(headerEndIdx + 4, section.length - 2); // -2 to remove trailing \r\n

    // Parse Content-Disposition
    const nameMatch = headerRaw.match(/name="([^"]+)"/);
    const filenameMatch = headerRaw.match(/filename="([^"]+)"/);

    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        content: filenameMatch ? content : content.toString(),
        isFile: !!filenameMatch,
      });
    }

    idx = endIdx;
  }
  return parts;
}

function handlePOST(req, res) {
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return sendJSON(res, 400, { error: 'missing boundary' });

    const maxFileSize = (config.limits?.maxFileSize) || 20 * 1024 * 1024;

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = parseMultipart(buffer, boundary);

        let text = '';
        const attachments = [];

        for (const part of parts) {
          if (part.name === 'text') {
            text = part.content;
          } else if (part.name === 'attachments' && part.isFile) {
            if (part.content.length > maxFileSize) {
              return sendJSON(res, 400, { error: 'Attachment too large (max 5MB)' });
            }
            const result = await storage.uploadAttachment(part.content, part.filename);
            // Store both original name (for display) and saved name (for URL)
            const att = { name: part.filename, savedName: result.name, url: result.url, size: result.size };
            if (result.fileID) att.fileID = result.fileID;
            attachments.push(att);
          }
        }
        console.log('[DEBUG] Final attachments array:', attachments);

        if (!text) return sendJSON(res, 400, { error: 'text required' });
        const parserConfig = config.parser;
        const useLLM = parserConfig.enabled && parserConfig.useOnSubmit;
        const newNotices = await dispatchParse(text, useLLM ? parserConfig : null);

        // Attach files to first notice (or all if needed)
        if (attachments.length > 0 && newNotices.length > 0) {
          newNotices[0].attachments = attachments;
        }

        await modifyNotices(existing => [...existing, ...newNotices]);
        sendJSON(res, 200, { success: true, count: newNotices.length, notices: newNotices });
      } catch(e) {
        console.error('Upload error:', e.message);
        sendJSON(res, 500, { error: 'Upload error: ' + e.message });
      }
    });
  } else {
    // JSON body
    parseJSONBody(req).then(async (parsed) => {
      try {
        const text = parsed.text;
        if (!text) return sendJSON(res, 400, { error: 'text required' });
        const parserConfig = config.parser;
        const useLLM = parserConfig.enabled && parserConfig.useOnSubmit;
        const newNotices = await dispatchParse(text, useLLM ? parserConfig : null);
        await modifyNotices(existing => [...existing, ...newNotices]);
        sendJSON(res, 200, { success: true, count: newNotices.length, notices: newNotices });
      } catch(e) {
        console.error('POST error:', e.message);
        sendJSON(res, 500, { error: 'Parse error: ' + e.message });
      }
    }).catch(e => sendJSON(res, 500, { error: 'Parse error: ' + e.message }));
  }
}

function handleImageUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return sendJSON(res, 400, { error: 'multipart required' });
  }

  const boundary = contentType.split('boundary=')[1];
  if (!boundary) return sendJSON(res, 400, { error: 'missing boundary' });

  const maxFileSize = (config.limits?.maxFileSize) || 5 * 1024 * 1024;
  const maxBodySize = config.limits?.maxBodySize || 2 * 1024 * 1024;

  const chunks = [];
  let totalSize = 0;
  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize > maxBodySize) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const parts = parseMultipart(buffer, boundary);

      for (const part of parts) {
        if (part.name === 'image' && part.isFile) {
          if (part.content.length > maxFileSize) {
            return sendJSON(res, 400, { error: 'File too large (max 5MB)' });
          }
          const ext = path.extname(part.filename || '.png').toLowerCase();
          const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', 'bmp'];
          if (!allowedExts.includes(ext)) {
            return sendJSON(res, 400, { error: 'Only image files allowed' });
          }

          const result = await storage.uploadImage(part.content, part.filename || 'image.png');
          return sendJSON(res, 200, { url: result.url, name: result.name });
        }
      }
      return sendJSON(res, 400, { error: 'no image found' });
    } catch(e) {
      sendJSON(res, 500, { error: 'Upload error: ' + e.message });
    }
  });
}

async function handleAddDirect(req, res) {
  // Add a pre-parsed notice directly (from edited preview)
  try {
    const notice = await parseJSONBody(req);
      if (!notice.title) return sendJSON(res, 400, { error: 'title required' });

      // Attach files if provided
      const attachments = notice._attachments || [];
      delete notice._attachments;

      if (attachments.length > 0) {
        notice.attachments = attachments;
      }
      notice.id = `n-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      notice.expired = notice.deadline ? new Date(notice.deadline) < new Date() : false;
      await modifyNotices(existing => { existing.push(notice); return existing; });
      sendJSON(res, 200, { success: true, notice });
    } catch(e) {
      sendJSON(res, 500, { error: 'Add error: ' + e.message });
    }
}

// Webhook receiver: auto-import notice from forwarded text
async function handleWebhook(req, res) {
  try {
    const { text, secret } = await parseJSONBody(req);
    if (!text) return sendJSON(res, 400, { error: 'text required' });

      // Verify webhook secret
      const cfg = loadConfig();
      if (!cfg.webhookSecret) {
        return sendJSON(res, 403, { error: 'Webhook未启用' });
      }
      if (secret !== cfg.webhookSecret) {
        return sendJSON(res, 401, { error: 'Invalid secret' });
      }

      const parserConfig = config.parser;
      const useLLM = parserConfig.enabled && parserConfig.useOnSubmit;
      const notices = await dispatchParse(text, useLLM ? parserConfig : null);
      const now = new Date();
      for (const n of notices) {
        n.id = `n-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        n.expired = n.deadline ? new Date(n.deadline) < now : false;
      }
      await modifyNotices(existing => { existing.push(...notices); return existing; });
      sendJSON(res, 200, { success: true, count: notices.length, notices });
    } catch(e) {
      sendJSON(res, 500, { error: 'Webhook error: ' + e.message });
    }
}

function getParseDiagnostics(notice) {
  const diag = { confidence: 'high', warnings: [] };

  // Category confidence
  if (notice.type === '其他') {
    diag.confidence = 'low';
    diag.warnings.push('未能自动识别分类，已归为"其他"');
  }

  // Importance confidence
  if (notice.importance === 1 && !/(了解|参考|可知|可查)/.test(notice.body)) {
    diag.warnings.push('未检测到重要性关键词，默认设为低重要度');
  }

  // Owner confidence
  if (notice.owner === '未指定') {
    diag.warnings.push('未提取到联系人信息');
  } else if (/^(邮箱|电话)/.test(notice.owner)) {
    diag.warnings.push(`联系人仅提取到${notice.owner.substring(0,2)}，可能缺少姓名`);
  }

  // Deadline confidence
  if (!notice.deadline) {
    diag.warnings.push('未提取到截止日期');
  } else {
    const ddl = new Date(notice.deadline);
    const daysUntil = Math.ceil((ddl - new Date()) / 86400000);
    if (daysUntil > 180) diag.warnings.push('截止日期距今超过半年，请确认');
    if (daysUntil < -30) diag.warnings.push('截止日期已过期超一个月，请确认');
  }

  if (diag.confidence === 'low' || diag.warnings.length >= 2) {
    diag.confidence = 'low';
  } else if (diag.warnings.length >= 1) {
    diag.confidence = 'medium';
  }

  return diag;
}

async function handlePreview(req, res) {
  try {
    const parsed = await parseJSONBody(req);
    const text = parsed.text;
    if (!text) return sendJSON(res, 400, { error: 'text required' });
    const notices = parseRawInput(text).map(n => ({
      ...n,
      _diagnostics: getParseDiagnostics(n)
    }));
    sendJSON(res, 200, { notices });
  } catch(e) {
    sendJSON(res, 500, { error: 'Parse error: ' + e.message });
  }
}

// LLM parse endpoint (manual trigger)
async function handleParseLLM(req, res) {
  try {
    const parsed = await parseJSONBody(req);
    const text = parsed.text;
    if (!text) return sendJSON(res, 400, { error: 'text required' });
    const parserConfig = config.parser;
    if (!parserConfig.enabled || !parserConfig.apiKey) {
      return sendJSON(res, 400, { error: 'AI解析未配置，请在管理面板中设置API Key并启用' });
    }
    let notices = await dispatchParse(text, parserConfig);
    // Step 2: Body enhancement if configured
    if (parserConfig.bodyEnhancePrompt && notices.length > 0) {
      const llmParser = require('./lib/llm-parser');
      for (const n of notices) {
        if (n.body) n.body = await llmParser.enhanceBody(n.body, parserConfig);
      }
    }
    const enriched = notices.map(n => ({
      ...n,
      _diagnostics: getParseDiagnostics(n),
      _source: 'llm'
    }));
    sendJSON(res, 200, { notices: enriched });
  } catch(e) {
    sendJSON(res, 500, { error: 'AI解析失败: ' + e.message });
  }
}

// Parser config management
async function handleParserConfig(req, res) {
  if (req.method === 'GET') {
    // Return config with apiKey redacted
    const safe = { ...config.parser };
    if (safe.apiKey) safe.apiKey = '***';
    sendJSON(res, 200, { parser: safe });
    return;
  }

  if (req.method === 'POST') {
    try {
      const { oldPassword, parser } = await parseJSONBody(req);
      const admin = checkAdminPassword(oldPassword);
      if (!admin || admin.role !== 'root') {
        return sendJSON(res, 401, { error: '需要超级管理员密码' });
      }

      const valid = {};
      if (typeof parser.enabled === 'boolean') valid.enabled = parser.enabled;
      if (typeof parser.useOnSubmit === 'boolean') valid.useOnSubmit = parser.useOnSubmit;
      if (parser.provider && ['minimax','openrouter','deepseek','openai','anthropic'].includes(parser.provider)) {
        valid.provider = parser.provider;
      }
      if (typeof parser.apiKey === 'string' && parser.apiKey !== '***') valid.apiKey = parser.apiKey;
      if (typeof parser.apiUrl === 'string') valid.apiUrl = parser.apiUrl;
      if (typeof parser.model === 'string') valid.model = parser.model;
      if (typeof parser.systemPrompt === 'string') valid.systemPrompt = parser.systemPrompt;
      if (typeof parser.userPromptTemplate === 'string') valid.userPromptTemplate = parser.userPromptTemplate;
      if (typeof parser.bodyEnhancePrompt === 'string') valid.bodyEnhancePrompt = parser.bodyEnhancePrompt;
      if (parser.timeout) valid.timeout = Math.min(Math.max(10000, parseInt(parser.timeout)), 60000);

      config.parser = { ...config.parser, ...valid };
      saveConfig(config);

      logOperation('PARSER_CONFIG', { admin: admin.username, changes: Object.keys(valid) });
      sendJSON(res, 200, { success: true, parser: config.parser });
    } catch(e) {
      sendJSON(res, 500, { error: '保存失败: ' + e.message });
    }
    return;
  }

  sendJSON(res, 405, { error: 'Method not allowed' });
}

// IP geolocation cache (in-memory, cleared on restart)
const _ipLocationCache = new Map();

function lookupIPLocation(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return Promise.resolve('内网');
  }
  if (_ipLocationCache.has(ip)) {
    return Promise.resolve(_ipLocationCache.get(ip));
  }
  return new Promise((resolve) => {
    const req = http.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=city,regionName,country`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          if (obj.city) {
            const loc = obj.city === obj.regionName ? obj.city : `${obj.city || ''} ${obj.regionName || ''}`.trim();
            _ipLocationCache.set(ip, loc || '未知');
            resolve(loc || '未知');
          } else {
            _ipLocationCache.set(ip, '未知');
            resolve('未知');
          }
        } catch { _ipLocationCache.set(ip, '未知'); resolve('未知'); }
      });
    });
    req.on('error', () => resolve('未知'));
    req.setTimeout(3000, () => { req.destroy(); resolve('未知'); });
  });
}

async function enrichRecentAccess(recent) {
  // Run all IP lookups in parallel with a 2s individual timeout to avoid blocking
  const items = recent.slice(0, 20).map(r => ({
    time: r.time,
    ip: r.ip,
    ua: r.ua,
    auth: r.auth || 'visitor',
  }));
  const locations = await Promise.all(items.map(r =>
    Promise.race([
      lookupIPLocation(r.ip),
      new Promise(resolve => setTimeout(() => resolve('超时'), 2000))
    ])
  ));
  return items.map((r, i) => ({ ...r, location: locations[i] }));
}

// Visit statistics (for admin)
async function handleVisitStats(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    const daily = config.dailyVisits || {};
    const recent = config.recentAccess || [];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().substring(0, 10);
      days.push({ date: key, count: daily[key] || 0 });
    }
    const todayKey = new Date().toISOString().substring(0, 10);
    const todayVisits = daily[todayKey] || 0;
    const thisWeekVisits = days.reduce((s, d) => s + d.count, 0);
    const enriched = await enrichRecentAccess(recent);
    // Aggregate top cities from recent access
    const cityCounts = {};
    for (const r of enriched) {
      const loc = r.location || '未知';
      if (loc === '内网') continue;
      cityCounts[loc] = (cityCounts[loc] || 0) + 1;
    }
    const topCities = Object.entries(cityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([city, count]) => ({ city, count }));
    sendJSON(res, 200, {
      totalVisits: config.visits,
      todayVisits,
      thisWeekVisits,
      dailyVisits: days,
      recentAccess: enriched,
      topCities
    });
  } catch(e) {
    console.error('[VisitStats] Error:', e.message);
    sendJSON(res, 200, { totalVisits: config.visits, todayVisits: 0, thisWeekVisits: 0, dailyVisits: [], recentAccess: [] });
  }
}

// Logs viewer (for root)
function handleLogs(req, res) {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return sendJSON(res, 200, { logs: [] });
    }
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(l => l);
    // Return last 100 entries, newest first
    const logs = lines.slice(-100).reverse();
    sendJSON(res, 200, { logs });
  } catch(e) {
    sendJSON(res, 200, { logs: [], error: e.message });
  }
}

// System limits config (for root)
async function handleLimits(req, res) {
  if (req.method === 'GET') {
    sendJSON(res, 200, { limits: config.limits });
    return;
  }

  try {
    const { oldPassword, limits } = await parseJSONBody(req);
    const admin = checkAdminPassword(oldPassword);
    if (!admin || admin.role !== 'root') {
      return sendJSON(res, 401, { error: '需要超级管理员密码' });
    }

    const validLimits = {};
    if (limits.maxBodySize) validLimits.maxBodySize = Math.min(Math.max(1024, parseInt(limits.maxBodySize)), 10 * 1024 * 1024);
    if (limits.maxFileSize) validLimits.maxFileSize = Math.min(Math.max(1024, parseInt(limits.maxFileSize)), 50 * 1024 * 1024);
    if (limits.requestTimeout) validLimits.requestTimeout = Math.min(Math.max(5000, parseInt(limits.requestTimeout)), 120000);
    if (limits.maxLogSize) validLimits.maxLogSize = Math.min(Math.max(1024 * 1024, parseInt(limits.maxLogSize)), 100 * 1024 * 1024);
    if (limits.pageLimit) validLimits.pageLimit = Math.min(Math.max(10, parseInt(limits.pageLimit)), 100);

    config.limits = { ...config.limits, ...validLimits };
    saveConfig(config);

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    logOperation('LIMITS_UPDATE', { admin: admin.username, ip, limits: config.limits });

    sendJSON(res, 200, { success: true, limits: config.limits });
  } catch(e) {
    sendJSON(res, 500, { error: 'Update error: ' + e.message });
  }
}

// ============ Backup Version Management (DISABLED) ============

// GitHub备份已禁用 - 数据存储在腾讯云COS
// ============ Local Snapshot Backup System ============

function createSnapshotBackup() {
  const notices = readNotices();
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  // Don't back up sensitive fields
  delete cfg.parser?.apiKey;
  delete cfg.webhookSecret;

  const snapshot = {
    timestamp: new Date().toISOString(),
    notices,
    config: cfg,
  };

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const filename = `backup-${ts}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`[Backup] Snapshot created: ${filename} (${notices.length} notices)`);

  // Prune old backups: keep max 30 most recent
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort();
    while (files.length > 30) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[0]));
      files.shift();
    }
  } catch(e) { console.warn('[Backup] Prune failed:', e.message); }

  return filename;
}

function getBackupList() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .reverse();

    return files.map(f => {
      const filepath = path.join(BACKUP_DIR, f);
      try {
        const stat = fs.statSync(filepath);
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        return {
          filename: f,
          timestamp: data.timestamp || f.replace('backup-', '').replace('.json', ''),
          noticeCount: Array.isArray(data.notices) ? data.notices.length : 0,
          hasConfig: !!(data.config && data.config.admins),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch(e) {
    console.warn('[Backup] List failed:', e.message);
    return [];
  }
}

function restoreFromSnapshot(filename) {
  // Prevent path traversal
  const safe = path.basename(filename);
  if (!safe.startsWith('backup-') || !safe.endsWith('.json')) {
    throw new Error('Invalid backup filename');
  }
  const filepath = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(filepath)) {
    throw new Error('Backup not found');
  }

  const snapshot = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  if (!Array.isArray(snapshot.notices)) {
    throw new Error('Backup data corrupted: missing notices array');
  }

  // Restore notices
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot.notices, null, 2), 'utf-8');

  // Restore config (merge: keep current admins + restore other config fields)
  if (snapshot.config && typeof snapshot.config === 'object') {
    const currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    // Keep current secrets (API keys, webhook secrets)
    const preserved = {};
    if (currentConfig.parser?.apiKey) preserved.parserApiKey = currentConfig.parser.apiKey;
    if (currentConfig.webhookSecret) preserved.webhookSecret = currentConfig.webhookSecret;
    if (currentConfig.admins) preserved.admins = currentConfig.admins; // keep current admins

    const restored = { ...snapshot.config, ...preserved };
    // Ensure admins from restore don't overwrite current
    restored.admins = preserved.admins || snapshot.config.admins;

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(restored, null, 2), 'utf-8');
  }

  logOperation('RESTORE', { filename, notices: snapshot.notices.length });
  console.log(`[Backup] Restored from ${filename}: ${snapshot.notices.length} notices`);
  return { noticeCount: snapshot.notices.length };
}

// Auto-backup every 24 hours
setInterval(() => {
  try { createSnapshotBackup(); }
  catch(e) { console.warn('[Backup] Auto-backup failed:', e.message); }
}, 24 * 60 * 60 * 1000);

// Create initial backup if no backups exist
try {
  const existing = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup-'));
  if (existing.length === 0) {
    setTimeout(() => {
      try { createSnapshotBackup(); }
      catch(e) {}
    }, 5000); // wait for server to settle
  }
} catch(e) {}

async function handleBackupVersions(req, res) {
  const list = getBackupList();
  sendJSON(res, 200, { versions: list });
}

async function handleBackupRestore(req, res) {
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await parseJSONBody(req);
    const { filename } = body;
    if (!filename) {
      return sendJSON(res, 400, { error: 'Missing backup filename' });
    }

    const result = restoreFromSnapshot(filename);
    sendJSON(res, 200, { success: true, ...result });
  } catch(e) {
    sendJSON(res, 500, { error: '恢复失败: ' + e.message });
  }
}

// Webhook config: get/set webhook secret
function handleWebhookConfig(req, res) {
  if (req.method === 'GET') {
    // Return webhook URL (without secret for security)
    const baseUrl = `http://localhost:${PORT}`;
    sendJSON(res, 200, {
      webhookUrl: `/api/webhook/receive`,
      hasSecret: !!config.webhookSecret,
    });
    return;
  }

  // POST: generate new secret
  parseJSONBody(req).then(({ action }) => {
    if (action === 'generate') {
      config.webhookSecret = crypto.randomBytes(16).toString('hex');
      saveConfig(config);
      sendJSON(res, 200, { success: true, webhookSecret: config.webhookSecret });
    } else if (action === 'disable') {
      delete config.webhookSecret;
      saveConfig(config);
      sendJSON(res, 200, { success: true });
    } else {
      sendJSON(res, 400, { error: 'Invalid action' });
    }
  }).catch(e => sendJSON(res, 500, { error: 'Error: ' + e.message }));
}

// Fetch latest commit info from GitHub
const GITHUB_REPO = 'ZolaNUAA/academy-notice-board';
let cachedVersion = null;

function getCloudbaseHost() {
  // Detect if running on Tencent Cloudbase
  const host = process.env.TCB_REGION || '';
  if (host.includes('gz')) return 'gz.tencentcloudapi.com';
  if (host.includes('bj')) return 'bj.tencentcloudapi.com';
  return 'ap-guangzhou.tencentcloudapi.com';
}

function getGitShortHash() {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8' }).trim();
  } catch { return 'local'; }
}

function getGitCommitDate() {
  try {
    const d = require('child_process').execSync('git log -1 --format=%ci', { cwd: __dirname, encoding: 'utf-8' }).trim();
    return new Date(d).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});
  } catch { return null; }
}

function fetchLatestCommit() {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token || cachedVersion) return;

  const https = require('https');
  const url = new URL(`https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=1`);

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'GET',
    headers: {
      'User-Agent': 'AcademyNoticeBoard/1.0',
      'Authorization': `token ${token}`,
      'Accept': 'application/json'
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const commits = JSON.parse(data);
        if (commits && commits[0]) {
          cachedVersion = {
            version: commits[0].sha.substring(0, 7),
            date: commits[0].commit.author.date
          };
        }
      } catch(e) { console.error('GitHub API error:', e.message); }
    });
  });
  req.on('error', () => {});
  req.end();
}

// Start fetching in background (non-blocking)
setTimeout(fetchLatestCommit, 100);

function handleStats(req, res) {
  // Always increment visit counters (aggregate stats)
  config.visits++;
  config.lastVisit = new Date().toISOString();
  const todayKey = new Date().toISOString().substring(0, 10);
  if (!config.dailyVisits) config.dailyVisits = {};
  config.dailyVisits[todayKey] = (config.dailyVisits[todayKey] || 0) + 1;

  // Only record in recentAccess if authenticated (admin session or visitor token)
  let auth = null;
  const admin = getSessionAdmin(req);
  if (admin) {
    auth = admin.role === 'root' ? 'root' : 'admin';
  } else {
    // Check visitor token
    const cookies = parseCookies(req);
    const visitorToken = cookies['anb_visitor'];
    if (visitorToken && visitorTokens.has(visitorToken)) {
      if (visitorTokens.get(visitorToken) > Date.now()) {
        auth = 'visitor';
      } else {
        visitorTokens.delete(visitorToken);
      }
    }
  }

  if (auth) {
    if (!config.recentAccess) config.recentAccess = [];
    config.recentAccess.unshift({
      time: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
      ua: (req.headers['user-agent'] || '').substring(0, 120),
      auth
    });
    if (config.recentAccess.length > 60) config.recentAccess.length = 60;
  }
  saveConfig(config);

  const notices = readNotices();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = notices.filter(n => {
    if (!n.publishDate) return false;
    const d = new Date(n.publishDate);
    return d >= today;
  }).length;

  // Per-type counts for filter labels
  const typeCounts = {};
  const ALL_TYPES = ['科研','教学','研究生','学工','党务','人事','保密','国资','安全','国合','全院','其他'];
  // Active and expired type counts
  const activeTypeCounts = {}; for (const t of ALL_TYPES) activeTypeCounts[t] = 0;
  const expiredTypeCounts = {}; for (const t of ALL_TYPES) expiredTypeCounts[t] = 0;
  for (const n of notices) {
    if (n.expired && expiredTypeCounts[n.type] !== undefined) expiredTypeCounts[n.type]++;
    else if (!n.expired && activeTypeCounts[n.type] !== undefined) activeTypeCounts[n.type]++;
  }
  // Keep typeCounts for backward compat (all notices)
  for (const t of ALL_TYPES) typeCounts[t] = activeTypeCounts[t] + expiredTypeCounts[t];

  const activeNotices = notices.filter(n => !n.expired).length;
  const expiredNotices = notices.filter(n => n.expired).length;
  sendJSON(res, 200, {
    totalVisits: config.visits,
    lastVisit: config.lastVisit,
    todayNotices: todayCount,
    totalNotices: notices.length,
    activeNotices,
    expiredNotices,
    typeCounts,
    activeTypeCounts,
    expiredTypeCounts,
    version: cachedVersion ? cachedVersion.version : (process.env.DEPLOY_VERSION || getGitShortHash()),
    versionDate: cachedVersion ? cachedVersion.date : (process.env.DEPLOY_DATE || getGitCommitDate() || SERVER_START_TIME),
    indexHtmlTime: (() => {
      try {
        const stat = fs.statSync(path.join(__dirname, 'index.html'));
        return stat.mtime.toISOString();
      } catch { return null; }
    })()
  });
}

// Generate .ics calendar file for a notice deadline
function handleCalendarDownload(req, res, id) {
  const notices = readNotices();
  const notice = notices.find(n => n.id === id);
  if (!notice || !notice.deadline) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Notice not found or has no deadline');
    return;
  }
  const pad = n => String(n).padStart(2, '0');
  const dateMatch = String(notice.deadline).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid deadline date');
    return;
  }

  const dtStart = `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`;
  // End date is the next day (exclusive)
  const deadline = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
  const nextDay = new Date(deadline);
  nextDay.setDate(nextDay.getDate() + 1);
  const dtEnd = `${nextDay.getFullYear()}${pad(nextDay.getMonth()+1)}${pad(nextDay.getDate())}`;

  // iCalendar text value escape
  const escICal = s => String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

  // Clean body: strip HTML, entities, markdown. Keep it short to avoid line-length issues.
  const cleanBody = (notice.body || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/&#\d+;/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);

  const now = new Date().toISOString().replace(/[-:]/g, '').substring(0, 15) + 'Z';
  const title = notice.title || '';
  const description = escICal(cleanBody);

  // Build ICS — minimal, no line folding (modern clients handle longer lines fine)
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Academy Notice Board//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${notice.id}@nuaa-notice`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escICal(title)}`,
    description ? `DESCRIPTION:${description}` : null,
    'BEGIN:VALARM',
    'TRIGGER:-PT12H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escICal(title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n') + '\r\n';

  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="notice.ics"'
  });
  res.end(ics);
}

// Calendar feed: returns .ics with all active notices that have deadlines
// Phone can subscribe to this URL for auto-updating calendar
function handleCalendarFeed(req, res) {
  const notices = readNotices();
  const active = notices.filter(n => n.deadline && !n.expired);
  const now = new Date().toISOString().replace(/[-:]/g, '').substring(0, 15) + 'Z';
  const escICal = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n').substring(0, 300);

  const events = active.map(n => {
    const m = String(n.deadline).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const pad = s => String(s).padStart(2, '0');
    const dStart = `${m[1]}${m[2]}${m[3]}`;
    const dl = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    dl.setDate(dl.getDate() + 1);
    const dEnd = `${dl.getFullYear()}${pad(dl.getMonth()+1)}${pad(dl.getDate())}`;
    return [
      'BEGIN:VEVENT',
      `UID:${escICal(n.id)}@nuaa-feed`,
      `DTSTART;VALUE=DATE:${dStart}`,
      `DTEND;VALUE=DATE:${dEnd}`,
      `DTSTAMP:${now}`,
      `SUMMARY:${escICal(n.title)}`,
      `DESCRIPTION:${escICal((n.body || '').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().substring(0,200))}`,
      'BEGIN:VALARM',
      'TRIGGER:-PT12H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escICal(n.title)}`,
      'END:VALARM',
      'END:VEVENT'
    ].join('\r\n');
  }).filter(Boolean).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Academy Notice Board//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:学院通知截止提醒',
    'X-WR-CALDESC:学院通知便利贴看板 — 截止日期提醒',
    `REFRESH-INTERVAL;VALUE=DURATION:PT12H`,
    events,
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n') + '\r\n';

  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
  });
  res.end(ics);
}

function handleDELETE(req, res, id) {
  let deleted = false;
  modifyNotices(notices => {
    const filtered = notices.filter(n => n.id !== id);
    if (filtered.length < notices.length) deleted = true;
    return filtered;
  }).then(() => {
    if (!deleted) return sendJSON(res, 404, { error: 'Not found' });
    sendJSON(res, 200, { success: true });
  }).catch(e => sendJSON(res, 500, { error: 'Delete error' }));
}

function handlePATCH(req, res, id) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const updates = JSON.parse(body);
      let updated = null;
      let notFound = false;
      modifyNotices(notices => {
        const idx = notices.findIndex(n => n.id === id);
        if (idx === -1) { notFound = true; return notices; }
        if (updates.deadline !== undefined) {
          updates.expired = updates.deadline ? new Date(updates.deadline) < new Date() : false;
        }
        notices[idx] = { ...notices[idx], ...updates };
        updated = notices[idx];
        return notices;
      }).then(() => {
        if (notFound) return sendJSON(res, 404, { error: 'Not found' });
        sendJSON(res, 200, updated);
      }).catch(e => sendJSON(res, 500, { error: 'Update error' }));
    } catch(e) {
      sendJSON(res, 500, { error: 'Update error' });
    }
  });
}

// ============ Static File Server ============
function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
  };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
}

// ============ Router ============
const server = http.createServer((req, res) => {
  const limits = config.limits || {};
  const maxBodySize = limits.maxBodySize || 2 * 1024 * 1024;
  const requestTimeout = limits.requestTimeout || 30000;

  // Set server timeout for slow-loris protection
  req.socket.setTimeout(requestTimeout);
  res.socket.setTimeout(requestTimeout);

  // Limit request body size
  let contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > maxBodySize) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large (max 2MB)' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Calendar feed: URL subscription for phone calendar (all active deadlines)
  if (url.pathname === '/api/calendar-feed.ics') {
    if (req.method === 'GET') return handleCalendarFeed(req, res);
  }

  // Calendar download (add to phone calendar)
  if (url.pathname.startsWith('/api/calendar/')) {
    const id = url.pathname.split('/').pop();
    if (req.method === 'GET') return handleCalendarDownload(req, res, id);
  }

  // API routes
  if (url.pathname.startsWith('/api/notices/')) {
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      return handleDELETE(req, res, id);
    }
    if (req.method === 'PATCH') {
      if (!requireAdmin(req, res)) return;
      return handlePATCH(req, res, id);
    }
  }

  // Direct add a pre-parsed notice (from edited preview)
  if (url.pathname === '/api/notice') {
    if (req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      return handleAddDirect(req, res);
    }
  }

  // Image upload
  if (url.pathname === '/api/image') {
    if (req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      return handleImageUpload(req, res);
    }
  }

  // Webhook receiver for auto-import
  if (url.pathname === '/api/webhook/receive') {
    if (req.method === 'POST') return handleWebhook(req, res);
  }

  if (url.pathname === '/api/notices') {
    if (req.method === 'GET') return handleGET(req, res);
    if (req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      return handlePOST(req, res);
    }
  }

// Login: verify password
  if (url.pathname === '/api/login') {
    if (req.method === 'POST') return handleLogin(req, res);
  }

  if (url.pathname === '/api/logout') {
    if (req.method === 'POST') return handleLogout(req, res);
  }

// Verify access code
  if (url.pathname === '/api/verify') {
    if (req.method === 'POST') return handleVerify(req, res);
  }

  // Change password
  if (url.pathname === '/api/password') {
    if (req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      return handleChangePassword(req, res);
    }
  }

  // Preview: parse text without saving
  if (url.pathname === '/api/preview') {
    if (req.method === 'POST') return handlePreview(req, res);
  }

  // LLM parse endpoint (manual AI trigger)
  if (url.pathname === '/api/parse/llm') {
    if (req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      return handleParseLLM(req, res);
    }
  }

  // Parser config management
  if (url.pathname === '/api/parser-config') {
    if (!requireRoot(req, res)) return;
    return handleParserConfig(req, res);
  }

  // Stats: visit counter and notice stats
  if (url.pathname === '/api/stats') {
    if (req.method === 'GET') return handleStats(req, res);
  }

  // Visit stats: access analytics (admin)
  if (url.pathname === '/api/visit-stats') {
    if (req.method === 'GET') return handleVisitStats(req, res);
  }

  // Logs: get operation logs (root only)
  if (url.pathname === '/api/logs') {
    if (req.method === 'GET') {
      if (!requireRoot(req, res)) return;
      return handleLogs(req, res);
    }
  }

  // Webhook config
  if (url.pathname === '/api/webhook/config') {
    if (!requireRoot(req, res)) return;
    return handleWebhookConfig(req, res);
  }

  // System limits config (root only)
  if (url.pathname === '/api/limits') {
    if (!requireRoot(req, res)) return;
    return handleLimits(req, res);
  }

  // Create backup snapshot (root only)
  if (url.pathname === '/api/backup/create') {
    if (!requireRoot(req, res)) return;
    try {
      const filename = createSnapshotBackup();
      sendJSON(res, 200, { success: true, filename });
    } catch(e) {
      sendJSON(res, 500, { error: '创建备份失败: ' + e.message });
    }
    return;
  }

  // Backup versions (root only)
  if (url.pathname === '/api/backup/versions') {
    if (!requireRoot(req, res)) return;
    return handleBackupVersions(req, res);
  }

  // Restore from backup (root only)
  if (url.pathname === '/api/backup/restore') {
    if (!requireRoot(req, res)) return;
    return handleBackupRestore(req, res);
  }

  // Serve uploaded files
  if (url.pathname.startsWith('/data/uploads/')) {
    // Path traversal protection
    if (url.pathname.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    // url.pathname = /data/uploads/images/xxx.jpg -> filePath = DATA_DIR + /uploads/images/xxx.jpg = DATA_DIR/uploads/images/xxx.jpg
    const uploadPath = url.pathname.replace('/data', '');
    const filePath = path.join(DATA_DIR, uploadPath);
    // Ensure file is within uploads directory
    if (!filePath.startsWith(UPLOAD_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath)) {
      const extMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.document', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed', '.txt': 'text/plain' };
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': extMap[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n🏫 学院通知看板已启动`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   存储模式: ${USE_MNT ? '/mnt (COS挂载)' : '本地文件系统'}`);
  console.log(`   数据目录: ${DATA_DIR}`);
  console.log(`   按 Ctrl+C 停止服务器\n`);
});
