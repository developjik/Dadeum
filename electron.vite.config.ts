import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite 5 규약: 엔트리는 src/main/index.ts, src/preload/index.ts,
// src/renderer/index.html로 자동 발견되고 산출물은 out/<계층>에 기록된다.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
