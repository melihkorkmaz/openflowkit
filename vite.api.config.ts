// The document API as one self-contained Node file (dist-api/server.mjs): it shares the app's validation through `@/`.
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'api/main.ts',
    outDir: 'dist-api',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { entryFileNames: 'server.mjs', inlineDynamicImports: true } },
  },
});
