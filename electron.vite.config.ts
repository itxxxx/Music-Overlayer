import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The renderer only ever loads local code. In dev, Vite's React refresh preamble is an
// inline script, so the dev policy allows inline scripts; the built app does not.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' ws: http://localhost:* ws://localhost:*"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'music-overlayer:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return html.replace('%CSP%', ctx.server ? DEV_CSP : PROD_CSP)
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      minify: true
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()]
  }
})
