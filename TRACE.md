# ITN-cj 前端变更记录

## 2026-10-18 知识网络页右上角装饰与发版缓存修复

用户反馈：`/learn` 页右上角蕨叶/草丛装饰悬空压在“本章导航”卡片上，视觉突兀；随后又遇到 `Failed to fetch dynamically imported module: .../WrongBook-*.js`。

### 1. 右上角装饰

- `src/pages/Learn.tsx`：移除页头右侧绝对定位的 Fern / GrassTuft，避免高度超出页头后压到下方卡片。
- `src/components/learn/ChapterSidebar.tsx`：把蕨叶与草丛收进“本章导航”卡片右上角，卡片增加 `relative overflow-hidden`，装饰使用低透明度并按圆角裁切，成为角标而不是悬浮物。
- 效果：装饰与卡片形成一体，不再遮挡/悬空；页面标题行保持干净。

### 2. 发版后旧 chunk 404

根因：重新部署时替换了 `dist`，旧 index 仍引用旧哈希文件名；懒加载 `WrongBook-*.js` 时文件已不存在。

- `src/main.tsx`：监听 Vite 的 `vite:preloadError`，10 秒内只自动刷新一次，拿到新 index 后恢复。
- `src/components/RootErrorBoundary.tsx`：识别动态导入失败，提示“页面刚刚更新，旧资源已失效”，只保留“刷新页面”主操作；不再引导用户清空本地数据。
- 部署侧：`deploy/nginx.conf` 对 `index.html` 加 `no-cache, no-store, must-revalidate`；部署说明改为 `rsync -a` 而不是 `--delete`，保留旧哈希 assets，避免已打开页面突然 404。

### 验证

- `npx vite build` 通过（`tsc -b` 仍有仓库既有的历史类型错误，本次未新增）。
- 构建产物包含 `lf.chunkReloadAt` 兜底逻辑。
- 公网 `/learn` 登录态截图确认：装饰已收进“本章导航”卡片右上角，卡片不再被压住。
- `http://43.160.236.121:20889/`、`/assets/WrongBook-CeE7joW9.js` 均返回 200。

### 说明

本次直接更新 `front` 分支并部署到 20889。后续前端发版请保留旧 `assets` 文件；若用户仍停留在旧 index，刷新一次即可。