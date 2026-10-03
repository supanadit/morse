import { defineConfig } from 'vitest/config';

// Tests live in `src`; `dist` is generated output, never re-run.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});