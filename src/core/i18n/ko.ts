/**
 * 한국어 UI 문안 단일 소스(계획 §6-1, ef-16 — ko.ts 단일 소스 원칙).
 * UI 문자열을 추가할 때는 반드시 여기에 먼저 추가한다. 코드/식별자/키는 영문 유지.
 */
export const ko = {
  app: {
    title: 'Confluence 로컬'
  },
  sync: {
    idle: '대기',
    pulling: '동기화 중',
    pushing: '업로드 중',
    agentRunning: '에이전트 편집 중',
    deferred: '동기화 보류',
    conflictCandidates: (count: number) => `충돌 후보 ${count}건`,
    remoteDeleted: '원격에서 삭제됨'
  },
  chat: {
    placeholder: '에이전트에게 지시하기',
    send: '보내기',
    cancel: '에이전트 중지',
    terminalPrefix: '에이전트 종료:',
    errorPrefix: '오류:'
  },
  errors: {
    preloadNotReady: '앱 경계(preload)가 준비되지 않았습니다',
    rootMissing: '#root 엘리먼트를 찾을 수 없습니다'
  },
  preview: {
    webLink: 'Confluence에서 보기',
    empty: '왼쪽에서 문서를 선택하세요'
  },
  tree: {
    empty: '동기화된 문서가 없습니다'
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
    diffLabel: 'diff 보기'
  },
  conflict: {
    title: '충돌이 감지되었습니다',
    list: '충돌 후보',
    none: '충돌 후보가 없습니다',
    localChanges: '로컬 변경',
    overwrite: '내 로컬 버전으로 업로드',
    takeRemote: '원격 최신본으로 교체',
    manualMerge: 'diff 보고 직접 처리',
    overwriteWarning: '원격 변경이 폐기됩니다.'
  },
  auth: {
    siteUrl: '사이트 주소',
    email: '이메일',
    apiToken: 'API 토큰',
    connect: '연결',
    disconnect: '연결 해제'
  }
} as const
