/**
 * 统一存储管理
 * 根据环境自动选择存储方式:
 * - 腾讯云COS挂载/mnt: 使用/mnt目录（高持久性）
 * - 腾讯云容器内: 使用 CloudBase 内建存储
 * - 配置了 COS 凭证: 使用 COS SDK 直接上传
 * - 本地开发: 本地文件系统
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CloudBase } = require('@cloudbase/node-sdk');
const COS = require('cos-nodejs-sdk-v5');

// 检测/mnt是否可用（存在且可写）
const BASE_DIR = process.env.STORAGE_MNT || '/mnt';
let USE_MNT = false;
try {
  USE_MNT = fs.existsSync(BASE_DIR) && fs.statSync(BASE_DIR).isDirectory();
  if (USE_MNT) {
    const testFile = path.join(BASE_DIR, '.write_test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  }
} catch (e) {
  USE_MNT = false;
}

// 存储路径配置
const DATA_DIR = USE_MNT ? path.join(BASE_DIR, 'data') : path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const IMAGES_DIR = path.join(UPLOAD_DIR, 'images');
const ATTACHMENTS_DIR = path.join(UPLOAD_DIR, 'attachments');

// 确保目录存在
function ensureDirs() {
  const dirs = [DATA_DIR, UPLOAD_DIR, IMAGES_DIR, ATTACHMENTS_DIR];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[Storage] Created directory: ${dir}`);
      }
    } catch (e) {
      console.warn(`[Storage] Failed to create directory ${dir}:`, e.message);
    }
  }
}

// 使用try-catch包裹确保模块加载不会崩溃
try {
  ensureDirs();
} catch (e) {
  console.warn('[Storage] ensureDirs failed:', e.message);
}

// ============ 存储配置检测 ============

function isOnCloudBase() {
  return !!(process.env.TCB_ENV_ID || process.env.TENCENTCLOUD_RUNENV);
}

function hasCosCredentials() {
  return !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET);
}

function getCloudbaseInstance() {
  const options = {
    envId: process.env.TCB_ENV_ID || process.env.NEXT_PUBLIC_TCB_ENV_ID,
  };
  // 在 CloudBase 容器内，SDK 自动使用内置服务身份认证
  // 只有在明确设置了外部凭证时才传入，避免覆盖容器内置身份
  const secretId = process.env.TENCENTCLOUD_SECRETID || process.env.COS_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY || process.env.COS_SECRET_KEY;
  if (secretId) options.secretId = secretId;
  if (secretKey) options.secretKey = secretKey;
  if (process.env.TENCENTCLOUD_SESSIONTOKEN) {
    options.sessionToken = process.env.TENCENTCLOUD_SESSIONTOKEN;
  }
  return new CloudBase(options);
}

function getCosInstance() {
  return new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY,
    Bucket: process.env.COS_BUCKET,
    Region: process.env.COS_REGION || 'ap-guangzhou'
  });
}

// ============ 文件上传 ============

/**
 * 确保BASE_URL包含协议前缀
 */
function normalizeBaseUrl(url) {
  if (!url) return 'http://localhost:3000';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return 'https://' + url;
}

/**
 * 上传图片
 */
async function uploadImage(fileContent, originalName) {
  const ext = path.extname(originalName || '.png').toLowerCase();
  const savedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const cloudPath = `uploads/images/${savedName}`;
  return uploadToStorage(fileContent, cloudPath, savedName, 'image');
}

/**
 * 上传附件
 */
async function uploadAttachment(fileContent, originalName) {
  const ext = path.extname(originalName || '.bin').toLowerCase();
  const savedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const cloudPath = `uploads/attachments/${savedName}`;
  return uploadToStorage(fileContent, cloudPath, savedName, 'attachment');
}

/**
 * 通用上传函数
 * 策略：始终保存到本地（Node服务器直接提供，URL永不过期），CloudBase Storage仅作备份
 */
async function uploadToStorage(fileContent, cloudPath, savedName, type) {
  const localDir = type === 'image' ? IMAGES_DIR : ATTACHMENTS_DIR;
  let fileID = null;

  // 确保目录存在
  try {
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
  } catch (e) {
    console.warn('[Storage] Failed to create dir:', e.message);
  }

  // 1) 始终保存到本地文件系统 / /mnt（用于服务器直接提供，URL永不过期）
  const filePath = path.join(localDir, savedName);
  try {
    fs.writeFileSync(filePath, fileContent);
  } catch (e) {
    console.warn('[Storage] Local file write failed:', e.message);
  }

  // 2) 额外上传到 CloudBase Storage（备份用，不依赖其返回的临时URL）
  if (isOnCloudBase()) {
    try {
      const cloudbase = getCloudbaseInstance();
      const result = await cloudbase.storage().uploadFile({ cloudPath, fileContent });
      fileID = result.fileID;
      console.log(`[Storage] CloudBase backup: ${fileID}`);
    } catch (e) {
      console.warn('[Storage] CloudBase backup upload failed:', e.message);
    }
  } else if (hasCosCredentials()) {
    // 3) 如果有COS凭证，也上传到COS备份
    try {
      const cos = getCosInstance();
      await new Promise((resolve, reject) => {
        cos.putObject({
          Bucket: process.env.COS_BUCKET,
          Region: process.env.COS_REGION || 'ap-guangzhou',
          Key: cloudPath,
          Body: fileContent,
          StorageClass: 'STANDARD'
        }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      console.log(`[Storage] COS backup: ${cloudPath}`);
    } catch (e) {
      console.warn('[Storage] COS backup failed:', e.message);
    }
  }

  // 4) 返回相对路径URL（浏览器自动补全域名，适配IP和域名访问）
  return {
    url: `/data/uploads/${type === 'image' ? 'images' : 'attachments'}/${savedName}`,
    name: savedName,
    size: fileContent.length,
    fileID  // 可能为null，用于convertCloudURLs刷新
  };
}

// ============ 存储清理 - 每3个月迭代 ============

const RETENTION_DAYS = 90; // 3个月约90天

/**
 * 清理过期文件（本地存储）
 * 返回被删除的文件列表
 */
function cleanupExpiredFiles() {
  const now = Date.now();
  const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const deleted = [];

  for (const dir of [IMAGES_DIR, ATTACHMENTS_DIR]) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          deleted.push(file);
          console.log(`[Storage] Cleaned up expired file: ${file}`);
        }
      } catch (e) {
        console.warn(`[Storage] Failed to cleanup file ${file}:`, e.message);
      }
    }
  }

  return deleted;
}

/**
 * 获取存储使用统计
 */
function getStorageStats() {
  const stats = {
    images: { count: 0, totalSize: 0 },
    attachments: { count: 0, totalSize: 0 }
  };

  for (const [key, dir] of [['images', IMAGES_DIR], ['attachments', ATTACHMENTS_DIR]]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        stats[key].count++;
        stats[key].totalSize += stat.size;
      } catch (e) {}
    }
  }

  return stats;
}

// 每24小时清理一次（只删除超过90天的文件）
setInterval(cleanupExpiredFiles, 24 * 60 * 60 * 1000);

module.exports = {
  uploadImage,
  uploadAttachment,
  cleanupExpiredFiles,
  getStorageStats,
  isOnCloudBase,
  hasCosCredentials
};
