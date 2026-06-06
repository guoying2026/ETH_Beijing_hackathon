import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/session': {
        target: 'http://localhost:7047',
        changeOrigin: true,
        ws: true,
      },
      '/info': {
        target: 'http://localhost:7047',
        changeOrigin: true,
      },
      '/proof': {
        target: 'http://localhost:7047',
        changeOrigin: true,
      },
      '/proxy': {
        target: 'http://localhost:7047',
        changeOrigin: true,
        ws: true,
      },
      '/verifier': {
        target: 'http://localhost:7047',
        changeOrigin: true,
        ws: true,
      },
      '/rpc': {
        target: 'http://localhost:8545',
        changeOrigin: true,
      }
    }
  }
})
