# ITN Knowledge Core 部署文档

## 1. 环境要求

### 1.1 基础软件

| 软件 | 版本 | 用途 |
|------|------|------|
| Python | 3.10+ | KnowledgeCore 服务 |
| Docker | 29+ | RAGFlow 及依赖服务 |
| Homebrew | 最新 | macOS 包管理 |
| uv | 最新 | Python 包管理 |

### 1.2 硬件建议

| 组件 | 最低配置 | 推荐配置 |
|------|----------|----------|
| CPU | 4 核 | 8 核 |
| 内存 | 8GB | 16GB |
| 磁盘 | 50GB | 100GB |

## 2. 安装步骤

### 2.1 安装 Homebrew 工具

```bash
# 安装 Redis（本地备用）
brew install redis

# 安装 MinIO（本地备用）
brew install minio

# 安装 uv（Python 包管理）
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2.2 安装 MySQL

```bash
# 使用 Homebrew 安装
brew install mysql

# 启动服务
brew services start mysql

# 初始化数据库
mysql -u root -e "CREATE DATABASE IF NOT EXISTS itn_core CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -e "CREATE DATABASE IF NOT EXISTS rag_flow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 2.3 配置 MySQL 远程访问

```bash
# 允许 root 用户远程连接（无密码）
mysql -u root -e "ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY ''; FLUSH PRIVILEGES;"
```

## 3. KnowledgeCore 项目部署

### 3.1 进入项目目录

```bash
cd src/agents/KnowledgeCore
```

### 3.2 安装依赖

```bash
uv sync
```

### 3.3 配置环境变量

编辑 `.env` 文件：

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DB=itn_core

RAGFLOW_BASE_URL=http://127.0.0.1:9380
RAGFLOW_API_KEY=

MINIO_ENDPOINT=127.0.0.1:9004
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

DEBUG=true
```

### 3.4 初始化数据库表

```bash
mysql -u root itn_core < app/db/schema.sql
```

### 3.5 启动服务

```bash
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

验证：

```bash
curl http://127.0.0.1:8000/health
# 返回 {"status":"ok"}
```

## 4. RAGFlow 部署

### 4.1 拉取源码

```bash
cd src
git clone https://github.com/infiniflow/ragflow.git
cd ragflow
```

### 4.2 配置文件

配置文件位于 `conf/service_conf.yaml`，内容如下：

```yaml
ragflow:
  host: 0.0.0.0
  http_port: 9380
admin:
  host: 0.0.0.0
  http_port: 9381
mysql:
  name: 'rag_flow'
  user: 'root'
  password: ''
  host: 'host.docker.internal'
  port: 3306
  max_connections: 900
  stale_timeout: 300
  max_allowed_packet: 1073741824
minio:
  user: 'minioadmin'
  password: 'minioadmin'
  host: 'minio:9000'
  bucket: 'ragflow'
  prefix_path: ''
es:
  hosts: 'http://es:9200'
  username: 'elastic'
  password: ''
os:
  hosts: 'http://es:9200'
  username: 'admin'
  password: ''
redis:
  db: 1
  username: ''
  password: ''
  host: 'redis:6379'
```

### 4.3 Docker Compose 配置

使用 `docker-compose.local.yml`：

```yaml
services:
  ragflow:
    image: infiniflow/ragflow:v0.26.2
    platform: linux/amd64
    depends_on:
      es:
        condition: service_healthy
      redis:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "80:80"
      - "9380:9380"
      - "9381:9381"
    volumes:
      - ./ragflow-logs:/ragflow/logs
      - ./conf:/ragflow/conf
    environment:
      - ES_HOST=es
      - OS_HOST=es
      - REDIS_HOST=redis
      - MYSQL_HOST=host.docker.internal
      - MYSQL_PORT=3306
      - MYSQL_USER=root
      - MYSQL_PASSWORD=
      - MINIO_HOST=minio
      - MINIO_PORT=9000
      - MINIO_USER=minioadmin
      - MINIO_PASSWORD=minioadmin
      - http_proxy=
      - https_proxy=
      - no_proxy=localhost,127.0.0.1,host.docker.internal,es,redis,minio,mysql
    restart: unless-stopped

  es:
    image: elasticsearch:8.12.2
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms512m -Xmx512m
    ports:
      - "9210:9200"
    volumes:
      - es_data:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9200"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6381:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    ports:
      - "9004:9000"
      - "9005:9001"
    volumes:
      - minio_data:/data
    restart: unless-stopped

volumes:
  es_data:
  minio_data:
```

### 4.4 启动 RAGFlow

```bash
cd src/ragflow
docker compose -f docker-compose.local.yml up -d
```

### 4.5 验证服务

```bash
# 检查容器状态
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep ragflow

# 测试 API
curl -s http://127.0.0.1:9380/api/v1/health

# 访问 Web 界面
open http://127.0.0.1
```

## 5. 服务端口一览

| 服务 | 端口 | 说明 |
|------|------|------|
| KnowledgeCore API | 8000 | FastAPI 服务 |
| MySQL | 3306 | 本地 MySQL |
| RAGFlow Web | 80 | 管理界面 |
| RAGFlow API | 9380 | 检索 API |
| RAGFlow Admin | 9381 | 管理 API |
| Elasticsearch | 9210 | 文档检索 |
| Redis | 6381 | 缓存 |
| MinIO API | 9004 | 对象存储 |
| MinIO Console | 9005 | 存储管理 |

## 6. 常用命令

### 6.1 启动所有服务

```bash
# 启动 RAGFlow
cd src/ragflow && docker compose -f docker-compose.local.yml up -d

# 启动 KnowledgeCore
cd src/agents/KnowledgeCore && uv run uvicorn app.main:app --reload
```

### 6.2 停止所有服务

```bash
cd src/ragflow && docker compose -f docker-compose.local.yml down
```

### 6.3 查看日志

```bash
# RAGFlow 日志
docker logs ragflow-ragflow-1 -f

# KnowledgeCore 日志
# 终端输出
```

### 6.4 重启单个服务

```bash
docker restart ragflow-ragflow-1
```

## 7. 故障排查

### 7.1 RAGFlow 启动失败

检查 Redis 配置格式，`host` 字段必须包含端口：

```yaml
redis:
  host: 'redis:6379'  # 正确
  host: 'redis'       # 错误
```

### 7.2 MySQL 连接失败

确保 root 用户允许远程连接：

```bash
mysql -u root -e "ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY ''; FLUSH PRIVILEGES;"
```

### 7.3 Elasticsearch 健康检查失败

等待 ES 完全启动（约 30 秒）：

```bash
curl http://127.0.0.1:9210/_cluster/health
```

### 7.4 端口冲突

检查端口占用：

```bash
lsof -i :端口号
```

修改 `docker-compose.local.yml` 中的端口映射解决冲突。

## 8. 项目结构

```
ITN/
├── src/
│   ├── agents/KnowledgeCore/    # 知识决策内核
│   │   ├── app/                 # 应用代码
│   │   │   ├── main.py          # FastAPI 入口
│   │   │   ├── core/            # 配置、数据库
│   │   │   ├── domain/          # 领域包管理
│   │   │   ├── document/        # 文档治理
│   │   │   ├── evidence/        # 证据检索
│   │   │   ├── graph/           # 知识图谱
│   │   │   ├── rules/           # 规则引擎
│   │   │   ├── decision/        # 裁决评分
│   │   │   └── audit/           # 审计回放
│   │   ├── doc/                 # 开发文档
│   │   ├── pyproject.toml       # 项目配置
│   │   └── .env                 # 环境变量
│   └── ragflow/                 # RAGFlow 源码
│       ├── conf/                # 配置文件
│       ├── docker-compose.local.yml
│       └── ...
└── doc/
```
