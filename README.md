# Confluence Local

Confluence 문서를 로컬에서 마크다운으로 편집하고, 변경을 검토·승인한 뒤 Confluence에
업로드하는 Windows·macOS 데스크톱 앱(Electron + React + CodeMirror + better-sqlite3).

## 핵심 워크플로

1. **연결** — Confluence Cloud 사이트 + 이메일 + API 토큰으로 연결(safeStorage로 암호화 저장)
2. **동기화** — 스페이스 단위 pull: storage(XHTML) ↔ 마크다운 변환, 무손실 캐리어 규약
   (변환 불가 요소는 `confluence-storage` 펜스로 원본 보존)
3. **편집** — 직접 에디터(CodeMirror) 또는 Claude Code 에이전트 채팅으로 편집
4. **검토·승인** — 변경 세트 diff 확인 → (선택) 에이전트 변경 감사 → 승인 시에만 업로드
   (TOCTOU 방지 스냅샷, 버전 게이트, 충돌 시 해결 UI)

## 요구 사항

- Node.js 22+, pnpm 11 (`corepack enable`)
- 에이전트 편집 사용 시: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI(`claude`)가 PATH에 설치되어 있어야 함
- Confluence Cloud API 토큰(id.atlassian.com → Settings → API token)

## 개발

```bash
pnpm install        # 의존성 설치
pnpm dev            # electron-vite 개발 모드
pnpm test           # vitest 전체(코어 로직 + happy-dom 컴포넌트 테스트)
pnpm typecheck      # tsc(node/web 2개 프로젝트)
pnpm lint           # biome check
pnpm format         # biome check --write(자동 수정)
pnpm arch           # dependency-cruiser 계층 규칙 검증
pnpm knip           # 미사용 export/의존성 검사
pnpm smoke          # 빌드 후 헤드리스 부팅 검증(APP_SMOKE=1)
```

컴포넌트 테스트(`.test.tsx`)는 파일 첫 줄의 `// @vitest-environment happy-dom`
docblock으로 DOM 환경을 지정한다(기본 환경은 node).

## 빌드·배포

```bash
pnpm build          # electron-vite 프로덕션 빌드(out/)
pnpm dist           # electron-builder 패키징(dist/, NSIS/DMG)
```

- 배포는 `v*` 태그 푸시로 `release.yml`이 구동된다(태그 == package.json 버전 검사 있음).
- afterPack 훅이 Electron 보안 퓨즈(RunAsNode off, asar 무결성 등)를 켠다.
- **현재 무서명 상태**(macOS ad-hoc, Windows 무서명) — macOS 자동 업데이트·Gatekeeper/SmartScreen
  우회를 위해서는 Developer ID 서명 + 공증, 코드사이닝 인증서가 필요하다.

## 보안 경계(요약)

- renderer: `contextIsolation` + `sandbox` + `nodeIntegration: false`
- main↔renderer: typed IPC 화이트리스트(`src/core/ipc/channels.ts`) 단일 소스
- 엄격 CSP(`src/core/security/csp.ts`), 창 내 탐색은 앱 renderer 경로로 한정
- API 토큰은 Electron safeStorage로 암호화 저장(평문 저장 없음)

## 진단

메인 프로세스 로그와 미처리 예외 기록: `userData/logs/main.log`
(macOS: `~/Library/Application Support/Confluence Local/logs/`,
Windows: `%APPDATA%\Confluence Local\logs\`)

## 프로젝트 구조

```
src/
  main/       Electron 메인 프로세스(IPC 핸들러, 동기화·push·에이전트 오케스트레이션)
  preload/    contextBridge 노출 API
  renderer/    React UI(문서 트리·편집·미리보기·검토·충돌·채팅)
  core/       전자 종속 없는 순수 로직(변환기·동기화 상태머신·보안 정책·스토어)
scripts/      golden-pass(E2E 룬북)·afterPack(패키징 하드닝)
```

계층 규칙은 `.dependency-cruiser.cjs`가 강제한다(core는 electron 의존 금지 등).
