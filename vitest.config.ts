import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    // Main-process code runs in node; renderer tests opt in with `// @vitest-environment jsdom`.
    environment: 'node',
    testTimeout: 20_000,
  },
});
