import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API is proxied to a running desktop app with the mobile server enabled.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { conditions: ['browser'] },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two pages: the read-only owner dashboard and the phone barcode scanner.
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), scanner: resolve(__dirname, 'scanner.html') } },
  },
});
