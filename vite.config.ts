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
    server: {
      deps: {
        external: [/^node:sqlite$/],
      },
    },
  },
});
