import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 8090 — production backend; `npm run web:dev` передаёт 8095, чтобы панель смотрела на mock.
const backend = process.env.ACC_BACKEND ?? '127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Страница ходит только к backend; заголовки Origin и Host проксируются как есть,
    // потому что backend сверяет их между собой.
    proxy: { '/ws': { target: `ws://${backend}`, ws: true } },
  },
});
