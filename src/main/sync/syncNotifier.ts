import type { WebContents } from 'electron'

/**
 * main → renderer 동기화 알림(단방향, 'sync:event' 채널).
 * 폴링 결과(갱신·dirty 보호·tombstone)를 UI에 알려 충돌 후보·트리가 스스로 갱신되게 한다.
 * 마지막에 활동한 창을 브로드캐스트 대상으로 유지한다(ipc.ts가 sender를 등록).
 */
export interface SyncEvent {
  type: 'poll'
  spaceKey: string
  updated: number
  skippedDirty: number
  tombstoned: number
}

let sender: WebContents | null = null

export function noteSyncSender(target: WebContents): void {
  sender = target
}

export function broadcastSyncEvent(event: SyncEvent): void {
  if (!sender || sender.isDestroyed()) return
  sender.send('sync:event', event)
}
