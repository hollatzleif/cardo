import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.{ts,tsx}', 'apps/desktop/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Browser API polyfills for every jsdom test — see the file for why they
    // are shared rather than repeated per suite.
    setupFiles: ['apps/desktop/src/test/setup.ts'],
  },
});
