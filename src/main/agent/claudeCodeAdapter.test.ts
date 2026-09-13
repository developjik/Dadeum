import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  type AgentProcess,
  augmentedGuiPath,
  buildClaudeArgs,
  ClaudeCodeAdapter,
  resolveClaudeCommand,
} from './claudeCodeAdapter'
import type { SpawnFn } from './cliProcessRun'
import { parseStreamJsonLine, parseStreamJsonLines } from './streamJson'

interface FakeProcess extends AgentProcess {
  emitOut(line: string): void
  emitErr(line: string): void
  emitClose(code: number | null): void
  killCalls: string[]
}

/** stdout/stderr/close를 수동으로 구동하는 가짜 프로세스. */
function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const proc = {
    pid: 4242,
    killCalls: [] as string[],
    stdin: { write: () => undefined, end: () => undefined },
    stdout: Object.assign(stdoutEmitter, { setEncoding: () => undefined }),
    stderr: Object.assign(stderrEmitter, { setEncoding: () => undefined }),
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener as (code: number | null) => void)
    },
    kill(signal?: string) {
      proc.killCalls.push(signal ?? 'SIGTERM')
      if (signal === 'SIGKILL') queueMicrotask(() => emitter.emit('close', null))
    },
    emitOut(line: string) {
      stdoutEmitter.emit('data', `${line}\n`)
    },
    emitErr(line: string) {
      stderrEmitter.emit('data', `${line}\n`)
    },
    emitClose(code: number | null) {
      emitter.emit('close', code)
    },
  }
  return proc as FakeProcess
}

interface SpawnRecorder {
  impl: SpawnFn
  proc: FakeProcess
  /** 스폰된 커맨드 기록 — win32의 kill-tree는 taskkill 스폰으로 구현된다 */
  commands: string[]
}

/** 커맨드를 기록하는 스폰 주입 — kill-tree의 플랫폼 분기(win: taskkill / POSIX: signal) 검증용. */
function recordingSpawn(proc: FakeProcess): SpawnRecorder {
  const commands: string[] = []
  return {
    proc,
    commands,
    impl: (command, _args, _options) => {
      commands.push(command)
      return proc
    },
  }
}

/** graceful kill 검증 — win32는 taskkill 스폰, POSIX는 SIGTERM(그룹 kill 실패 시 child.kill). */
function expectGracefulKill(spawn: SpawnRecorder): void {
  if (process.platform === 'win32') {
    expect(spawn.commands).toContain('taskkill')
  } else {
    expect(spawn.proc.killCalls).toContain('SIGTERM')
  }
}

describe('buildClaudeArgs', () => {
  it('헤드리스 인자를 구성한다(계획 §8.5) — 프롬프트는 stdin 경유', () => {
    const args = buildClaudeArgs(undefined)
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Glob,Grep,Edit,Write',
    ])
  })

  it('세션 id가 있으면 --resume을 붙인다', () => {
    const args = buildClaudeArgs('sess-9')
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-9')
  })
  it('spaceRoot를 주면 쓰기 도구가 스페이스 루트로 스코프된다', () => {
    const args = buildClaudeArgs(undefined, '/ws/DEV')
    const allowed = args[args.indexOf('--allowedTools') + 1]
    expect(allowed).toBe('Read,Glob,Grep,Edit(//ws/DEV/**),Write(//ws/DEV/**)')
  })
  it('읽기 전용 런은 쓰기 도구 없이 세션 resume도 하지 않는다', () => {
    const args = buildClaudeArgs('sess-9', '/ws/DEV', true)
    const allowed = args[args.indexOf('--allowedTools') + 1]
    expect(allowed).toBe('Read,Glob,Grep')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--permission-mode')
  })
})

describe('resolveClaudeCommand / augmentedGuiPath', () => {
  it('존재하는 후보 경로를 반환한다', () => {
    expect(
      resolveClaudeCommand(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'], (p) =>
        p.includes('homebrew'),
      ),
    ).toBe('/opt/homebrew/bin/claude')
  })

  it('후보가 없으면 PATH 위임(claude)으로 폴백한다', () => {
    expect(resolveClaudeCommand([], () => false)).toBe('claude')
  })

  it('GUI PATH에 후보 디렉터리를 보강한다', () => {
    const path = augmentedGuiPath('/usr/bin')
    expect(path).toContain('/opt/homebrew/bin')
    expect(path.split(':')).toContain('/usr/bin')
  })
})

describe('parseStreamJsonLine', () => {
  it('init 라인에서 세션 id를 추출한다', () => {
    const events = parseStreamJsonLine('{"type":"system","subtype":"init","session_id":"sess-1"}')
    expect(events).toEqual([{ type: 'started', sessionId: 'sess-1' }])
  })

  it('assistant 텍스트와 도구 사용을 분해한다', () => {
    const events = parseStreamJsonLines([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"수정 중"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}',
      '부분 출력(무시)',
      '',
    ])
    expect(events).toEqual([
      { type: 'text', value: '수정 중' },
      { type: 'tool', name: 'Edit' },
    ])
  })
})

describe('ClaudeCodeAdapter 계약', () => {
  it('스폰 인자·cwd가 계약대로이고 스트림 이벤트가 흐른다', async () => {
    let captured: { command: string; args: string[]; options: { cwd: string } } | undefined
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({
      spawnImpl: (command, args, options) => {
        captured = { command, args, options }
        return proc
      },
    })

    const events: string[] = []
    const handle = adapter.start({ prompt: '페이지 수정', cwd: '/ws/DEV' })
    handle.onEvent((event) => events.push(event.type))
    proc.emitOut('{"type":"system","subtype":"init","session_id":"sess-7"}')
    proc.emitOut('{"type":"assistant","message":{"content":[{"type":"text","text":"완료"}]}}')
    proc.emitClose(0)

    await expect(handle.terminal).resolves.toBe('completed')
    expect(captured?.command).toBe('claude')
    expect(captured?.options.cwd).toBe('/ws/DEV')
    expect(events).toContain('started')
    expect(events).toContain('text')
  })

  it('프롬프트가 stdin으로 전달된다', async () => {
    let stdinWritten: string | undefined
    const proc = fakeProcess()
    ;(proc as unknown as { stdin: { write(chunk: string): void; end(): void } }).stdin = {
      write: (chunk: string) => {
        stdinWritten = chunk
      },
      end: () => undefined,
    }
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'stdin 프롬프트', cwd: '/ws' })
    handle.onEvent(() => undefined)
    proc.emitClose(0)
    await expect(handle.terminal).resolves.toBe('completed')
    expect(stdinWritten).toBe('stdin 프롬프트')
  })

  it('취소 시 종료 신호 → 프로세스 닫힘 → cancelled 종단', async () => {
    const spawn = recordingSpawn(fakeProcess())
    const adapter = new ClaudeCodeAdapter({ spawnImpl: spawn.impl })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    const promise = expect(handle.terminal).resolves.toBe('cancelled')
    handle.cancel()
    spawn.proc.emitClose(null)
    await promise
    expectGracefulKill(spawn)
  })

  it('타임아웃 시 정상 종료 신호 → 2초 후 강제 종료, timeout 종단한다(부분 쓰기 정리 기회)', async () => {
    vi.useFakeTimers()
    const spawn = recordingSpawn(fakeProcess())
    const adapter = new ClaudeCodeAdapter({ spawnImpl: spawn.impl })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws', timeoutMs: 50 })
    const promise = expect(handle.terminal).resolves.toBe('timeout')
    vi.advanceTimersByTime(60)
    // 1단계 정상 종료: CLI가 진행 중 편집을 안전하게 마무리할 기회
    expectGracefulKill(spawn)
    vi.advanceTimersByTime(2000)
    await promise
    // 2단계 강제 종료까지 정확히 2회 — win32는 taskkill 스폰 2회, POSIX는 SIGTERM→SIGKILL
    if (process.platform === 'win32') {
      expect(spawn.commands.filter((command) => command === 'taskkill')).toHaveLength(2)
    } else {
      expect(spawn.proc.killCalls).toEqual(['SIGTERM', 'SIGKILL'])
    }
    vi.useRealTimers()
  })

  it('0이 아닌 종료 코드는 error 종단이다', async () => {
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    const promise = expect(handle.terminal).resolves.toBe('error')
    proc.emitClose(1)
    await promise
  })
})

describe('동시 런·stdin 안전(P1)', () => {
  it('이후 런 시작 후 이전 런의 cancel이 다른 프로세스를 죽리지 않는다', async () => {
    const spawnA = recordingSpawn(fakeProcess())
    const spawnB = recordingSpawn(fakeProcess())
    const adapter = new ClaudeCodeAdapter({
      spawnImpl: (command, args, options) =>
        options.cwd === '/ws/A'
          ? spawnA.impl(command, args, options)
          : spawnB.impl(command, args, options),
    })
    const handleA = adapter.start({ prompt: 'a', cwd: '/ws/A' })
    const handleB = adapter.start({ prompt: 'b', cwd: '/ws/B' })

    handleA.cancel()

    expectGracefulKill(spawnA)
    // B는 최초 스폰 외에 어떤 종료 시도도 받지 않는다
    if (process.platform === 'win32') {
      expect(spawnB.commands).toHaveLength(1)
    } else {
      expect(spawnB.proc.killCalls).toHaveLength(0)
    }

    spawnA.proc.emitClose(null)
    spawnB.proc.emitClose(0)
    await expect(handleA.terminal).resolves.toBe('cancelled')
    await expect(handleB.terminal).resolves.toBe('completed')
  })

  it('stdin에 error 리스너를 등록한다(EPIPE 미처리 예외 방지)', async () => {
    const registered: string[] = []
    const proc = fakeProcess()
    ;(proc as unknown as { stdin: unknown }).stdin = {
      write: () => undefined,
      end: () => undefined,
      on: (event: string) => {
        registered.push(event)
      },
    }
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    proc.emitClose(0)

    await expect(handle.terminal).resolves.toBe('completed')
    expect(registered).toContain('error')
  })
})
