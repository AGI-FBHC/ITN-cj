# 仓颉版集成部署

## 组成

- `api`：`cangjie-integration` 根目录的 Spire 服务，负责数据/Agent API 与 `/api/v1`、`/v1` 转发网关。
- `business`：`backend-cj/` 的业务后端，负责认证、组织、管理员、学习者画像等。
- `web`：Nginx，监听宿主机 `20889`，提供前端静态文件并反代到 `api`。

## 服务器目录

```text
/home/ubuntu/itn-cangjie-stack/
  docker-compose.yml
  nginx.conf
  app/api/main
  app/business/main
  web/dist/          # 前端构建产物
  env/api.env        # 0600，不入库
  env/business.env   # 0600，不入库
```

## 构建

```bash
cd /home/ubuntu/itn-cangjie-src
git fetch origin cangjie-integration
git checkout cangjie-integration
git pull --ff-only
bash deploy/build.sh /home/ubuntu/itn-cangjie-src
```

前端在 `front` 分支单独构建：

```bash
git clone -b front git@github.com:AGI-FBHC/ITN-cj.git front
cd front && npm ci && npm run build
rsync -a --delete dist/ /home/ubuntu/itn-cangjie-stack/web/dist/
```

## 启动

```bash
cd /home/ubuntu/itn-cangjie-stack
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:20889/health
```

首次部署前需要停止占用 `20889` 的旧演示容器：

```bash
docker stop itn-cangjie-web
```

## 环境变量

从 `env/*.env.example` 复制为 `env/*.env`，填入真实值并 `chmod 600`。
两套服务与旧 Python agents 必须共用同一个 `JWT_SECRET`，否则转发到 `/v1` 的请求会被拒绝。

## 验证

```bash
curl -i http://127.0.0.1:20889/
curl -i http://127.0.0.1:20889/health
curl -i -X POST http://127.0.0.1:20889/api/v1/auth/guest-login
```