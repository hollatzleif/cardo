import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { cardoPwa } from './vite/cardoPwa';
import { WEB_BASE } from './src/web/pwaBuild';

// Two targets from one code base:
// - default: the Tauri desktop webview (base "/", output dist/)
// - `--mode web`: the iPhone home-screen web app served from GitHub Pages
//   under /cardo-app/app/ (output dist-web/, manifest + service worker).
export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    plugins: web ? [react(), cardoPwa()] : [react()],
    base: web ? WEB_BASE : '/',
    clearScreen: false,
    server: {
      port: web ? 1430 : 1420,
      strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      target: 'es2022',
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      outDir: web ? 'dist-web' : 'dist',
      rollupOptions: web
        ? {
            input: {
              main: fileURLToPath(new URL('./index.html', import.meta.url)),
              oauth: fileURLToPath(new URL('./oauth-callback.html', import.meta.url)),
            },
          }
        : undefined,
    },
  };
});
