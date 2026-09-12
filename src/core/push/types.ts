/** push 파이프라인 결과(main과 renderer가 공유하는 계약 타입). */
export interface PushOutcome {
  uploaded: Array<{ path: string; pageId: string; newVersion: number }>
  conflicts: Array<{ path: string; pageId: string; remoteVersion: number }>
  remoteDeleted: Array<{ path: string; pageId: string }>
  failed: Array<{ path: string; error: string }>
}
