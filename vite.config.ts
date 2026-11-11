import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'

/**
 * Production-only strict CSP injected into dist/index.html.
 * Dev mode stays CSP-free so Vue HMR can inject its own styles.
 * meta CSP cannot express frame-ancestors; deploy headers cover that (see README).
 */
function cspPlugin(): Plugin {
  const content = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')

  return {
    name: 'bimail-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`
      return html.replace(/<head>/i, (match) => `${match}\n    ${meta}`)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), cspPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts'],
    restoreMocks: true,
  },
})
