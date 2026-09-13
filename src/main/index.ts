import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { buildCsp } from '../core/security/csp'
import { isAllowedNavigation } from '../core/security/navigation'
import { chatRuns, registerAuthAndSpaceHandlers } from './authHandlers'
import { initDiagnostics } from './diagnostics'
import { registerIpcHandlers } from './ipc'
import { registerUpdaterHandlers } from './updater'
import { createMainWindow } from './window'

const isDev = !!process.env.ELECTRON_RENDERER_URL
// 빌드 산출물 기준 경로 확인용(디버그/스모크).
const rendererDir = join(__dirname, '../renderer')

// 개발 실행(dev Electron 바이너리)과 패키징 빌드가 같은 userData를 공유하면
// safeStorage 키체인 토큰이 서명 차이로 풀리지 않아 매번 재로그인하게 된다 —
// 개발 데이터는 '-dev' 폴더로 분리한다(자격증명·진단 로그·싱글턴 락 모두 분리).
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// 진단(로컬 크래시 덤프 + 미처리 예외 로그)은 가능한 한 일찍 —
// crashReporter.start는 app ready 전 호출이 요구된다.
initDiagnostics()

// 새 창(window.open) 전면 차단 — 모든 외부 링크는 OS 브라우저로만 연다.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, { dev: isDev, allowedFilePathPrefix: rendererDir }))
      event.preventDefault()
  })
})

// 싱글턴 인스턴스 락 — 두 인스턴스가 같은 워크스페이스(SQLite·index.md)를 동시 조작해
// 충돌 상태를 자가 증식시키지 않게 한다.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // 응답 헤더에도 동일 CSP를 강제한다(index.html 메타 태그와 이중 방어).
    // dev에서는 인라인 프리앰블 허용(자세한 근거는 buildCsp 참고).
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [buildCsp({ dev: isDev })],
        },
      })
    })

    registerIpcHandlers()
    registerUpdaterHandlers()
    registerAuthAndSpaceHandlers()

    // 기동 시 메인 창을 즉시 띄운다. activate 이벤트만으로는 부족하다 —
    // CLI/dev 실행에서는 activate가 발생하지 않아(또는 whenReady보다 먼저 지나가
    // 리스너 등록 전에 발생해) 무창 상태로 앱이 살아 있는 P0 회귀가 있었다.
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 종료 시 실행 중인 에이전트 자식 프로세스 그룹을 정리한다(detached 고아 방치 방지)
  app.on('will-quit', () => {
    chatRuns.cancelAll()
  })
}

// 빌드 산출물 기준 경로 확인용(디버그/스모크).
export const mainOutputDir = __dirname
export const preloadEntryPath = join(__dirname, '../preload/index.js')
