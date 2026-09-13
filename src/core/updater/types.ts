/**
 * 수동 업데이트 IPC 계약(main ↔ renderer 공유).
 * main은 core를 import할 수 있고 renderer는 main을 import할 수 없으므로
 * (dependency-cruiser renderer-no-main 규칙) 계약 타입은 core에 둔다.
 */

export interface UpdateCheckOutcome {
  status: 'up-to-date' | 'available' | 'unavailable'
  currentVersion: string
  newVersion?: string
  message?: string
}

export type UpdateEvent =
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
