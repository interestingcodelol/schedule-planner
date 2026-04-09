/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

// Single build ID shared between the JS bundle and version.json
const BUILD_ID = Date.now().toString(36)

function versionPlugin(): Plugin {
  return {
    name: 'version-json',
    writeBundle(options) {
      const outDir = options.dir || 'dist'
      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify({ v: BUILD_ID }),
      )
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [react(), tailwindcss(), versionPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
  },
})
