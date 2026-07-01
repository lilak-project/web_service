import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs so the build works behind the portal proxy (/p/g4toy/),
  // resolved against the injected <base href>. Same pattern as the other services.
  base: './',
  plugins: [react()],
  // Built into ../public so the FastAPI backend serves it at / (mounted last,
  // after /api/*). See backend/main.py.
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: { host: '127.0.0.1', port: 5150 },
})
