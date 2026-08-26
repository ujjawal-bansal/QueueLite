import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Quick tunnels hand out a random hostname; Vite blocks unknown Host
    // headers by default, which would otherwise 403 every request.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', 'localhost'],
    // Same-origin API in dev: no CORS, and the staff session cookie is
    // first-party, so tunnelled testing behaves like production.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
