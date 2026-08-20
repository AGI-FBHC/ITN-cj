import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { inspectAttr } from 'plugin-inspect-react-code'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
  base: '/',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3002,
    strictPort: true,
    proxy: {
      '/api': {
        target: env.VITE_API_PROXY_TARGET || env.VITE_API_BASE || 'http://localhost:8080',
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
  };
});
