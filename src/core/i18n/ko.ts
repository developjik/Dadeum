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
    pulling: '동기화 중',
    agentRunning: '에이전트 편집 중',
    authExpired: (spaceKey: string) =>
      `API 토큰이 만료되어 ${spaceKey ? `${spaceKey} ` : ''}자동 동기화를 중단했습니다. 다시 연결하세요.`,
    conflictCandidates: (count: number) => `충돌 후보 ${count}건`,
    remoteDeleted: '원격에서 삭제됨',
    pull: '가져오기',
    pullCancel: '동기화 중단',
    pullHint: '연결됐습니다. 스페이스 옆 가져오기 버튼으로 문서를 내려받으세요.',
    pullDone: (
      pages: number,
      attachments: number,
      skipped: number,
      tombstoned: number,
      failed = 0,
    ) =>
      `${pages}페이지 동기화됨${attachments > 0 ? ` · 첨부 ${attachments}건` : ''}` +
      (skipped > 0 ? ` (로컬 변경 ${skipped}건 보호)` : '') +
      (tombstoned > 0 ? ` · 원격 삭제 ${tombstoned}건 정리` : '') +
      (failed > 0 ? ` · 실패 ${failed}건(재동기화 필요)` : ''),
  },
  chat: {
    placeholder: '에이전트에게 지시하기',
    send: '보내기',
    cancel: '에이전트 중지',
    cancelPending: '에이전트 시작 중입니다. 잠시 후 다시 중지하세요.',
    cancelQueued: '에이전트 시작이 완료되는 대로 중지합니다.',
    terminalPrefix: '에이전트 종료:',
    errorPrefix: '오류:',
    agentFailed: '에이전트 실행이 실패했습니다',
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
    carrierOnly:
      '이 문서는 Confluence 전용 요소(레이아웃·매크로)만 담고 있어 로컬 미리보기가 제한됩니다. 원본은 [Confluence에서 보기]에서 확인하세요.',
  },
  tree: {
    empty: '동기화된 문서가 없습니다 — 스페이스 옆 가져오기 버튼으로 내려받으세요',
    expand: '하위 페이지 펼치기',
    collapse: '하위 페이지 접기',
  },
  review: {
    approve: '승인',
    empty: '변경된 문서가 없습니다',
    uploaded: '업로드 완료',
    conflictNotice: '충돌 — 원격이 변경되었습니다',
    remoteDeletedNotice: '원격에서 삭제된 페이지입니다',
    failedNotice: '업로드 실패',
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
    skippedRemoteAttachment: '원격에만 있는 첨부 — 로컬 미동기화, 삭제하지 않았음',
    missing: '로컬 파일 없음',
    missingCount: (count: number) => `파일 없음 ${count}`,
    missingHint:
      '페이지 기록은 있지만 로컬 파일이 사라졌습니다. 업로드 대상에서 제외되며, 삭제가 의도라면 Confluence에서 페이지를 삭제하세요.',
    auditTitle: '에이전트 변경 감사',
    auditRunning: '변경 감사 진행 중…',
    auditUnparsable: '감사 결과를 판독할 수 없습니다 — diff를 직접 확인하세요.',
    auditEmpty: '감사할 변경이 없습니다.',
    auditOk: '적합',
    auditWarn: '주의',
    auditError: '승인 보류 권고',
    selectAll: '모두 선택',
    deselectAll: '선택 해제',
  },
  conflict: {
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
  update: {
    check: '업데이트 확인',
    checking: '확인 중…',
    upToDate: '최신 버전입니다',
    unavailable: (reason?: string) =>
      `업데이트를 확인할 수 없습니다${reason ? ` — ${reason}` : ''}`,
    install: (version: string) => `v${version} 설치`,
    downloading: (percent: number) => `다운로드 중 ${percent}%`,
    restarting: '재시작 중…',
    failed: (message: string) => `업데이트 실패${message ? ` — ${message}` : ''}`,
  },
  auth: {
    siteUrl: '사이트 주소',
    email: '이메일',
    emailPlaceholder: 'name@example.com',
    apiToken: 'API 토큰',
    tokenHint: 'id.atlassian.com에서 발급한 API 토큰을 입력하세요',
    tokenLink: 'API 토큰 발급 페이지 열기',
    connect: '연결',
    disconnect: '연결 해제',
  },
  aria: {
    spaces: '스페이스 목록',
    documents: '문서 목록',
    workspaceTabs: '작업 탭',
    agentChat: '에이전트 채팅',
    connect: 'Confluence 연결',
    uploadReview: '업로드 검토',
    confirmUpload: '업로드 확정',
    conflicts: '충돌 처리',
    pagePreview: '문서 미리보기',
    documentTree: '문서 트리',
  },
} as const
