import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// service_manager's OWN frontend — depends only on the lilak_ui kit (aliased
// below), NOT on lilak_elog. It contains just the portal cover (ProjectsPage +
// AdminPanel); there is no elog workspace, so non-cover routes can't mount.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
  const PORT = Number(env.PORT) || 5133
  // Where the portal backend (this repo's app.main) runs in dev.
  const PORTAL = env.PORTAL_URL || 'http://localhost:8025'
  // The shared UI kit location — env-overridable so the deploy layout is portable
  // (default = the sibling checkout). `build-all.sh` sets LILAK_UI_PATH.
  const UI = env.LILAK_UI_PATH
    ? resolve(env.LILAK_UI_PATH)
    : resolve(__dirname, '../../lilak_ui')

  return {
    plugins: [react()],
    resolve: {
      // Resolve react/react-dom to ONE copy (this app's), so the source-aliased kit
      // can't pull in its own React and trigger "Invalid hook call".
      dedupe: ['react', 'react-dom'],
      alias: {
        // The ONLY external app dependency: the shared UI kit (source-distributed).
        'lilak-ui': resolve(UI, 'src'),
      },
    },
    optimizeDeps: {
      include: ['@phosphor-icons/react', 'react-markdown', 'remark-gfm'],
    },
    server: {
      port: PORT,
      host: true,
      fs: { allow: [resolve(__dirname), UI] },
      proxy: {
        // `/launcher/*` and `/p/*` and `/api/*` all go to the portal backend.
        '/launcher': PORTAL,
        '/pp': PORTAL,
        '/p': PORTAL,
        '/api': PORTAL,
      },
    },
  }
})
