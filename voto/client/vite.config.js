import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../votação-dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/login': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/my-participation': 'http://localhost:3000',
      '/results': 'http://localhost:3000',
      '/election-status': 'http://localhost:3000',
      '/users': 'http://localhost:3000',
      '/candidates': 'http://localhost:3000',
      '/votes': 'http://localhost:3000',
      '/courses': 'http://localhost:3000',
      '/turmas': 'http://localhost:3000',
      '/blockchain': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
});
