# 智训云枢 · Web 端

> 面向个性化学习的 Web 前端。学习数据、知识网络与智能体能力全部由 **仓颉（Cangjie）** 编写的后端服务提供，前端专注渲染与交互。

![React](https://img.shields.io/badge/React-19-149ECA)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6)
![Vite](https://img.shields.io/badge/Vite-7-646CFF)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38BDF8)
![Cangjie](https://img.shields.io/badge/Powered%20by-Cangjie-1F6F4A)

---

## 为什么用仓颉做后端

这个项目的服务端整体使用仓颉语言实现——网关、账号与学习业务、智能体编排都在仓颉服务里完成，前端通过同源代理直接对接：

| 接口前缀 | 提供方 | 返回形态 | 前端调用方式 |
| --- | --- | --- | --- |
| `/api/v1/*` | 仓颉业务服务（网关 + 账号 / 学习 / 资源） | 统一信封 `{ code, message, data, timestamp }` | `request()` 自动拆包，失败统一抛错 |
| `/v1/*` | 仓颉智能体服务（生成、会话、课件） | 直出 JSON / SSE 流 | `requestAgent()` 保留原始结构 |
| `/internal/*` | 仓颉内部调用（仅服务之间） | — | 前端不直接访问 |

由此得到几条硬约束，也是本项目所有页面的实现前提：

- **数据以仓颉服务为准**：学习记录、选课、资源、会话全部落库，前端不造演示数据；
- **空态就是空态**：没有课程 / 没有资源时展示空状态，而不是用模拟数据填充；
- **身份隔离**：登录态用 JWT Bearer；游客体验按设备分配独立身份，退出即清空；
- **弱网可用**：列表与详情走 ETag 协商缓存，断点与视图状态本地留存。

## 功能一览

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/login` | 登录 | 账号登录、管理端入口、游客体验 |
| `/persona` | 选择体验角色 | 三种预置画像，进入即建档 |
| `/welcome`、`/onboarding` | 建档向导 | 学习目标、基础水平、目标岗位 |
| `/` | 平台总览 | 能力介绍、指标看板、智能体拓扑 |
| `/me` | 我的学习 | 正在学习的课程与资源、本周投入、持续热学榜 |
| `/discover` | 发现课程 | 领域 / 书籍 / 专栏，按画像匹配度推荐 |
| `/learn` | 知识网络 | 3D 知识图谱、章节进度、推荐资源 |
| `/learn/resource/:id` | 资源播放器 | 讲义、实操、分阶题；支持语音讲播与断点续学 |
| `/learn/slide/:id` | 幻灯模式 | 与完整阅读同一套分块，逐块翻页 + 自评 |
| `/resources` | 我的资源 | 本人定制的讲义 / 实操 / 分阶题 / 课件 |
| `/me/notes`、`/me/wrong` | 笔记、错题本 | 按知识点归档，随学随记 |
| `/me/garden`、`/report` | 成长与报告 | 养分来源、能力雷达、周报 |
| `/admin/*` | 管理后台 | 领域与知识点、资源母版、账号与组织 |

## 技术栈

- **框架**：React 19 + TypeScript 5.9 + Vite 7（路由级懒加载）
- **样式**：Tailwind CSS 3、Radix UI 原语、自定义设计令牌
- **动效**：framer-motion（进出场）、GSAP + ScrollTrigger（长页叙事）
- **可视化**：three.js / @react-three/fiber（3D 知识网络）、ECharts、Recharts
- **内容渲染**：react-markdown + remark-gfm / remark-math + KaTeX + highlight.js
- **状态与数据**：Context + 自定义 hooks，接口层统一封装与缓存

## 目录结构

```text
apps/web
├─ src/pages          # 路由页面（登录、我的学习、知识网络、资源、后台…）
├─ src/components     # 通用组件与业务组件（图谱、播放器、助手面板…）
├─ src/context        # 登录、画像、智能体、笔记、成长等全局状态
├─ src/hooks          # 学习地图、资源、轮询与缓存
├─ src/lib            # 接口封装、Markdown 处理、工具函数
├─ src/agent          # 伴学助手的规则与话术
├─ src/data           # 类型与常量（不含演示数据）
└─ src/assets         # 字体、图标、插画
```

## 本地开发

```bash
cd apps/web
npm install
cp .env.example .env.local   # 按需修改后端地址
npm run dev                  # http://localhost:3002
```

环境变量（均可在 `.env.local` 覆盖）：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VITE_API_PROXY_TARGET` | `http://localhost:8080` | 开发期 `/api` 代理目标（仓颉网关） |
| `VITE_AGENT_BASE` | `http://localhost:8100` | 开发期 `/v1` 代理目标（仓颉智能体） |
| `VITE_API_BASE` | 空 | 构建期接口前缀，仅在跨域部署时需要 |

开发服务器固定监听 `::`（双栈），避免 `localhost` 先解析到 IPv6 时每个模块请求都多等一次超时。

## 构建与部署

```bash
cd apps/web
npm run build     # 产物在 dist/
npm run preview   # 本地预览构建结果
```

生产环境用 Nginx 托管静态文件，并把接口转发给仓颉服务：

```nginx
root /usr/share/nginx/html;
index index.html;
client_max_body_size 128m;

location /assets/ {
    add_header Cache-Control "public, max-age=604800, immutable";
    try_files $uri =404;
}

location = /index.html {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    try_files $uri =404;
}

location /api/ { proxy_pass http://api:8100; proxy_read_timeout 120s; }
location /v1/  { proxy_pass http://api:8100; proxy_buffering off; proxy_read_timeout 7200s; }
location /     { try_files $uri $uri/ /index.html; }
```

`/v1` 是流式接口（生成进度、助手对话），关闭缓冲、放宽超时；`/api` 为普通请求，保持短超时即可。

## 约定

- 新增接口一律走 `src/lib/api.ts`，不要在页面里裸写 `fetch`；
- 页面只消费真实数据，为空时给空态与下一步入口；
- 表格、卡片等公共样式优先复用设计令牌，避免页面各写一套；
- 提交前跑 `npm run build`（含 TypeScript 检查），保持类型零报错。

## 常见问题

**页面一直转圈 / 接口 404**：确认 `VITE_API_PROXY_TARGET` 指向的仓颉服务已启动，且 `/api/v1/health` 可访问。

**登录后立即跳回登录页**：多为 token 过期或后端时钟偏差，清理站点 LocalStorage 中的登录态后重新登录。

**3D 知识网络空白**：浏览器未启用 WebGL 时会降级为占位图，属预期行为。
