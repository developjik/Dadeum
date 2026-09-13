/**
 * 코딩 에이전트 어댑터 계약(계획 §8.5, ef-19).
 * v1 구현체는 ClaudeCodeAdapter 단 하나. UI·서비스 계층은 이 인터페이스만 본다.
 */
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
  start(request: AgentRunRequest): AgentRunHandle
}

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000
