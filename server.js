const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;
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
const LOG_FILE = path.join(DATA_DIR, 'operation.log');
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
      lastVisit: null
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

  // Split by 【 markers - each notice starts with 【
  const blocks = [];
  // Replace 【 with \n【 to ensure split works
  const parts = text.split(/(?=【)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) blocks.push(trimmed);
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
  const lowerText = text.toLowerCase();
  // Check high importance first
  for (const kw of IMPORTANCE_KWS.high) {
    if (text.includes(kw)) return 3;
  }
  // Check low importance
  for (const kw of IMPORTANCE_KWS.low) {
    if (text.includes(kw)) return 1;
  }
  // Check medium importance
  for (const kw of IMPORTANCE_KWS.medium) {
    if (text.includes(kw)) return 2;
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

  // Parse day of week like "下周一", "下周二"
  const weekdayNames = ['周日','周一','周二','周三','周四','周五','周六'];
  const weekdayLower = ['周日','周一','周二','周三','周四','周五','周六'];

  // "下周一" etc
  const nextWeekMatch = text.match(/下周([日一二三四五六])/);
  if (nextWeekMatch) {
    const targetDay = weekdayLower.indexOf('周' + nextWeekMatch[1]);
    if (targetDay !== -1) {
      const d = new Date(today);
      const diff = (7 - d.getDay() + targetDay) % 7 + 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // "本周一" etc
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

  // Format: mm月dd日
  [...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)].forEach(m => {
    try {
      let hours = 23, minutes = 59;
      const time = parseTimeInDay(text);
      if (time) { hours = time.hours; minutes = time.minutes; }
      const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10), hours, minutes, 59);
      if (!isNaN(d.getTime())) {
        ddlCandidates.push(d);
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
  // Pattern: 负责人/联系人/对接人：张三
  const patterns = [
    /(?:负责人|联系人|对接人|经办人|审批人|发件人|报送人|报告人)\s*[:：]\s*([^\n，。,；;]+)/,
    /(?:负责人|联系人|对接人|经办人|审批人|发件人|报送人|报告人)[:：]\s*([^\n，。,；;]+)/,
    /负责人\s+(\S{2,})/,
    /联系人\s+(\S{2,})/,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) {
      let name = m[1].trim();
      // Clean trailing punctuation
      name = name.replace(/[，。,；;.。]+$/, '');
      if (name.length >= 2) return name;
    }
  }

  // Email pattern
  const email = text.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (email) return `邮箱 ${email[1]}`;

  // Phone number pattern (various formats)
  const phone = text.match(/(?:电话|手机|联系方式|联系电话)[:：]?\s*(\d{3,4}[-－]?\d{7,8}|\d{11})/);
  if (phone) return `电话 ${phone[1]}`;

  // WeChat/Tech team contact
  const wx = text.match(/(?:微信|企微|钉钉|飞书)[:：]?\s*(\S+)/);
  if (wx) return wx[1];

  // Signature line at end (2-4 Chinese chars)
  const signMatch = text.match(/\n([\u4e00-\u9fa5]{2,4})\s*$/m);
  if (signMatch) return signMatch[1];

  // Last line with name-like pattern
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(lastLine)) return lastLine;
  }

  return '未指定';
}

// Enhanced link extraction
function extractLinks(text) {
  const links = new Set();

  // Standard URLs - stop at closing brackets/parentheses (including Chinese)
  const urlPatterns = [
    /https?:\/\/[^\s\uFF08\u2018\u2019\u300C<>"'\\（）\)\]\uff09\]]+/gi,
    /http:\/\/[^\s\uFF08\u2018\u2019\u300C<>"'\\（）\)\]\uff09\]]+/gi,
  ];

  for (const pattern of urlPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Clean trailing punctuation (including Chinese brackets)
      let url = match[0].replace(/[。，,.。;；)>\]\uff09\]]+$/, '');
      // Validate URL
      try {
        new URL(url.startsWith('http') ? url : 'http://' + url);
        links.add(url);
      } catch(e) {}
    }
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
function extractKeyPoints(body) {
  const points = [];
  const lines = body.split('\n').filter(l => l.trim().length > 5 && l.trim().length < 100);

  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/^[\s\d、.。:：•\-–—]+/, '').trim();
    if (cleaned.length > 5 && cleaned.length < 100) {
      points.push(cleaned);
    }
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

  const { ddl } = parseDates(body, fallback);
  const cat = inferCategory(`${title}\n${body}`);
  const imp = inferImportance(`${title}\n${body}`);
  const owner = parseOwner(body);
  const links = extractLinks(body);
  const now = new Date();
  const expired = ddl ? ddl < now : false;

  return {
    id: `n-${idx}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type: cat.name,
    typeClass: `cat-${cat.key}`,
    title, body,
    publishDate: toISO(now), // 发布时间始终为粘贴时的当天日期
    deadline: ddl ? toISO(ddl) : null,
    importance: imp,
    owner, links, expired,
  };
}

function parseRawInput(raw) {
  return splitNoticeBlocks(raw).map((b, i) => parseNoticeBlock(b, i));
}

// ============ Data Operations ============
function readNotices() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch { return []; }
}

function writeNotices(notices) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(notices, null, 2), 'utf-8');
  // GitHub backup disabled - data stored in Tencent Cloud COS
}

// ============ Auth Handlers ============
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
      recordLoginSuccess(ip);
      logOperation('LOGIN', {
        username: admin.username,
        role: admin.role,
        ip: ip,
        userAgent: ua
      });
      sendJSON(res, 200, { success: true, username: admin.username, role: admin.role });
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

// ============ Verify Code ============
async function handleVerify(req, res) {
  try {
    const { code } = await parseJSONBody(req);
    if (!code) return sendJSON(res, 400, { error: 'code required' });
    if (code === VERIFY_CODE) {
      sendJSON(res, 200, { success: true });
    } else {
      sendJSON(res, 401, { error: '验证码错误' });
    }
  } catch(e) {
    sendJSON(res, 500, { error: 'Verify error' });
  }
}

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
    saveConfig(config);
    logOperation('PASSWORD_CHANGE', { admin: currentAdmin.username, ip, userAgent: ua });
    sendJSON(res, 200, { success: true });
  } catch(e) {
    sendJSON(res, 500, { error: 'Password change error: ' + e.message });
  }
}

// ============ HTTP Handlers ============
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

  // Sort: importance desc, then deadline asc
  notices.sort((a, b) => {
    if (a.importance !== b.importance) return b.importance - a.importance;
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return new Date(a.deadline) - new Date(b.deadline);
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
        const newNotices = parseRawInput(text);

        // Attach files to first notice (or all if needed)
        if (attachments.length > 0 && newNotices.length > 0) {
          newNotices[0].attachments = attachments;
        }

        const existing = readNotices();
        const all = [...existing, ...newNotices];
        writeNotices(all);
        sendJSON(res, 200, { success: true, count: newNotices.length, notices: newNotices });
      } catch(e) {
        console.error('Upload error:', e.message);
        sendJSON(res, 500, { error: 'Upload error: ' + e.message });
      }
    });
  } else {
    // JSON body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const text = parsed.text;
        if (!text) return sendJSON(res, 400, { error: 'text required' });
        const newNotices = parseRawInput(text);
        const existing = readNotices();
        const all = [...existing, ...newNotices];
        writeNotices(all);
        sendJSON(res, 200, { success: true, count: newNotices.length, notices: newNotices });
      } catch(e) {
        console.error('POST error:', e.message, 'Body:', body.slice(0, 100));
        sendJSON(res, 500, { error: 'Parse error: ' + e.message });
      }
    });
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

      const existing = readNotices();
      if (attachments.length > 0) {
        notice.attachments = attachments;
      }
      notice.id = `n-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
      notice.expired = notice.deadline ? new Date(notice.deadline) < new Date() : false;
      existing.push(notice);
      writeNotices(existing);
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
      if (cfg.webhookSecret && secret !== cfg.webhookSecret) {
        return sendJSON(res, 401, { error: 'Invalid secret' });
      }

      const notices = parseRawInput(text);
      const existing = readNotices();
      const now = new Date();

      for (const n of notices) {
        n.id = `n-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        n.expired = n.deadline ? new Date(n.deadline) < now : false;
        existing.push(n);
      }

      writeNotices(existing);
      sendJSON(res, 200, { success: true, count: notices.length, notices });
    } catch(e) {
      sendJSON(res, 500, { error: 'Webhook error: ' + e.message });
    }
}

async function handlePreview(req, res) {
  try {
    const parsed = await parseJSONBody(req);
    const text = parsed.text;
    if (!text) return sendJSON(res, 400, { error: 'text required' });
    const notices = parseRawInput(text);
    sendJSON(res, 200, { notices });
  } catch(e) {
    sendJSON(res, 500, { error: 'Parse error: ' + e.message });
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
    // Return last 100 entries
    const logs = lines.slice(-100);
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
async function handleBackupVersions(req, res) {
  return sendJSON(res, 200, { versions: [], message: 'GitHub备份已禁用，数据存储在腾讯云COS' });
}

async function handleBackupRestore(req, res) {
  return sendJSON(res, 200, { success: false, message: 'GitHub备份已禁用，数据存储在腾讯云COS' });
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
  // Increment visit counter
  config.visits++;
  config.lastVisit = new Date().toISOString();
  saveConfig(config);

  const notices = readNotices();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = notices.filter(n => {
    if (!n.publishDate) return false;
    const d = new Date(n.publishDate);
    return d >= today;
  }).length;

  sendJSON(res, 200, {
    totalVisits: config.visits,
    lastVisit: config.lastVisit,
    todayNotices: todayCount,
    totalNotices: notices.length,
    version: cachedVersion ? cachedVersion.version : (process.env.DEPLOY_VERSION || getGitShortHash()),
    versionDate: cachedVersion ? cachedVersion.date : (process.env.DEPLOY_DATE || new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})),
    indexHtmlTime: (() => {
      try {
        const stat = fs.statSync(path.join(__dirname, 'index.html'));
        return stat.mtime.toISOString();
      } catch { return null; }
    })()
  });
}

function handleDELETE(req, res, id) {
  const notices = readNotices();
  const filtered = notices.filter(n => n.id !== id);
  if (filtered.length === notices.length) return sendJSON(res, 404, { error: 'Not found' });
  writeNotices(filtered);
  sendJSON(res, 200, { success: true });
}

function handlePATCH(req, res, id) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const updates = JSON.parse(body);
      const notices = readNotices();
      const idx = notices.findIndex(n => n.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Not found' });
      // Recalc expired if deadline changed
      if (updates.deadline !== undefined) {
        updates.expired = updates.deadline ? new Date(updates.deadline) < new Date() : false;
      }
      notices[idx] = { ...notices[idx], ...updates };
      writeNotices(notices);
      sendJSON(res, 200, notices[idx]);
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

  // API routes
  if (url.pathname.startsWith('/api/notices/')) {
    const id = url.pathname.split('/').pop();
    if (req.method === 'DELETE') return handleDELETE(req, res, id);
    if (req.method === 'PATCH') return handlePATCH(req, res, id);
  }

  // Direct add a pre-parsed notice (from edited preview)
  if (url.pathname === '/api/notice') {
    if (req.method === 'POST') return handleAddDirect(req, res);
  }

  // Image upload
  if (url.pathname === '/api/image') {
    if (req.method === 'POST') return handleImageUpload(req, res);
  }

  // Webhook receiver for auto-import
  if (url.pathname === '/api/webhook/receive') {
    if (req.method === 'POST') return handleWebhook(req, res);
  }

  if (url.pathname === '/api/notices') {
    if (req.method === 'GET') return handleGET(req, res);
    if (req.method === 'POST') return handlePOST(req, res);
  }

// Login: verify password
  if (url.pathname === '/api/login') {
    if (req.method === 'POST') return handleLogin(req, res);
  }

// Verify access code
  if (url.pathname === '/api/verify') {
    if (req.method === 'POST') return handleVerify(req, res);
  }

  // Change password
  if (url.pathname === '/api/password') {
    if (req.method === 'POST') return handleChangePassword(req, res);
  }

  // Preview: parse text without saving
  if (url.pathname === '/api/preview') {
    if (req.method === 'POST') return handlePreview(req, res);
  }

  // Stats: visit counter and notice stats
  if (url.pathname === '/api/stats') {
    if (req.method === 'GET') return handleStats(req, res);
  }

  // Logs: get operation logs (root only)
  if (url.pathname === '/api/logs') {
    if (req.method === 'GET') return handleLogs(req, res);
  }

  // Webhook config
  if (url.pathname === '/api/webhook/config') {
    return handleWebhookConfig(req, res);
  }

  // System limits config (root only)
  if (url.pathname === '/api/limits') {
    return handleLimits(req, res);
  }

  // Backup versions (root only)
  if (url.pathname === '/api/backup/versions') {
    return handleBackupVersions(req, res);
  }

  // Restore from backup (root only)
  if (url.pathname === '/api/backup/restore') {
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
