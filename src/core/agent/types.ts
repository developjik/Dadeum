/**
 * 코딩 에이전트 어댑터 계약(계획 §8.5, ef-19).
 * 구현체별 CLI 차이는 어댑터 안에 숨고 UI·서비스 계층은 이 인터페이스만 본다.
 * 다중 에이전트: capabilities()/discover()로 기능 협상·설치 감지를 한다(ef-20).
 */

/** 어댑터가 실제로 실행할 수 있는 CLI 바이너리(null = 미설치). */
export interface AgentInstallation {
  command: string
}

/** 어댑터 기능 협상 — 미지원 기능은 UI가 숨기고 호출자가 폴백한다. */
export interface AgentCapabilities {
  /** 세션 id로 대화를 이어갈 수 있다(--resume 등). */
  supportsResume: boolean
  /** 쓰기 도구를 디렉터리 단위로 스코핑할 수 있다(워크스페이스 밖 쓰기 차단). */
  supportsScopedWrite: boolean
  /** 읽기 전용 런의 최종 출력을 JSON 판정으로 파싱해 낼 수 있다(변경 감사 게이트). */
  supportsJsonReview: boolean
  /** 실행 중 텍스트·도구 이벤트를 스트리밍한다. */
  supportsStreaming: boolean
}

/** agent:list 응답 항목 — 등록된 어댑터의 설치 여부·기능 요약. */
export interface AgentDescriptor {
  name: string
  installed: boolean
  command?: string
  capabilities: AgentCapabilities
}

/** 설치·기본 어댑터 — 선택이 없을 때의 폴백(가장 성숙한 임베딩 표면). */
export const DEFAULT_ADAPTER_NAME = 'claude-code'
export type AgentRunEvent =
  | { type: 'started'; pid?: number; sessionId?: string }
  | { type: 'text'; value: string }
  | { type: 'tool'; name: string }
  | { type: 'error'; message: string }
  | {
      /** CLI 최종 result 레코드 — close 코드와 무관한 실행 실패(is_error)를 운반한다. */
      type: 'result'
      isError: boolean
      subtype?: string
      value?: string
    }
  | { type: 'terminal'; state: 'completed' | 'cancelled' | 'timeout' | 'error' }
export type AgentTerminalState = 'completed' | 'cancelled' | 'timeout' | 'error'
export interface AgentRunRequest {
  /** 사용자 프롬프트(채팅 입력). */
  prompt: string
  /** 에이전트가 작업할 디렉터리(스페이스 루트). */
  cwd: string
  /** 연속 대화를 위한 에이전트 세션 id(Claude Code session-id). */
  sessionId?: string
  /** 읽기 전용 런(변경 감사 등) — 쓰기 도구를 아예 부여하지 않는다. */
  readOnly?: boolean
  /** 런 타임아웃 ms(기본 10분, 어댑터 소유). */
  timeoutMs?: number
}

export interface AgentRunHandle {
  runId: string
  onEvent(listener: (event: AgentRunEvent) => void): () => void
  /** 런이 끝날 때 단 한 번 resolve된다. */
  terminal: Promise<AgentTerminalState>
  cancel(): void
}

export interface AgentAdapter {
  readonly name: string
  /** CLI 설치 감지 — 바이너리를 찾지 못하면 null(런 시작 전에 차단한다). */
  discover(): AgentInstallation | null
  /** 어댑터 기능 — 미지원 기능은 기능별 degradation 근거로 쓴다. */
  capabilities(): AgentCapabilities
  start(request: AgentRunRequest): AgentRunHandle
}

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000
