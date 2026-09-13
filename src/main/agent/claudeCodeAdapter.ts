import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  type AgentAdapter,
  type AgentRunEvent,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTerminalState,
  DEFAULT_AGENT_TIMEOUT_MS,
} from '../../core/agent/types'
import { parseStreamJsonLine } from './streamJson'

/** 테스트 주입을 위한 최소 프로세스 표면(node ChildProcess와 호환). */
export interface AgentProcess {
  pid?: number
  stdin: {
    write(chunk: string): void
    end(): void
    on?(event: 'error', listener: (cause: Error) => void): void
  }
  stdout: {
    setEncoding(enc: string): void
    on(event: 'data', listener: (chunk: string) => void): void
  }
  stderr: {
    setEncoding(enc: string): void
    on(event: 'data', listener: (chunk: string) => void): void
  }
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (cause: Error) => void): void
  kill(signal?: NodeJS.Signals | number): unknown
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => AgentProcess

/** stdout 라인 버퍼 상한 — 개행 없는 폭주 출력(비정상 클라이언트) 방어. */
const MAX_LINE_BUFFER_BYTES = 1024 * 1024

/** macOS GUI 런치 환경 PATH 보완용 후보 경로(F-10). */
const GUI_PATH_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function resolveClaudeCommand(
  candidates: string[] = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  exists: (p: string) => boolean = (p) => existsSync(p),
): string {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return 'claude' // PATH 위임
}

export function augmentedGuiPath(current: string | undefined): string {
  const parts = (current ?? '').split(':').filter((p) => p.length > 0)
  for (const candidate of GUI_PATH_CANDIDATES) {
    if (!parts.includes(candidate)) parts.push(candidate)
  }
  return parts.join(':')
}

export function buildClaudeArgs(
  sessionId: string | undefined,
  spaceRoot?: string,
  readOnly = false,
): string[] {
  if (readOnly) {
    // 감사 런: 쓰기 도구 자체를 부여하지 않는다 — 문서 내용(신뢰 불가 입력)이
    // 무슨 지시를 심어도 워크스페이스를 바꿀 수 없다. 세션 resume도 하지 않는다.
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'Read,Glob,Grep',
    ]
    return args
  }
  // 파일 수정 도구는 스페이스 루트로 경로 스코프 — 프롬프트 인젝션에 의한
  // 워크스페이스 밖 쓰기를 차단한다(읽기 도구는 CLI 기본 정책을 따른다).
  const writeScope = spaceRoot ? scopedToolRule(spaceRoot) : ''
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    `Read,Glob,Grep,Edit${writeScope},Write${writeScope}`,
  ]
  if (sessionId) args.push('--resume', sessionId)
  return args // 프롬프트는 stdin으로 전달
}

/** Claude Code 경로 규칙 — 절대 경로는 `//` 접두(gitignore 방식). */
function scopedToolRule(spaceRoot: string): string {
  const posix = spaceRoot.replace(/\\/g, '/')
  return `(//${posix.replace(/^\/+/, '')}/**)`
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code'

  private readonly spawnImpl: SpawnFn

  constructor(options?: { spawnImpl?: SpawnFn }) {
    this.spawnImpl = options?.spawnImpl ?? ((command, args, opts) => nodeSpawn(command, args, opts))
  }

  start(request: AgentRunRequest): AgentRunHandle {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const listeners = new Set<(event: AgentRunEvent) => void>()
    let cancelled = false
    let timedOut = false
    let settled = false
    // result 레코드가 실행 실패(is_error)를 보고하면 close code와 무관하게 error로 종단한다
    let resultError = false
    let activeChild: AgentProcess | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 프로세스 그룹 단위 종료 — cancel·타임아웃·출력 폭주가 동일 범위를 정리하게 한다. */
    const killTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      const child = activeChild
      if (!child) return
      if (process.platform === 'win32') {
        this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid ?? 0)], {
          cwd: request.cwd,
          env: process.env,
          detached: false,
        })
        return
      }
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }

    const emit = (event: AgentRunEvent): void => {
      for (const listener of listeners) listener(event)
    }

    const terminal = new Promise<AgentTerminalState>((resolve) => {
      const settle = (state: AgentTerminalState): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(state)
      }

      const command = resolveClaudeCommand()
      const env = { ...process.env, PATH: augmentedGuiPath(process.env.PATH) }
      let child: AgentProcess
      try {
        child = this.spawnImpl(
          command,
          buildClaudeArgs(request.sessionId, request.cwd, request.readOnly === true),
          {
            cwd: request.cwd,
            env,
            detached: process.platform === 'darwin',
          },
        )
      } catch (cause) {
        // 스폰 자체의 동기 실패 — terminal을 반드시 종결시켜 스페이스 락이 풀리게 한다
        emit({
          type: 'error',
          message: `에이전트 실행 실패: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
        settle('error')
        return
      }
      activeChild = child
      emit({ type: 'started', pid: child.pid })
      // 스폰 직후 죽은 자식의 stdin write EPIPE가 미처리 예외로 메인을 죽이지 않게 한다
      child.stdin.on?.('error', () => undefined)
      // 프롬프트는 stdin으로 전달(claude -p는 stdin/positional 양쪽 지원, 파이프 환경에서 stdin이 안전)
      child.stdin.write(request.prompt)
      child.stdin.end()

      timer = setTimeout(() => {
        timedOut = true
        // cancel과 동일하게 SIGTERM → 2초 후 SIGKILL. 즉시 SIGKILL하면 CLI가
        // 편집 중이던 파일을 반쯤 쓴 상태로 남길 수 있다(정리 기회를 준다).
        killTree('SIGTERM')
        setTimeout(() => killTree('SIGKILL'), 2000)
      }, request.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS)

      // 바이너리 부재·cwd 부재 등은 'error' 이벤트로만 arrive하고 close가 오지 않는다.
      // 처리하지 않으면 terminal이 영원히 미해결되어 스페이스가 agent-run 잠금 상태로 남는다.
      child.on('error', (cause: Error) => {
        emit({ type: 'error', message: `에이전트 실행 실패: ${cause.message}` })
        settle('error')
      })

      // stream-json은 줄 단위 프로토콜 — 청크 경계에서 잘린 라인은 버퍼링해야 파싱된다.
      let lineBuffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        lineBuffer += chunk
        // 개행 없는 폭주 출력으로 라인 버퍼가 무한 증가하지 않게 상한을 둔다
        if (lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
          emit({ type: 'error', message: '에이전트 출력이 비정상적으로 커서 실행을 중단합니다' })
          killTree('SIGKILL')
          lineBuffer = ''
          return
        }
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          for (const event of parseStreamJsonLine(line)) {
            if (event.type === 'result' && event.isError) resultError = true
            emit(event)
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        const trimmed = chunk.trim()
        if (trimmed.length > 0) emit({ type: 'error', message: trimmed })
      })
      child.on('close', (code: number | null) => {
        // 잔여 버퍼 플러시(마지막 줄이 개행 없이 끝나는 경우)
        if (lineBuffer.trim().length > 0) {
          for (const event of parseStreamJsonLine(lineBuffer)) {
            if (event.type === 'result' && event.isError) resultError = true
            emit(event)
          }
          lineBuffer = ''
        }
        // result 레코드가 실행 실패를 보고했으면 exit code 0이어도 error로 종단한다
        if (cancelled) settle('cancelled')
        else if (timedOut) settle('timeout')
        else if (code === 0 && !resultError) settle('completed')
        else settle('error')
      })
    })

    return {
      runId,
      onEvent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      terminal,
      cancel: () => {
        cancelled = true
        killTree('SIGTERM')
        // POSIX: 그룹 리더가 SIGTERM을 무시하면 지연 SIGKILL으로 마무리한다
        if (process.platform !== 'win32') {
          setTimeout(() => killTree('SIGKILL'), 2000)
        }
      },
    }
  }
}
