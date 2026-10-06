/**
 * Renderer-only Vite config for reviewing the window in a plain browser with the sample data in
 * src/dev/mockApi.ts:  npx vite --config src/renderer/vite.dev.config.ts
 * The app itself is built by electron-vite (electron.vite.config.ts), which never loads the mock.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { '@shared': resolve(__dirname, '../shared'), '@renderer': resolve(__dirname, 'src') } },
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  build: { outDir: resolve(__dirname, '../../out/renderer-review'), emptyOutDir: true }
})
