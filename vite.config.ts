import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  ssr: {
    external: ['node:sqlite'],
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    },
    server: {
      deps: {
        external: [/^node:sqlite$/],
      },
    },
  },
});
