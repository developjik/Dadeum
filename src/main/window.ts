import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
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
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  win.once('ready-to-show', () => win.show())

  // 스모크 모드: 창이 실제로 로드되면 성공 종료(헤드리스 부팅 검증).
  // 정상 로드 성공은 크래시 재시도 카운터도 리셋한다(재기동 직후 반복 크래시만 상한 적용).
  let crashReloads = 0
  win.webContents.on('did-finish-load', () => {
    crashReloads = 0
    if (process.env.APP_SMOKE === '1') {
      setTimeout(() => app.exit(0), 300)
    }
  })

  // 렌더러 크래시 시 백색 창 방치 없이 재로드한다(깨끗한 종료 제외).
  // 다만 크래시 원인이 지속되면 reload 무한 순환으로 CPU를 태우므로 재시도에 상한을 둔다.
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    if (crashReloads >= 3) {
      dialog.showErrorBox(ko.app.title, ko.app.renderCrashLimit)
      return
    }
    crashReloads += 1
    win.reload()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}
