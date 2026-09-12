import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ko } from '../core/i18n/ko'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: ko.app.title,
    show: false,
    webPreferences: {
      // 보안 하드닝(계획 §6-7, M1 고정): 렌더러는 Node에 접근할 수 없고,
      // main과의 소통은 preload가 노출한 typed API로만 가능하다.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  win.once('ready-to-show', () => win.show())

  // 스모크 모드: 창이 실제로 로드되면 성공 종료(헤드리스 부팅 검증).
  win.webContents.on('did-finish-load', () => {
    if (process.env.APP_SMOKE === '1') {
      setTimeout(() => app.exit(0), 300)
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
