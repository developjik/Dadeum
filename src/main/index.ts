import { app, BrowserWindow, session } from 'electron'
import { join } from 'node:path'
import { buildCsp } from '../core/security/csp'
import { isAllowedNavigation } from '../core/security/navigation'
import { registerIpcHandlers } from './ipc'
import { createMainWindow } from './window'
import { registerAuthAndSpaceHandlers } from './authHandlers'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// 새 창(window.open) 전면 차단 — 모든 외부 링크는 OS 브라우저로만 연다.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, { dev: isDev })) event.preventDefault()
  })
})

app.whenReady().then(() => {
  // 응답 헤더에도 동일 CSP를 강제한다(index.html 메타 태그와 이중 방어).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCsp()]
      }
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

// 빌드 산출물 기준 경로 확인용(디버그/스모크).
export const mainOutputDir = __dirname
export const preloadEntryPath = join(__dirname, '../preload/index.js')
