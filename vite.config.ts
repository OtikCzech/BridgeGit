import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const rootDir = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(rootDir, 'src/renderer');

export default defineConfig({
  root: rendererRoot,
  base: './',
  publicDir: false,
  clearScreen: false,
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(rootDir, 'src'),
      '@renderer': rendererRoot,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(rootDir, 'dist/renderer'),
    emptyOutDir: true,
  },
});
