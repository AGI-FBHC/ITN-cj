# Web 部署

本目录部署 Web 前端和两套仓颉服务。Desktop 单独构建，入口见 [Desktop README](../../apps/desktop/README.md)。

## 组件与准备

- `apps/web/`：React 前端，构建后由 Nginx 提供静态文件。
- `services/api/`：仓颉 API 与转发网关。
- `services/business/`：仓颉账号和业务服务。
- MySQL 与既有 Python Agent 服务：按运行环境准备，部分接口仍依赖这些服务。

容器构建使用预先准备好的 `itn-cangjie-sdk:1.1.3` 和 `itn-cangjie-sdk:1.1.3-mysql` 镜像；它们需包含对应 SDK、STDX 和原生依赖。业务镜像还需 MySQL 客户端库。本目录没有提供从零安装 SDK 或初始化生产数据库的自动化。

Compose 当前引用外部网络 `itn_default`。使用前确认网段、MySQL 地址和 Agent 容器地址与实际环境一致，配置不能直接套用到任意服务器。

## 构建

从仓库根目录执行：

```bash
bash deploy/web/build.sh
cd apps/web
npm ci
node --test tests/chunkRecovery.test.mjs
npx vite build
cd ../..
```

两个仓颉可执行文件输出到 `deploy/web/app/api/main` 和 `deploy/web/app/business/main`；前端输出到 `apps/web/dist/`。前端全量类型检查仍有既有错误，因此这里使用 `vite build` 生成静态包。

## 部署目录

以独立目录存放运行文件，例如：

```text
/home/ubuntu/itn-cangjie-stack/
  docker-compose.yml
  nginx.conf
  app/api/main
  app/business/main
  web/dist/
  env/api.env
  env/business.env
```

复制本目录的 Compose、Nginx 配置和编译产物到对应位置。`env/` 中的示例用于创建实际环境文件，实际文件权限设置为 `0600`，不提交到 Git。两套仓颉服务和需要共享认证的 Agent 上游必须使用兼容的 JWT 配置；数据库结构需预先准备。

前端发版先补齐资源，再更新 HTML。以下命令在能访问部署目录的机器上，从仓库根目录执行：

```bash
rsync -a --exclude=/index.html apps/web/dist/ /home/ubuntu/itn-cangjie-stack/web/dist/
cp apps/web/dist/index.html /home/ubuntu/itn-cangjie-stack/web/dist/index.html.next
mv /home/ubuntu/itn-cangjie-stack/web/dist/index.html.next /home/ubuntu/itn-cangjie-stack/web/dist/index.html
```

保留原 `web/dist` 目录和历史哈希资源，避免已打开页面引用的文件失效。`nginx.conf` 为 HTML 配置不缓存策略，并为不存在的静态资源返回404。

## 启动和检查

在准备好的部署目录执行：

```bash
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:20889/health
```

Compose 默认把 Web 入口映射到宿主机20889端口。除健康检查外，还应验证登录、学习数据和依赖上游的接口；健康检查成功不代表所有业务接口可用。

`deploy.sh` 是仅针对 API 的独立部署辅助脚本，需要 `main` 源码检出、主机仓颉环境和环境变量。它会拉取源码、编译和替换本机进程；完整双服务部署应使用上面的 Compose 方案。
