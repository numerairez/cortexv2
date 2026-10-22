import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the UI runs on Vite (5173) and proxies API calls to the local backend.
// In production the backend serves the compiled `dist/` folder itself.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
})
