/** push 파이프라인 결과(main과 renderer가 공유하는 계약 타입). */
export interface PushOutcome {
  uploaded: Array<{ path: string; pageId: string; newVersion: number }>
  conflicts: Array<{ path: string; pageId: string; remoteVersion: number }>
  remoteDeleted: Array<{ path: string; pageId: string }>
  failed: Array<{ path: string; error: string }>
  /** 로컬에서 삭제되어 원격에서도 정리된 첨부 */
  deletedAttachments: Array<{ path: string; fileName: string }>
  /** 로컬로 한 번도 동기화된 적 없는 원격 첨부 — 삭제 의도를 확인할 수 없어 보존·보고 */
  skippedRemoteAttachments: Array<{ path: string; fileName: string }>
}
