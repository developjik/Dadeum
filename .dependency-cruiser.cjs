/**
 * 계층 아키텍처 규칙 — core(공유) / main·preload(Node) / renderer(브라우저).
 * renderer↔main은 IPC(contextBridge 노출 API)로만 통신해야 한다.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '순환 의존성은 초기화 순서를 예측 불가능하게 만든다',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-electron',
      severity: 'error',
      comment: 'core는 main·renderer 양쪽 tsconfig에 포함되는 공유 계층 — electron 임포트 금지',
      from: { path: '^src/core' },
      to: { path: 'node_modules.electron' },
    },
    {
      name: 'renderer-no-main',
      severity: 'error',
      comment: 'renderer는 preload가 contextBridge로 노출한 window API로만 통신한다',
      from: { path: '^src/renderer' },
      to: { path: '^src/(main|preload)' },
    },
    {
      name: 'renderer-no-node',
      severity: 'error',
      comment: 'renderer는 브라우저 환경 — node 내장 모듈 직접 임포트 금지(node 환경 테스트 제외)',
      from: { path: '^src/renderer', pathNot: '\\.test\\.tsx?$' },
      to: { path: '^node:' },
    },
    {
      name: 'preload-no-main',
      severity: 'error',
      comment: 'preload는 contextBridge 노출 전용 — main 프로세스 로직 임포트 금지',
      from: { path: '^src/preload' },
      to: { path: '^src/main' },
    },
    {
      name: 'main-no-renderer',
      severity: 'error',
      comment: 'main은 renderer 코드를 임포트하지 않는다(IPC로만 통신)',
      from: { path: '^src/main' },
      to: { path: '^src/renderer' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
  },
}
