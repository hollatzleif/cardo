import { defineConfig } from 'astro/config';

// Static site, served via GitHub Pages of the public repo (cardo-app).
// With a custom domain
// later, set site to the domain and base to '/'.
export default defineConfig({
  output: 'static',
  site: 'https://hollatzleif.github.io',
  base: '/cardo-app',
  server: { port: 4321 },
});
