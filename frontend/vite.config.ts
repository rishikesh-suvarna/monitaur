import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const DEV_SERVER_PORT = 5173;

// One vendor chunk per heavy dependency so app deploys do not bust their cache.
const VENDOR_CHUNKS: ReadonlyArray<readonly [chunk: string, pattern: RegExp]> = [
  ['react', /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ['router', /[\\/]node_modules[\\/](react-router|react-router-dom)[\\/]/],
  ['firebase', /[\\/]node_modules[\\/](firebase|@firebase)[\\/]/],
  ['query', /[\\/]node_modules[\\/]@tanstack[\\/]/],
  ['ui', /[\\/]node_modules[\\/](@headlessui|@floating-ui|@react-aria|@heroicons)[\\/]/],
  ['charts', /[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor)[\\/]/],
];

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          return VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0];
        },
      },
    },
  },
  server: {
    port: DEV_SERVER_PORT,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
