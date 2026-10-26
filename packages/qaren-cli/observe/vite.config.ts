import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  // target: 'esnext' — this is an internal, localhost-only dev tool viewed in
  // the developer's current browser, so no legacy downlevel is needed. It also
  // sidesteps an esbuild 0.28 regression that refuses to transform destructuring
  // to vite's default old-browser baseline (the GHSA-gv7w-rqvm-qjhr fix bump).
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
  },
});
