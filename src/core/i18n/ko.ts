/**
 * 한국어 UI 문안 단일 소스(계획 §6-1, ef-16 — ko.ts 단일 소스 원칙).
 * UI 문자열을 추가할 때는 반드시 여기에 먼저 추가한다. 코드/식별자/키는 영문 유지.
 */
export const ko = {
  app: {
    title: 'Confluence 로컬',
    tagline: '문서를 로컬에서 수정하고, 검토 후 Confluence로 업로드합니다',
    loading: '불러오는 중…',
  },
  common: {
    close: '닫기',
    cancel: '취소',
  },
  sidebar: {
    spaces: '스페이스',
    pages: '문서',
  },
  tabs: {
    document: '문서',
    review: '업로드 검토',
    conflict: '충돌',
  },
  main: {
    noSpace: '왼쪽에서 스페이스를 선택하세요',
  },
  sync: {
    idle: '대기',
    pulling: '동기화 중',
    pushing: '업로드 중',
    agentRunning: '에이전트 편집 중',
    deferred: '동기화 보류',
    conflictCandidates: (count: number) => `충돌 후보 ${count}건`,
    remoteDeleted: '원격에서 삭제됨',
    pull: '가져오기',
    pullDone: (
      pages: number,
      attachments: number,
      skipped: number,
      tombstoned: number,
      failed = 0,
    ) =>
      `${pages}페이지 · 첨부 ${attachments}건 동기화됨` +
      (skipped > 0 ? ` (로컬 변경 ${skipped}건 보호)` : '') +
      (tombstoned > 0 ? ` · 원격 삭제 ${tombstoned}건 정리` : '') +
      (failed > 0 ? ` · 실패 ${failed}건(재동기화 필요)` : ''),
  },
  chat: {
    placeholder: '에이전트에게 지시하기',
    send: '보내기',
    cancel: '에이전트 중지',
    terminalPrefix: '에이전트 종료:',
    errorPrefix: '오류:',
    title: '에이전트',
    empty: '에이전트에게 문서 작업을 지시해 보세요',
    toolPrefix: '도구 실행',
  },
  errors: {
    preloadNotReady: '앱 경계(preload)가 준비되지 않았습니다',
    rootMissing: '#root 엘리먼트를 찾을 수 없습니다',
  },
  preview: {
    webLink: 'Confluence에서 보기',
    empty: '왼쪽에서 문서를 선택하세요',
  },
  tree: {
    empty: '동기화된 문서가 없습니다',
  },
  review: {
    approve: '승인',
    reject: '보류',
    diffTitle: '업로드 검토',
    reviewUpload: '업로드 검토',
    empty: '변경된 문서가 없습니다',
    uploaded: '업로드 완료',
    conflictNotice: '충돌 — 원격이 변경되었습니다',
    remoteDeletedNotice: '원격에서 삭제된 페이지입니다',
    failedNotice: '업로드 실패',
    addedPrefix: '신규:',
    attachmentPrefix: '첨부:',
    diffLabel: 'diff 보기',
    recheck: '다시 검사',
    modified: '수정',
    added: '신규',
    attachments: '첨부',
    selectedCount: (count: number) => `${count}개 항목 선택됨`,
    modifiedCount: (count: number) => `수정 ${count}`,
    addedCount: (count: number) => `신규 ${count}`,
    attachmentCount: (count: number) => `첨부 ${count}`,
    confirmUpload: (count: number) => `선택한 ${count}개 항목을 Confluence에 업로드합니다`,
    uploadConfirm: '업로드 확정',
    deletedAttachment: '원격 첨부 삭제',
    missing: '로컬 파일 없음',
    missingCount: (count: number) => `파일 없음 ${count}`,
    missingHint:
      '페이지 기록은 있지만 로컬 파일이 사라졌습니다. 업로드 대상에서 제외되며, 삭제가 의도라면 Confluence에서 페이지를 삭제하세요.',
  },
  conflict: {
    title: '충돌이 감지되었습니다',
    list: '충돌 후보',
    none: '충돌 후보가 없습니다',
    localChanges: '로컬 변경',
    overwrite: '내 로컬 버전으로 업로드',
    takeRemote: '원격 최신본으로 교체',
    manualMerge: 'diff 보고 직접 처리',
    overwriteWarning: '원격 변경이 폐기됩니다.',
    overwriteConfirm: '덮어쓰면 원격 변경이 폐기됩니다. 확정할까요?',
    overwriteConfirmYes: '덮어쓰기 확정',
    remoteDeletedHint:
      '원격에서 삭제된 페이지입니다. 로컬 사본은 보존되며, 복원은 Confluence에서 페이지를 복구한 뒤 동기화하세요.',
  },
  auth: {
    siteUrl: '사이트 주소',
    email: '이메일',
    apiToken: 'API 토큰',
    tokenHint: 'id.atlassian.com에서 발급한 API 토큰을 입력하세요',
    tokenLink: 'API 토큰 발급 페이지 열기',
    connect: '연결',
    disconnect: '연결 해제',
  },
} as const
