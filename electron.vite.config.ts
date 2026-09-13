import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// electron-vite 5 규약: 엔트리는 src/main/index.ts, src/preload/index.ts,
// src/renderer/index.html로 자동 발견되고 산출물은 out/<계층>에 기록된다.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [
      react(),
      {
        // dev 전용: index.html의 CSP 메타 태그도 인라인 script를 허용하게 완화한다.
        // @vitejs/plugin-react가 주입하는 Fast Refresh 프리앰블이 인라인 script여서
        // 'self'만으로는 차단되어 dev 모드가 화이트스크린이 된다(프로덕션 빌드는 무관).
        name: 'dev-csp-relax',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        },
      },
    ],
  },
})
