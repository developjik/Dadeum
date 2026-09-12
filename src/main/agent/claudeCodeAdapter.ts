import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  type AgentAdapter,
  type AgentRunEvent,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTerminalState
} from '../../core/agent/types'
import { parseStreamJsonLine } from './streamJson'

/** 테스트 주입을 위한 최소 프로세스 표면(node ChildProcess와 호환). */
export interface AgentProcess {
  pid?: number
  stdin: { write(chunk: string): void; end(): void }
  stdout: { setEncoding(enc: string): void; on(event: 'data', listener: (chunk: string) => void): void }
  stderr: { setEncoding(enc: string): void; on(event: 'data', listener: (chunk: string) => void): void }
  on(event: 'close', listener: (code: number | null) => void): void
  kill(signal?: NodeJS.Signals | number): unknown
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
) => AgentProcess

/** macOS GUI 런치 환경 PATH 보완용 후보 경로(F-10). */
export const GUI_PATH_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function resolveClaudeCommand(
  candidates: string[] = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  exists: (p: string) => boolean = (p) => existsSync(p)
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

export function buildClaudeArgs(sessionId: string | undefined): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep']
  if (sessionId) args.push('--resume', sessionId)
  return args // 프롬프트는 stdin으로 전달
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code'

  private readonly spawnImpl: SpawnFn
  private activeChild: AgentProcess | null = null

  constructor(options?: { spawnImpl?: SpawnFn }) {
    this.spawnImpl = options?.spawnImpl ?? ((command, args, opts) => nodeSpawn(command, args, opts))
  }

  start(request: AgentRunRequest): AgentRunHandle {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const listeners = new Set<(event: AgentRunEvent) => void>()
    let cancelled = false
    let timedOut = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

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
      const child = this.spawnImpl(command, buildClaudeArgs(request.sessionId), {
        cwd: request.cwd,
        env,
        detached: process.platform === 'darwin'
      })
      this.activeChild = child
      emit({ type: 'started', pid: child.pid })
      // 프롬프트는 stdin으로 전달(claude -p는 stdin/positional 양쪽 지원, 파이프 환경에서 stdin이 안전)
      child.stdin.write(request.prompt)
      child.stdin.end()

      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, request.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          for (const event of parseStreamJsonLine(line)) emit(event)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        const trimmed = chunk.trim()
        if (trimmed.length > 0) emit({ type: 'error', message: trimmed })
      })
      child.on('close', (code: number | null) => {
        if (cancelled) settle('cancelled')
        else if (timedOut) settle('timeout')
        else if (code === 0) settle('completed')
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
        const child = this.activeChild
        if (!child) return
        if (process.platform === 'win32') {
          // Windows: 프로세스 트리 종료(§8.5)
          this.spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid ?? 0)], {
            cwd: request.cwd,
            env: process.env,
            detached: false
          })
          return
        }
        // POSIX: detached 프로세스 그룹 대상 SIGTERM → 지연 SIGKILL
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            child.kill('SIGTERM')
          }
          setTimeout(() => {
            try {
              if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
            } catch {
              /* 이미 종료됨 */
            }
          }, 2000)
        }
      }
    }
  }
}
