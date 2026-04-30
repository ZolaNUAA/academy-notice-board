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
  return new CloudBase({
    envId: process.env.TCB_ENV_ID || process.env.NEXT_PUBLIC_TCB_ENV_ID,
    secretId: process.env.TENCENTCLOUD_SECRETID || process.env.COS_SECRET_ID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY || process.env.COS_SECRET_KEY,
    sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN
  });
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
 */
async function uploadToStorage(fileContent, cloudPath, savedName, type) {
  const localDir = type === 'image' ? IMAGES_DIR : ATTACHMENTS_DIR;

  // 方式0: 腾讯云COS挂载/mnt -> 使用/mnt目录（最高优先）
  if (USE_MNT) {
    try {
      const filePath = path.join(localDir, savedName);
      fs.writeFileSync(filePath, fileContent);
      console.log(`[Storage] Saved to /mnt: ${filePath}`);
      return {
        url: `${process.env.BASE_URL || 'http://localhost:3000'}/data/uploads/${type === 'image' ? 'images' : 'attachments'}/${savedName}`,
        name: savedName,
        size: fileContent.length,
        cloudPath,
        storage: 'mnt'
      };
    } catch (e) {
      console.warn('[Storage] /mnt write failed:', e.message);
    }
  }

  // 方式1: 腾讯云容器环境 -> 使用 CloudBase storage
  if (isOnCloudBase()) {
    try {
      const cloudbase = getCloudbaseInstance();
      const result = await cloudbase.storage().uploadFile({
        cloudPath,
        fileContent
      });
      const urlResult = await cloudbase.storage().getTempFileURL({
        fileList: [result.fileID]
      });
      if (urlResult.fileList && urlResult.fileList[0]) {
        return {
          url: urlResult.fileList[0].tempFileURL,
          name: savedName,
          size: fileContent.length,
          cloudPath
        };
      }
    } catch (e) {
      console.warn('[Storage] CloudBase upload failed:', e.message);
    }
  }

  // 方式2: 配置了 COS 凭证 -> 使用 COS SDK
  if (hasCosCredentials()) {
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
      return {
        url: `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION || 'ap-guangzhou'}.myqcloud.com/${cloudPath}`,
        name: savedName,
        size: fileContent.length,
        cloudPath
      };
    } catch (e) {
      console.warn('[Storage] COS upload failed:', e.message);
    }
  }

  // 方式3: 本地文件系统
  const filePath = path.join(localDir, savedName);
  fs.writeFileSync(filePath, fileContent);
  return {
    url: `${process.env.BASE_URL || 'http://localhost:3000'}/data/uploads/${type === 'image' ? 'images' : 'attachments'}/${savedName}`,
    name: savedName,
    size: fileContent.length,
    cloudPath
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
