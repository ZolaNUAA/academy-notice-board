/**
 * 统一存储管理
 * 根据环境自动选择存储方式:
 * - 腾讯云容器内: 使用 CloudBase 内建存储
 * - 配置了 COS 凭证: 使用 COS SDK 直接上传
 * - 本地开发: 本地文件系统
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CloudBase } = require('@cloudbase/node-sdk');
const COS = require('cos-nodejs-sdk-v5');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

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

// 同步获取腾讯云容器凭证 (从环境变量或role服务)
function getTencentCloudCredentials() {
  // 优先使用环境变量
  if (process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) {
    return {
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN
    };
  }
  return null;
}

// ============ 文件上传 ============

/**
 * 上传文件到云存储
 * @param {Buffer} fileContent - 文件内容
 * @param {string} cloudPath - 云端路径 (如 'uploads/xxx.png')
 * @param {string} filename - 原始文件名
 * @returns {Promise<{url: string, name: string, size: number}>}
 */
async function uploadFile(fileContent, cloudPath, filename) {
  // 确保上传目录存在 (本地)
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  // 方式1: 腾讯云容器环境 -> 使用 CloudBase storage
  if (isOnCloudBase()) {
    try {
      const cloudbase = getCloudbaseInstance();
      const result = await cloudbase.storage().uploadFile({
        cloudPath,
        fileContent
      });
      // 获取临时下载链接
      const urlResult = await cloudbase.storage().getTempFileURL({
        fileList: [result.fileID]
      });
      if (urlResult.fileList && urlResult.fileList[0]) {
        return {
          url: urlResult.fileList[0].tempFileURL,
          name: filename,
          size: fileContent.length
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
      const result = await new Promise((resolve, reject) => {
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
        name: filename,
        size: fileContent.length
      };
    } catch (e) {
      console.warn('[Storage] COS upload failed:', e.message);
    }
  }

  // 方式3: 本地开发 -> 本地文件系统
  const savedName = path.basename(cloudPath);
  const filePath = path.join(UPLOAD_DIR, savedName);
  fs.writeFileSync(filePath, fileContent);
  return {
    url: `${process.env.BASE_URL || 'http://localhost:3000'}/uploads/${savedName}`,
    name: filename,
    size: fileContent.length
  };
}

// ============ 存储清理 (可选) ============

/**
 * 获取本地存储的文件列表
 */
function listLocalFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).filter(f => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, f));
    return stat.isFile();
  });
}

module.exports = {
  uploadFile,
  isOnCloudBase,
  hasCosCredentials,
  listLocalFiles
};
