import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      // MCP 服务器要能作为**独立进程**跑（stdio 传输、纯 Node），所以除了主进程入口
      // 再吐一份 mcp-server.mjs。它不 import electron、不 import renderer 代码，
      // externalizeDepsPlugin 会把 node:* 与第三方依赖保持 external，不把浏览器代码打进来。
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'mcp-server': resolve('src/main/modules/mcp-server.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
