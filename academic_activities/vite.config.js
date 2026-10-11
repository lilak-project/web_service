import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs: served behind the portal proxy under /pp/academic_activities/<project>/.
  base: './',
  plugins: [react()],
  resolve: {
    // One React for the app and the source-aliased kit.
    dedupe: ['react', 'react-dom'],
    alias: { 'lilak-ui': resolve(process.env.LILAK_UI_PATH || resolve(__dirname, '../lilak_ui'), 'src') },
  },
  server: { fs: { allow: [resolve(__dirname), resolve(__dirname, '../lilak_ui')] } },
})
