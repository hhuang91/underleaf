import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

// Every runtime dependency is listed under devDependencies on purpose: it is
// bundled into out/ by Vite, so the packaged app ships no node_modules.
export default defineConfig({
  main: {
    resolve: { alias }
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: {
      chunkSizeWarningLimit: 4096
    }
  }
})
