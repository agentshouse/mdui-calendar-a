import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
const root = import.meta.dirname;
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    '@ilamy/calendar-recurrence': path.resolve(root, 'vendor/ilamy/recurrence/index.ts'),
    '@ilamy/calendar': path.resolve(root, 'vendor/ilamy/calendar/index.ts'),
    '@ilamy/types': path.resolve(root, 'vendor/ilamy/types/index.ts'),
    '@ilamy/ui': path.resolve(root, 'vendor/ilamy/ui'),
    '@ilamy/utils': path.resolve(root, 'vendor/ilamy/utils'),
    '@': path.resolve(root, 'vendor/ilamy/calendar'),
  } },
  build: { modulePreload: false, sourcemap: false, rollupOptions: { output: { inlineDynamicImports: true } } },
  server: { host: '127.0.0.1' },
});
