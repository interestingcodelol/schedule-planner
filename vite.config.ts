/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

function versionPlugin(): Plugin {
  const buildId = Date.now().toString(36)
  return {
    name: 'version-json',
    writeBundle(options) {
      const outDir = options.dir || 'dist'
      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify({ v: buildId, t: new Date().toISOString() }),
      )
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss(), versionPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
  },
})
