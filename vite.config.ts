import { defineConfig } from 'vite';

// The frontend is a plain Vite app. It runs in two hosts:
//   - Tauri (production): the platform layer talks to the Rust shell.
//   - A browser (dev + all automated tests): the platform layer is an in-memory stub.
// Nothing outside src/platform/ may know which host it is in.
export default defineConfig({
  root: '.',
  clearScreen: false,
  server: { port: 5183, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
} as never);
