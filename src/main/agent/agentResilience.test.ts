import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentRunHandle } from '../../core/agent/types'
import { SyncStateDb } from '../../core/store/syncState'
import { machineFor } from '../sync/machines'
import { ChatRunService } from './chatService'
import { type AgentProcess, ClaudeCodeAdapter } from './claudeCodeAdapter'

/**
 * 에이전트 복원력 회귀(P0):
 * - 스폰 실패(바이너리/cwd 부재)에서도 terminal이 종결되어 스페이스 락이 풀린다
 * - stream-json 청크 경계에서 잘린 라인이 유실되지 않는다
 * - adapter.start 동기 실패 시 startRun이 락을 즉시 반납한다
 */

interface FakeWithError extends AgentProcess {
  emitError(cause: Error): void
  emitOutRaw(chunk: string): void
  emitClose(code: number | null): void
}

function fakeProcess(): FakeWithError {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const proc = {
    pid: 4242,
    stdin: { write: () => undefined, end: () => undefined },
    stdout: Object.assign(stdoutEmitter, { setEncoding: () => undefined }),
    stderr: Object.assign(stderrEmitter, { setEncoding: () => undefined }),
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener)
    },
    kill: () => undefined,
    emitError(cause: Error) {
      emitter.emit('error', cause)
    },
    emitOutRaw(chunk: string) {
      stdoutEmitter.emit('data', chunk)
    },
    emitClose(code: number | null) {
      emitter.emit('close', code)
    },
  }
  return proc as FakeWithError
}

describe('ClaudeCodeAdapter 복원력', () => {
  it('스폰 error 이벤트에서 terminal이 error로 종결된다(락 데드락 방지)', async () => {
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/없는/경로' })
    const events: string[] = []
    handle.onEvent((event) => events.push(event.type))
    const promise = expect(handle.terminal).resolves.toBe('error')
    proc.emitError(new Error('spawn claude ENOENT'))
    await promise
    expect(events).toContain('error')
  })

  it('청크 경계에서 잘린 JSON 라인도 버퍼링해 파싱한다', async () => {
    const proc = fakeProcess()
    const adapter = new ClaudeCodeAdapter({ spawnImpl: () => proc })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    const texts: string[] = []
    handle.onEvent((event) => {
      if (event.type === 'text') texts.push(event.value)
    })
    proc.emitOutRaw('{"type":"assistant","mess')
    proc.emitOutRaw('age":{"content":[{"type":"text","text":"청크 경계"}]}}\n')
    proc.emitClose(0)
    await expect(handle.terminal).resolves.toBe('completed')
    expect(texts).toEqual(['청크 경계'])
  })

  it('스폰 함수의 동기 예외도 error 종결로 이어진다', async () => {
    const adapter = new ClaudeCodeAdapter({
      spawnImpl: () => {
        throw new Error('invalid cwd')
      },
    })
    const handle = adapter.start({ prompt: 'p', cwd: '/ws' })
    await expect(handle.terminal).resolves.toBe('error')
  })
})

describe('ChatRunService 락 복구', () => {
  it('adapter.start 동기 실패 시 스페이스 락을 즉시 반납한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-lock-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    const service = new ChatRunService()
    const broken: AgentAdapter = {
      name: 'broken',
      start: () => {
        throw new Error('부팅 실패')
      },
    }
    service.registerAdapter(broken)

    const sender = { isDestroyed: () => true } as unknown as WebContents
    expect(() =>
      service.startRun({
        sender,
        adapterName: 'broken',
        spaceKey: 'LOCKX',
        prompt: 'p',
        spaceRoot: root,
        db,
      }),
    ).toThrow(/부팅 실패/)

    // 락이 반납되어 push 등 다음 작업이 가능하다
    expect(machineFor('LOCKX').canStartPush()).toBe(true)
    db.close()
  })

  it('정상 런의 terminal 종결 시에도 락이 반납된다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-lock2-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    const service = new ChatRunService()
    const handleLike: AgentRunHandle = {
      runId: 'run-x',
      onEvent: () => () => undefined,
      terminal: Promise.resolve('completed'),
      cancel: () => undefined,
    }
    service.registerAdapter({ name: 'fake', start: () => handleLike })
    const sender = { isDestroyed: () => true } as unknown as WebContents
    const { runId } = service.startRun({
      sender,
      adapterName: 'fake',
      spaceKey: 'LOCKY',
      prompt: 'p',
      spaceRoot: root,
      db,
    })
    expect(runId).toBe('run-x')
    await handleLike.terminal
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(machineFor('LOCKY').canStartPush()).toBe(true)
    db.close()
  })
})
