import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { type AgentProcess, buildPiArgs, PiAdapter, resolvePiCommand } from './piAdapter'
import { PiJsonParser } from './piJson'

interface FakeProcess extends AgentProcess {
  emitOut(line: string): void
  emitClose(code: number | null): void
}

/** stdout/close를 수동으로 구동하는 가짜 프로세스(claudeCodeAdapter.test와 동일한 계약). */
function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const proc = {
    pid: 7171,
    stdin: { write: () => undefined, end: () => undefined },
    stdout: Object.assign(stdoutEmitter, { setEncoding: () => undefined }),
    stderr: Object.assign(stderrEmitter, { setEncoding: () => undefined }),
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener as (code: number | null) => void)
    },
    kill: () => undefined,
    emitOut(line: string) {
      stdoutEmitter.emit('data', `${line}\n`)
    },
    emitClose(code: number | null) {
      emitter.emit('close', code)
    },
  }
  return proc as FakeProcess
}

describe('buildPiArgs', () => {
  it('json 모드 + 도구 allowlist로 인자를 구성한다 — 프롬프트는 positional', () => {
    expect(buildPiArgs(undefined)).toEqual(['--mode', 'json', '-t', 'read,grep,find,ls,edit,write'])
  })

  it('bash는 쓰기 도구 세트에도 포함하지 않는다(워크스페이스 밖 임의 실행 차단)', () => {
    expect(buildPiArgs(undefined).join(',')).not.toContain('bash')
  })

  it('세션 id가 있으면 --resume을 붙인다', () => {
    const args = buildPiArgs('sess-9')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-9')
  })

  it('읽기 전용 런은 쓰기 도구 없이 세션 resume도 하지 않는다', () => {
    const args = buildPiArgs('sess-9', true)
    expect(args[args.indexOf('-t') + 1]).toBe('read,grep,find,ls')
    expect(args).not.toContain('--resume')
  })
})

describe('resolvePiCommand', () => {
  it('존재하는 후보 경로를 반환한다', () => {
    expect(resolvePiCommand(['/opt/homebrew/bin/pi'], (p) => p.includes('homebrew'))).toBe(
      '/opt/homebrew/bin/pi',
    )
  })

  it('후보가 없으면 PATH 위임(pi)으로 폴백한다', () => {
    expect(resolvePiCommand([], () => false)).toBe('pi')
  })
})

describe('PiJsonParser(pi --mode json 계약)', () => {
  it('session 헤더에서 세션 id를 추출한다', () => {
    const parser = new PiJsonParser()
    const events = parser.feed('{"type":"session","version":3,"id":"uuid-1","cwd":"/ws"}')
    expect(events).toEqual([{ type: 'started', sessionId: 'uuid-1' }])
  })

  it('text_delta는 순차 스트리밍되고 message_end 스냅샷은 중복 발행하지 않는다', () => {
    const parser = new PiJsonParser()
    const events = [
      ...parser.feed('{"type":"message_start","message":{"role":"assistant","content":[]}}'),
      ...parser.feed(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"안녕"}}',
      ),
      ...parser.feed(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"하세요"}}',
      ),
      ...parser.feed(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"안녕하세요"}]}}',
      ),
    ]
    expect(events).toEqual([
      { type: 'text', value: '안녕' },
      { type: 'text', value: '하세요' },
    ])
  })

  it('델타가 없으면(스트리밍 없는 프로바이더) message_end 스냅샷으로 본문을 낸다', () => {
    const parser = new PiJsonParser()
    parser.feed('{"type":"message_start","message":{"role":"assistant","content":[]}}')
    const events = parser.feed(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"완료"}]}}',
    )
    expect(events).toEqual([{ type: 'text', value: '완료' }])
  })

  it('도구 실행 시작을 tool 이벤트로, 종료를 result로 보고한다', () => {
    const parser = new PiJsonParser()
    expect(
      parser.feed('{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{}}'),
    ).toEqual([{ type: 'tool', name: 'edit' }])
    const result = parser.feed('{"type":"agent_end","messages":[]}')
    expect(result).toEqual([{ type: 'result', isError: false, value: undefined }])
  })

  it('result 값은 마지막 assistant 본문 스냅샷이다(감사 판정 소비용)', () => {
    const parser = new PiJsonParser()
    parser.feed('{"type":"message_start","message":{"role":"assistant","content":[]}}')
    parser.feed(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"델타"}}',
    )
    parser.feed(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"판정 JSON"}]}}',
    )
    expect(parser.feed('{"type":"agent_end","messages":[]}')).toEqual([
      { type: 'result', isError: false, value: '판정 JSON' },
    ])
  })

  it('알 수 없는 이벤트·비 JSON 줄은 조용히 무시한다', () => {
    const parser = new PiJsonParser()
    expect(parser.feed('{"type":"queue_update","queues":{}}')).toEqual([])
    expect(parser.feed('{"type":"compaction_start"}')).toEqual([])
    expect(parser.feed('부분 출력')).toEqual([])
    expect(parser.feed('')).toEqual([])
  })
})

describe('PiAdapter 계약', () => {
  it('스폰 인자(마지막 positional 프롬프트)·cwd·이벤트 흐름이 계약대로다', async () => {
    let captured: { command: string; args: string[]; options: { cwd: string } } | undefined
    const proc = fakeProcess()
    const adapter = new PiAdapter({
      spawnImpl: (command, args, options) => {
        captured = { command, args, options }
        return proc
      },
    })

    const events: string[] = []
    const handle = adapter.start({ prompt: '페이지 수정', cwd: '/ws/DEV' })
    handle.onEvent((event) => events.push(event.type))
    proc.emitOut('{"type":"session","version":3,"id":"uuid-9","cwd":"/ws/DEV"}')
    proc.emitOut(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"수정 중"}}',
    )
    proc.emitOut('{"type":"agent_end","messages":[]}')
    proc.emitClose(0)

    await expect(handle.terminal).resolves.toBe('completed')
    expect(captured?.command).toBe('pi')
    expect(captured?.options.cwd).toBe('/ws/DEV')
    // 프롬프트는 positional 인자(claude와 달리 stdin이 아니다)
    expect(captured?.args[captured.args.length - 1]).toBe('페이지 수정')
    expect(captured?.args).toContain('--mode')
    expect(events).toContain('started')
    expect(events).toContain('text')
    expect(events).toContain('result')
  })

  it('기능 협상: resume·스트리밍 지원, 쓰기 경로 스코핑은 미지원', () => {
    const adapter = new PiAdapter()
    const caps = adapter.capabilities()
    expect(caps.supportsResume).toBe(true)
    expect(caps.supportsJsonReview).toBe(true)
    expect(caps.supportsScopedWrite).toBe(false)
  })
})
