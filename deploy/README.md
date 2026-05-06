# 部署配置说明

## 目录结构

```
deploy/
├── nginx.conf          # Nginx 反向代理配置
└── ecosystem.config.js # PM2 进程管理配置
```

## 服务器初始化步骤

### 1. 安装基础环境（首次）

```bash
# 连接服务器
ssh root@your-server-ip

# 安装 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# 安装 PM2
npm install -g pm2

# 安装 Nginx
apt install -y nginx

# 安装 ssl（ Let's Encrypt 用）
apt install -y certbot python3-certbot-nginx

# 创建项目目录
mkdir -p /var/www/academy-notice-board
```

### 2. 配置 Nginx

```bash
# 复制配置
cp deploy/nginx.conf /etc/nginx/sites-available/notice-board
ln -s /etc/nginx/sites-available/notice-board /etc/nginx/sites-enabled/

# 测试配置
nginx -t

# 重载 Nginx
systemctl reload nginx
```

### 3. 配置 HTTPS（可选）

```bash
certbot --nginx -d your-domain.com
```

### 4. 启动服务

```bash
# 在项目目录
pm2 start deploy/ecosystem.config.js

# 设置开机自启
pm2 startup
pm2 save
```

## 部署命令

```bash
# 修改 deploy.sh 中的配置
# 编辑 server.js 里的配置：
#   - SERVER_HOST
#   - SERVER_USER
#   - SERVER_PORT
#   - DEPLOY_PATH
#   - SSH_KEY 或 SSH_PASSWORD

# 一键部署
./deploy.sh deploy

# 查看状态
./deploy.sh status

# 查看日志
./deploy.sh logs
```

## 目录映射（服务器上）

```
本地                        服务器
─────────────────────────────────
server.js          ->  /var/www/academy-notice-board/server.js
lib/               ->  /var/www/academy-notice-board/lib/
index.html         ->  /var/www/academy-notice-board/index.html
...                ->  ...
data/              ->  /var/www/academy-notice-board/data/（需要手动迁移）
```

## 注意事项

1. **首次部署前**，先在服务器上 `mkdir -p data/uploads/images data/uploads/attachments`
2. **数据迁移**：首次部署不会覆盖 `data/` 目录，需要手动迁移
3. **备份**：`data/notices.json` 会自动通过 GitHub 备份