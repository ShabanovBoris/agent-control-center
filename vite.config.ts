import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Страница ходит только к backend; заголовки Origin и Host проксируются как есть,
    // потому что backend сверяет их между собой.
    proxy: { '/ws': { target: 'ws://127.0.0.1:8090', ws: true } },
  },
});
