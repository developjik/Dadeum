# E2E 골든 패스 실행 런북 (AC-1 → AC-4, ef-11)

v1 통과 기준은 이 시나리오 하나다:
**사이트 연결 → 전체 pull → 채팅으로 편집 요청 → diff 확인·승인 → Confluence 반영(버전 증가) 확인**

## 전제 (계획 F5 — 검증 실행 전제)

1. 전용 테스트용 Confluence Cloud 사이트(프로덕션 아님)
2. 해당 사이트의 API 토큰(이메일 + 토큰) — id.atlassian.com에서 발급
3. 로컬에 설치·로그인된 Claude Code(`claude --version` 확인)
4. 앱 빌드물: `pnpm build` 완료 상태

## 자동 실행 스크립트

자격증명을 환경변수로 넣고 실행한다(앱 UI 없이 코어 플로우를 먼저 검증):

```sh
export CONFLUENCE_BASE_URL="https://<test-site>.atlassian.net"
export CONFLUENCE_EMAIL="you@example.com"
export CONFLUENCE_API_TOKEN="ATATT..."
pnpm exec tsx scripts/golden-pass.ts
```

스크립트 단계(스펙 ef-11 순서):

1. **연결(AC-1a)** — ApiClient로 스페이스 목록 조회 → 자격증명·사이트 접근 확인
2. **전체 pull(AC-1b, ef-13)** — `pullFullSpace`로 테스트 스페이스 전체 복제 →
   페이지 수·첨부 수가 원격과 일치하는지 검수
3. **편집(AC-2)** — ClaudeCodeAdapter로 `"E2E 문서 마지막에 '골든 패스 확인' 문단을
   추가해줘"` 헤드리스 실행 → 로컬 파일 변경 확인
4. **diff·승인(AC-3)** — 변경 세트 산출 → 해시 스냅샷 → (자동 승인 플래그 시) 검증
5. **push·반영 확인(AC-4)** — 업로드 → v2 GET으로 version 증가·본문 일치 확인

## UI 수동 확인(추가 검증)

`pnpm dev` → 앱에서 동일 시나리오를 채팅으로 수행 → 미리보기·diff 승인 화면 동작 확인.

## 통과 판정

- 5단계가 모두 통과하면 **v1 골든 패스 달성**(AC-1~AC-4)
- 자격증명이 없으면 여기서 중단하지 말고, 구현 검증 가능 범위(단위·통합·빌드·스모크)를
  전부 통과시킨 뒤 라이브 단계만 human_blocked로 기록한다
