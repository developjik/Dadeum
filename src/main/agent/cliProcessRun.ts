import type { AgentRunEvent, AgentRunHandle, AgentTerminalState } from '../../core/agent/types'

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

export interface StartCliRunOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  spawnImpl: SpawnFn
  /** 프롬프트 전달 — stdin(파이프 안전, claude -p) 또는 positional 인자(pi --mode json). */
  prompt: { via: 'stdin'; text: string } | { via: 'arg'; text: string }
  /** stdout 한 줄 → 정규화 이벤트(관대한 파서 — 알 수 없는 줄은 빈 배열). */
  parseLine: (line: string) => AgentRunEvent[]
  /** result 레코드가 실행 실패를 보고했는지(exit code와 무관한 error 종단 판정). */
  isResultError: (event: AgentRunEvent) => boolean
}

/**
 * CLI 에이전트 런의 공용 생명주기 — 어댑터(claude·pi…)가 프로토콜 파싱만 제공하면
 * 스폰·kill-tree·타임아웃·라인 버퍼·종단 판정을 동일하게 수행한다.
 * 계약: terminal은 반드시 종결된다(스폰 실패·출력 폭주 포함) — 스페이스 락 회수 의존.
 */
export function startCliRun(options: StartCliRunOptions): AgentRunHandle {
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
      options.spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid ?? 0)], {
        cwd: options.cwd,
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

    const args = [...options.args]
    if (options.prompt.via === 'arg') args.push(options.prompt.text)
    let child: AgentProcess
    try {
      child = options.spawnImpl(options.command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform === 'darwin',
      })
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
    if (options.prompt.via === 'stdin') {
      child.stdin.write(options.prompt.text)
    }
    child.stdin.end()

    timer = setTimeout(() => {
      timedOut = true
      // cancel과 동일하게 SIGTERM → 2초 후 SIGKILL. 즉시 SIGKILL하면 CLI가
      // 편집 중이던 파일을 반쯤 쓴 상태로 남길 수 있다(정리 기회를 준다).
      killTree('SIGTERM')
      setTimeout(() => killTree('SIGKILL'), 2000)
    }, options.timeoutMs)

    // 바이너리 부재·cwd 부재 등은 'error' 이벤트로만 arrive하고 close가 오지 않는다.
    // 처리하지 않으면 terminal이 영원히 미해결되어 스페이스가 agent-run 잠금 상태로 남는다.
    child.on('error', (cause: Error) => {
      emit({ type: 'error', message: `에이전트 실행 실패: ${cause.message}` })
      settle('error')
    })

    // json 모드는 줄 단위 프로토콜 — 청크 경계에서 잘린 라인은 버퍼링해야 파싱된다.
    let lineBuffer = ''
    const consume = (line: string): void => {
      for (const event of options.parseLine(line)) {
        if (options.isResultError(event)) resultError = true
        emit(event)
      }
    }
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
      for (const line of lines) consume(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const trimmed = chunk.trim()
      if (trimmed.length > 0) emit({ type: 'error', message: trimmed })
    })
    child.on('close', (code: number | null) => {
      // 잔여 버퍼 플러시(마지막 줄이 개행 없이 끝나는 경우)
      if (lineBuffer.trim().length > 0) {
        consume(lineBuffer)
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
