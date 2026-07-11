import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.{ts,tsx}', 'apps/desktop/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
