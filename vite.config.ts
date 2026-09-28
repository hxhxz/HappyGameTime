/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/pokemon/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/pokemon/api': 'http://127.0.0.1:8788' } }, // host:true 监听 0.0.0.0,局域网手机可访问
  preview: { host: true },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
