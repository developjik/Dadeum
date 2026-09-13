import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  type AgentProcess,
  augmentedGuiPath,
  buildClaudeArgs,
  ClaudeCodeAdapter,
  resolveClaudeCommand,
} from './claudeCodeAdapter'
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
      'Read,Edit,Write,Glob,Grep',
    ])
  })

  it('세션 id가 있으면 --resume을 붙인다', () => {
    const args = buildClaudeArgs('sess-9')
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-9')
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

  it('취소 시 SIGTERM → 프로세스 닫힘 → cancelled 종단', async () => {
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    const promise = expect(handle.terminal).resolves.toBe('cancelled')
    handle.cancel()
    proc.emitClose(null)
    await promise
    expect(proc.killCalls).toContain('SIGTERM')
  })

  it('타임아웃 시 SIGKILL 후 timeout 종단한다', async () => {
    vi.useFakeTimers()
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws', timeoutMs: 50 })
    const promise = expect(handle.terminal).resolves.toBe('timeout')
    vi.advanceTimersByTime(60)
    await promise
    expect(proc.killCalls).toContain('SIGKILL')
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
