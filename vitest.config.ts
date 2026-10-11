import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';
export default mergeConfig(viteConfig, defineConfig({ test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'happy-dom', globals: false, pool: 'forks', maxWorkers: 1 } }));
