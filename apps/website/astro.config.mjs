import { defineConfig } from 'astro/config';

// Static site, served via GitHub Pages of the public repo (cardo-app).
// GITHUB_USER is patched to the real account name; with a custom domain
// later, set site to the domain and base to '/'.
export default defineConfig({
  output: 'static',
  site: 'https://GITHUB_USER.github.io',
  base: '/cardo-app',
  server: { port: 4321 },
});
