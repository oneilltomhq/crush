import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        // The service worker is called 'background' in the manifest
        background: resolve(__dirname, 'service-worker.js'),
        offscreen: resolve(__dirname, 'offscreen.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Preserve original file names
          return chunkInfo.name === 'background' ? 'service-worker.js' : 
                 chunkInfo.name === 'offscreen' ? 'offscreen.js' : 
                 '[name].js';
        },
      },
    },
  },
  server: {
    port: 3000,
    // hmr: false, // Uncomment to disable HMR if it causes issues with extension reloading
  },
  // Ensure assets from node_modules (like ghostty-web wasm) are handled correctly
  assetsInclude: ['**/*.wasm'],
});
