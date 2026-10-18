import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  /* .env / .env.local 里的 VITE_* 变量必须用 loadEnv 读，process.env 拿不到 */
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: '/',
    plugins: [react()],
    server: {
      port: 3002,
      strictPort: true,
      /*
       * 必须双栈监听。本机 `localhost` 先解析到 ::1，而默认只监听 IPv4 时，
       * 浏览器每个模块请求都要先等一次 IPv6 连接超时再回落 —— 实测每个请求固定慢约 2 秒，
       * 首屏几十个模块就是几十秒，表现成"页面一直在加载、刷新又好了（第二次走缓存）"。
       * 绑定 '::' 后 ::1 与 127.0.0.1 都能直连（Windows 默认 ipv6only=false）。
       */
      host: '::',
      proxy: {
        /*
         * dev 代理目标：
         * - VITE_API_PROXY_TARGET：/api 转发到 Spring Boot 后端（默认本机 8080）
         * - VITE_AGENT_BASE：/v1 转发到 agents（默认本机 8100）
         * 两者都走同源代理，浏览器无 CORS 问题。
         * 注意：VITE_API_BASE 只控制前端 fetch 前缀，不要用它当代理目标。
         */
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:8080',
          changeOrigin: true,
        },
        '/v1': {
          target: env.VITE_AGENT_BASE || 'http://localhost:8100',
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: 4002,
      strictPort: true,
    },
    build: {
      /* 依赖默认分包：three/echarts/markdown 随懒加载页面按需加载，
         不手动分组（手动分组曾导致入口静态引用重型 vendor 块） */
      rollupOptions: {
        output: {},
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  }
})
