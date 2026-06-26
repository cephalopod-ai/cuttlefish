import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'node:path'

export default defineConfig(() => {
  const gatewayPort = process.env.GATEWAY_PORT ?? '8888'
  // Shared by the dev server AND `vite preview` — preview does not inherit
  // server.proxy, so without this the preview build 404s on /api and /ws.
  const proxy = {
    '/api': {
      target: `http://127.0.0.1:${gatewayPort}`,
      changeOrigin: true,
    },
    '/ws': {
      target: `ws://127.0.0.1:${gatewayPort}`,
      ws: true,
      changeOrigin: true,
    },
  }
  return {
    plugins: [react()],
    // App reads a NEXT_PUBLIC_* var (legacy from the Next era). Vite doesn't
    // auto-replace process.env in the browser, so define it explicitly.
    define: {
      'process.env.NEXT_PUBLIC_GATEWAY_URL': JSON.stringify(
        process.env.NEXT_PUBLIC_GATEWAY_URL ?? '',
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      outDir: 'out',
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      port: 5888,
      strictPort: true,
      proxy,
    },
    preview: {
      proxy,
    },
  }
})
