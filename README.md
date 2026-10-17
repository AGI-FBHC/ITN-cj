# itn_spire

Cangjie (仓颉) + Spire implementation of the ITN business modules.

> Branch `zyqprojects` holds this project. The `main` branch of the ITN-Beta
> repository holds the original Python/Java codebase and is kept unchanged for
> reference.

## Modules

| Module | Routes |
|---|---|
| notes | 笔记 + 分类 CRUD |
| wrong-answers | 错题本 |
| learning-resources | 学习资源 / 知识点 / 进度 / 批改 |
| courses | 课程读侧 + 元数据写回 |
| agent-sessions | 伴学会话 + 课程进度 |
| presentations | 演示文稿读写 |
| resource-tasks | 资源任务读写（create / restart / cancel） |
| customize-tasks | 定制任务读侧 |
| tutoring | 苏格拉底导学（纯规则状态机，零 LLM） |

## Requirements

- Cangjie SDK 1.1.3
- STDX 1.1.3.1 (`CANGJIE_STDX_PATH` pointing at the static `stdx` dir)
- Spire 1.0.20260528
- MySQL reachable from the process

`cjpm.toml` currently declares the `x86_64-w64-mingw32` target.

## Build and run

```bash
# Windows
set CANGJIE_STDX_PATH=<path-to-stdx-static-dir>
set PATH=<path-to-openssl-bin>;%PATH%
set JWT_SECRET=<set via private channel>
set PLATFORM_DB_URL=mysql://<user>:<password>@<host>:3306/<database>
set SPIRE_HTTP_URL=http://127.0.0.1:18801

cjpm build
target\release\bin\main.exe
```

See `config/sample.env` for the configuration shape (placeholders only).

## Health check

```
GET /health  ->  ok
```

The response is plain text `ok`. Any other body is not this service.

## Secrets

`JWT_SECRET` and `PLATFORM_DB_URL` are supplied through a **private channel**
(environment variables or a `chmod 600` env file). They are never committed to
this repository, never written into shared docs, and never placed on a command
line.
