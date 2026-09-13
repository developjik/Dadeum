import { app, ipcMain } from 'electron'
import { assertWhitelistedChannel, type IpcChannel } from '../core/ipc/channels'
import { noteSyncSender } from './sync/syncNotifier'

/**
 * 화이트리스트에 등록된 채널만 등록할 수 있는 typed IPC 레지스트리(계획 §6-7).
 * 새 채널은 core/ipc/channels.ts의 IPC_CHANNELS에 먼저 추가해야 한다.
 * 모든 invoke에서 sender를 기억해 동기화 알림(폴링 결과)을 렌더러로 브로드캐스트한다.
 */
export function registerIpcHandler<C extends IpcChannel>(
  channel: C,
  handler: (payload: unknown, sender: Electron.WebContents) => unknown,
): void {
  assertWhitelistedChannel(channel)
  ipcMain.handle(channel, (event, payload: unknown) => {
    noteSyncSender(event.sender)
    return handler(payload, event.sender)
  })
}

export function registerIpcHandlers(): void {
  registerIpcHandler('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }))
}
