import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the backend so the browser talks to one
// origin and there's no CORS to configure in development.
//
// Two environment knobs, deliberately separate:
//   - API_TARGET   → where the dev proxy forwards /api (default: the local
//                    backend on :4000). Read via loadEnv so .env works.
//   - VITE_API_URL → the absolute API base baked into the PRODUCTION bundle
//                    (see client.js and .env.example). It is never read by
//                    the dev proxy, so exporting the production API URL can
//                    not hijack local development.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: env.API_TARGET ?? 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  };
});
