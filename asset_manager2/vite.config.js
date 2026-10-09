import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs so the build also works when served behind the portal
  // proxy under a path prefix (/p/<name>/) — resolved against the injected <base>.
  base: './',
  plugins: [react()],
  resolve: {
    // Resolve react/react-dom to ONE copy (this app's), so the source-aliased kit
    // can't pull in its own React and trigger "Invalid hook call".
    dedupe: ['react', 'react-dom'],
    alias: {
      // env-overridable (build-all sets LILAK_UI_PATH); default = sibling checkout.
      'lilak-ui': resolve(process.env.LILAK_UI_PATH || resolve(__dirname, '../lilak_ui'), 'src'),
    },
  },
  server: {
    fs: {
      allow: [resolve(__dirname), resolve(__dirname, '../lilak_ui')],
    },
  },
  optimizeDeps: {
    include: ['@phosphor-icons/react', 'react-markdown', 'remark-gfm'],
  },
})
