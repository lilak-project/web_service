import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// All host/port settings come from the environment (with sane defaults), so the
// same code runs on any machine by editing `.env.local` — never the code.
// Modeled on lilak_elog's frontend config.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

  const PORT    = Number(env.PORT) || 5140                       // dev server port
  const BACKEND = env.LILAK_GUI_BACKEND || 'http://localhost:8120'
  // Shared UI kit location — env-overridable so the deploy layout is portable
  // (default = the sibling checkout). `build-all.sh` sets LILAK_UI_PATH.
  const UI = env.LILAK_UI_PATH ? resolve(env.LILAK_UI_PATH) : resolve(__dirname, '../../lilak_ui')

  return {
    // Relative asset URLs so the build also works behind the portal proxy under a
    // path prefix (/p/lilak_gui/) — resolved against the injected <base href>.
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
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
        '/api': BACKEND,
      },
    },
  }
})
