import { defineConfig } from 'vite';

// The browser talks to the Worker at /api/*. In dev, Vite proxies those calls to
// `wrangler dev` (port 8787), so the browser sees a single origin and there is no
// CORS to configure. Run both: `npm run worker` and `npm run dev`.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
