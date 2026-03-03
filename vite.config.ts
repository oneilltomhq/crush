import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 3000,
    allowedHosts: true,  // allow any host (dev only)
    proxy: {
      '/ws/pty': {
        target: 'ws://localhost:8091',
        ws: true,
        rewriteWsOrigin: true,
        rewrite: () => '/',
      },
      '/ws/voice': {
        target: 'ws://localhost:8092',
        ws: true,
        rewriteWsOrigin: true,
        rewrite: () => '/',
      },
      '/ws/cdp': {
        target: 'ws://localhost:8090',
        ws: true,
        rewriteWsOrigin: true,
        rewrite: () => '/',
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  publicDir: false,

});
