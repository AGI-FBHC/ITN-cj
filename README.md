# 智训云枢 28801 线上版本本地预览

这是线上部署产物的原样副本，**不是原始 React 开发工程**。

## 启动

使用 PowerShell 7：

```powershell
cd D:\Downloads\zhixun-yunshu-28801-20261020
python preview_server.py --port 3005
```

打开 http://localhost:3005/ 。终端 Ctrl+C 停止服务。

## 文件来源

- 线上页面：http://113.249.110.108:28801/
- SSH 主机：43.160.236.121，账号 ubuntu；本地文件不保存凭据。
- 下载目录：/var/www/zhixun-yunshu/releases/20260803-112502
- Nginx 的 current 软链接指向以上发布目录。
- `deployed/`：下载的8个静态文件，2,552,751字节。
- `nginx-28801.conf`：原站 Nginx 配置参考。
- `SHA256SUMS.txt`：下载文件的 SHA-256 清单。
- `preview_server.py`：本地静态服务与单页路由回退，不修改原站 JS/CSS。
- `TRACE.md`：本地恢复、启动与验证记录，持续追加。

入口 HTML 与主 JS 已核对外网、服务器磁盘、本地副本的 SHA-256，一致。

## 开发边界

部署目录没有 `src/`、`package.json` 或 source map。已检查服务器常见项目目录、部署压缩包及本机两个 front 压缩包，尚未找到这份部署对应的原始 React 源码。此包可直接预览、备份和重部署；后续按原工程开发需要找回源码。若重建源码，应明确标记为重建版本，并用本副本核对页面和交互。
