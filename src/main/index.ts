import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { buildCsp } from '../core/security/csp'
import { isAllowedNavigation } from '../core/security/navigation'
import { chatRuns, registerAuthAndSpaceHandlers } from './authHandlers'
import { registerIpcHandlers } from './ipc'
import { createMainWindow } from './window'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// 새 창(window.open) 전면 차단 — 모든 외부 링크는 OS 브라우저로만 연다.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, { dev: isDev })) event.preventDefault()
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
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [buildCsp()],
        },
      })
    })

    registerIpcHandlers()
    createMainWindow()
    registerAuthAndSpaceHandlers()

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
