import { app, type WebContents } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheckOutcome, UpdateEvent } from '../core/updater/types'
import { registerIpcHandler } from './ipc'

/**
 * 앱 내 수동 업데이트(버튼 확인 → 다운로드 → 재시작 설치).
 * 자동 시작 점검은 하지 않는다 — 사용자 요구: "버튼을 누르면 확인".
 * 진행률·완료·실패는 'update:event' 채널로 renderer에 브로드캐스트한다.
 */

let updateSender: WebContents | null = null
/** download-progress 리스너 중복 등록 방지(autoUpdater는 모듈 싱글턴). */
let wired = false

function emit(event: UpdateEvent): void {
  if (!updateSender || updateSender.isDestroyed()) return
  updateSender.send('update:event', event)
}

function configure(updater: AppUpdater): AppUpdater {
  // 수동 모드: 확인·다운로드·설치 전부 사용자 동작으로만 진행
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  return updater
}

async function checkForUpdatesManual(): Promise<UpdateCheckOutcome> {
  const currentVersion = app.getVersion()
  if (!app.isPackaged) {
    return { status: 'unavailable', currentVersion, message: '개발 모드 빌드입니다' }
  }
  const updater = configure(autoUpdater)
  try {
    const result = await updater.checkForUpdates()
    if (!result) {
      return {
        status: 'unavailable',
        currentVersion,
        message: '업데이트 정보를 가져올 수 없습니다',
      }
    }
    const version = result.updateInfo?.version
    const available =
      result.isUpdateAvailable ?? (version !== undefined && version !== currentVersion)
    if (!available || version === undefined) return { status: 'up-to-date', currentVersion }
    return { status: 'available', currentVersion, newVersion: String(version) }
  } catch (cause) {
    throw new Error(`업데이트 확인 실패: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

async function downloadAndInstall(): Promise<void> {
  if (!app.isPackaged) throw new Error('개발 모드 빌드에서는 업데이트를 설치할 수 없습니다')
  const updater = configure(autoUpdater)
  if (!wired) {
    wired = true
    updater.on('download-progress', (progress) => {
      emit({ type: 'progress', percent: Math.round(progress.percent) })
    })
    updater.on('error', (cause) => {
      emit({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }
  // downloadUpdate는 직전 checkForUpdates의 아티팩트 URL을 사용한다 — 설치 직전 재확인
  const check = await updater.checkForUpdates()
  if (!check) throw new Error('업데이트 정보를 가져올 수 없습니다')
  const version = String(check.updateInfo?.version ?? app.getVersion())
  await updater.downloadUpdate()
  emit({ type: 'downloaded', version })
  // renderer가 "재시작 중…" 상태를 그릴 짧은 여유를 주고 즉시 설치 재시작
  setTimeout(() => {
    updater.quitAndInstall(true, true)
  }, 400)
}

export function registerUpdaterHandlers(): void {
  registerIpcHandler('update:check', async (_payload, sender) => {
    updateSender = sender
    return checkForUpdatesManual()
  })
  registerIpcHandler('update:install', async (_payload, sender) => {
    updateSender = sender
    await downloadAndInstall()
    return { started: true }
  })
}
