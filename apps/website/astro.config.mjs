import { defineConfig } from 'astro/config';

// Static output; the forum API lives in Cloudflare Pages Functions (functions/).
export default defineConfig({
  output: 'static',
  site: 'https://cardo.app',
  server: { port: 4321 },
});
