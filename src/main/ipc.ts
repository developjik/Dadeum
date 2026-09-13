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
  ipcMain.handle(channel, async (event, payload: unknown) => {
    noteSyncSender(event.sender)
    try {
      return await handler(payload, event.sender)
    } catch (cause) {
      // Electron 직렬화는 Error를 message 문자열로 평탄화한다 — kind/status를
      // JSON 마커로 실어 보내고 preload가 Error로 재조립한다(렌더러 오류 UX용).
      const error = cause instanceof Error ? cause : new Error(String(cause))
      const enriched: Record<string, unknown> = {
        __ipcError: true,
        name: error.name,
        message: error.message,
      }
      const kind = (error as { kind?: unknown }).kind
      const status = (error as { status?: unknown }).status
      if (typeof kind === 'string') enriched.kind = kind
      if (typeof status === 'number') enriched.status = status
      throw new Error(JSON.stringify(enriched))
    }
  })
}

export function registerIpcHandlers(): void {
  registerIpcHandler('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }))
}
