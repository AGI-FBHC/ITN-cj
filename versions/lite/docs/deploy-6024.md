# 6024 部署（113.249.102.41）

2026-10-22 把本地开发环境（前端 + 仓颉后端 + MySQL 数据）整体迁移到 `113.249.102.41`，对外访问入口为 **http://113.249.102.41:6024/**。

## 服务器概况

| 项目 | 值 |
| --- | --- |
| 主机 | `113.249.102.41`（root / SSH 22，Ubuntu 24.04.2 LTS，x86_64，4C / 15G / 80G） |
| 对外端口 | `6024`（nginx，新系统） |
| 后端内部端口 | `127.0.0.1:8312`（仓颉服务，systemd `zhixun-api.service`） |
| 数据库 | 服务器自带 MySQL 8.0.46，库 `zhixun_learning`，账号 `zhixun_learning` |
| 仓颉工具链 | `/opt/cangjie-1.2.0`（SDK 1.2.0 + stdx `cangjie-stdx-linux-x64-1.2.0.1`），与旧 ITN 的 `/opt/cangjie`(1.1.3) 并存互不影响 |
| Python 运行时 | `/opt/zhixun-yunshu/venv`（pillow 13.0.0 + python-pptx 1.0.2，供 PPT 渲染器与 Logo 归一化脚本使用） |

## 目录布局

```
/opt/zhixun-yunshu/
  app/                      # 后端工作目录（CWD），相对路径 data/... 依赖它
    services/learning/      # 仓颉工程源码 + target/release/bin/main
      renderer/             # course-logo/normalize_logo.py、ppt-renderer/render_ppt.py + 背景素材
      migrations/ schema.sql
    data/kb_assets          # 知识库资源（88M）
    data/presentations      # 已生成演示文稿（40M）
    data/org                # 机构 Logo 等（216K）
  web/dist/                 # 前端构建产物（nginx root）
  env/api.env               # 后端环境变量（600 权限，含数据库口令与 AUTH_SECRET，不入 Git）
  venv/                     # Python 运行时
```

## 服务与端口

- `zhixun-api.service`：`WorkingDirectory=/opt/zhixun-yunshu/app`，`ExecStart` 先 `source /opt/cangjie-1.2.0/cangjie/envsetup.sh`，导出 `CANGJIE_STDX_PATH`、`LD_LIBRARY_PATH`，把 `/opt/zhixun-yunshu/venv/bin` 放到 `PATH` 前面（PPT/Logo 脚本调用裸 `python`），最后执行 `./services/learning/target/release/bin/main`。
- nginx 站点 `/etc/nginx/sites-available/zhixun`（已 enable）：`listen 6024`，静态根 `/opt/zhixun-yunshu/web/dist`，`/api/` 反代到 `127.0.0.1:8312`（`proxy_buffering off`，读写超时 7200s 供 SSE 对话使用）。
- 同机其它站点未受影响：`itn` 站点仍在 `6023`/`20889`；原 RAGFlow 站点由 `6024` 改到 `6026`（容器 8088 未动）。

## 数据库

- 迁移方式：本地 `mysqldump`（MySQL 9.3，`--single-transaction --routines --triggers --set-gtid-purged=OFF`）→ gzip → 服务器 `zcat | mysql`。共 26 张表，含课程 6、用户 204、会话 19、资料包 6。
- `ZHIXUN_AUTH_SECRET` 与本地保持一致，数据库中已加密的模型/检索密钥可继续解密使用。
- 启动保护：`loadConfig()` 默认只允许 `itn_learning_v2_dev`；本次新增 `ZHIXUN_ALLOW_DATABASE` 显式放行白名单（服务器上设为 `zhixun_learning`），其余库名仍拒绝启动。

## 重新部署（更新流程）

后端（改了 `services/learning` 后）：

```bash
tar -czf /tmp/zhixun-src.tar.gz -C services/learning src cjpm.toml cjpm.lock renderer migrations schema.sql
# 上传到服务器后：
tar -xzf /tmp/zhixun-src.tar.gz -C /opt/zhixun-yunshu/app/services/learning
bash -lc 'source /opt/cangjie-1.2.0/cangjie/envsetup.sh && \
  export CANGJIE_STDX_PATH=/opt/cangjie-1.2.0/stdx/linux_x86_64_cjnative/static/stdx && \
  export LD_LIBRARY_PATH=/opt/cangjie-1.2.0/stdx/linux_x86_64_cjnative/dynamic/stdx:$LD_LIBRARY_PATH && \
  cd /opt/zhixun-yunshu/app/services/learning && cjpm build -i -j4'
systemctl restart zhixun-api
```

前端（改了 `apps/web` 后）：

```bash
npm run build --prefix apps/web
tar -czf /tmp/zhixun-web.tar.gz -C apps/web dist   # 上传后
rm -rf /opt/zhixun-yunshu/web/dist && tar -xzf /tmp/zhixun-web.tar.gz -C /opt/zhixun-yunshu/web
```

数据库结构变更：在服务器执行 `services/learning/migrations/*.sql`（按编号顺序），再重启 `zhixun-api`。

## 备注

- 仓颉 SDK 1.2.0 从 `cangjie-lang.cn/download/1.2.0` 的直链取得（`/v1/files/auth/downLoad?nsId=142267&fileName=cangjie-sdk-linux-x64-1.2.0.tar.gz&objectKey=...`，sha256 `8c5fd944cd9cc51ee63d4a240e3ecc4f540345dae1468e8b47c927ecf2ba998f`）；stdx 从 `gitcode.com/Cangjie/cangjie_stdx` 的 `v1.2.0.1` release 取得。
- 本机辅助脚本（SSH/SFTP、打包、部署）放在 `data/deploy-work/`，该目录被 `.gitignore` 忽略，不会入库。
