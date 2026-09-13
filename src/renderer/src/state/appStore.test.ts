import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeSet } from '../../../core/push/changeSet'
import type { PushOutcome } from '../../../core/push/types'
import { ensureAgentEventSubscription, useAppStore } from './appStore'

/**
 * 스페이스 간 상태 오염·응답 경쟁 회귀(P1 렌더러 3건).
 * preload 브리지를 목으로 대체해 store 동작만 검증한다.
 */
const invoke = vi.fn(async (_channel: string, _payload?: unknown): Promise<unknown> => ({}))
let agentEmit: ((payload: unknown) => void) | null = null

function spaceKeyOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'spaceKey' in payload
    ? payload.spaceKey
    : undefined
}

function pathOf(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && 'path' in payload
    ? payload.path
    : undefined
}

beforeAll(() => {
  const bridge = {
    invoke: (channel: string, payload?: unknown) => invoke(channel, payload),
    onAgentEvent: (listener: (payload: unknown) => void) => {
      agentEmit = listener
      return () => undefined
    },
    onSyncEvent: () => () => undefined,
  }
  // DOM Window 타입과 무관한 테스트용 브리지 주입(언체크 캐스트 — 테스트 경계)
  const target = globalThis as unknown as { window: unknown }
  target.window = { confluenceLocal: bridge }
  ensureAgentEventSubscription()
})

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => ({}))
  useAppStore.setState({
    activeSpaceKey: undefined,
    changeset: null,
    pushOutcome: null,
    diffs: {},
    chatMessages: [],
    selected: null,
    agentRunning: false,
    activeRunId: undefined,
    error: undefined,
    notice: undefined,
  })
})

describe('에이전트 terminal 이벤트 스페이스 격리', () => {
  it('비활성 스페이스의 런 종료는 changeset을 다시 불러오지 않는다', () => {
    useAppStore.setState({ activeSpaceKey: 'B' })
    agentEmit?.({ runId: 'r1', spaceKey: 'A', event: { type: 'terminal', state: 'completed' } })

    expect(invoke.mock.calls.some(([channel]) => channel === 'push:changeset')).toBe(false)
    expect(useAppStore.getState().chatMessages).toHaveLength(0)
    expect(useAppStore.getState().agentRunning).toBe(false)
  })

  it('활성 스페이스의 런 종료는 안내 문구와 changeset 재검사를 수행한다', () => {
    useAppStore.setState({ activeSpaceKey: 'B', agentRunning: true, activeRunId: 'r2' })
    agentEmit?.({ runId: 'r2', spaceKey: 'B', event: { type: 'terminal', state: 'completed' } })

    expect(invoke.mock.calls.some(([channel]) => channel === 'push:changeset')).toBe(true)
    expect(useAppStore.getState().chatMessages).toHaveLength(1)
  })
})

describe('selectSpace 검토 상태 리셋', () => {
  it('이전 스페이스의 changeset·pushOutcome·diffs를 지우고 새 스페이스를 불러온다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:tree') return { tree: [] }
      if (channel === 'conflict:list') return { candidates: [] }
      if (channel === 'push:changeset')
        return { modified: [], added: [], missing: [], attachments: [] }
      return {}
    })
    useAppStore.setState({
      activeSpaceKey: 'A',
      changeset: { modified: [{ path: 'a' }] } as unknown as ChangeSet,
      pushOutcome: { uploaded: [], failed: [], conflicts: [] } as unknown as PushOutcome,
      diffs: { 'spaces/A/x/index.md': [] },
    })

    await useAppStore.getState().selectSpace('B')

    const state = useAppStore.getState()
    expect(state.activeSpaceKey).toBe('B')
    expect(state.pushOutcome).toBeNull()
    expect(state.diffs).toEqual({})
    expect(
      invoke.mock.calls.some(
        ([channel, payload]) => channel === 'push:changeset' && spaceKeyOf(payload) === 'B',
      ),
    ).toBe(true)
  })
})

describe('openPage 응답 경쟁 가드', () => {
  it('늦게 완료된 이전 요청이 최종 선택을 덮어쓰지 않는다', async () => {
    interface PageReadResult {
      title: string
      url: string
      version: number
      markdown: string
    }
    // 느린 요청은 수동으로 완료시킨다(결정적 경쟁 — 실제 타이머 없음)
    const slow = Promise.withResolvers<PageReadResult>()
    const fast: PageReadResult = { title: 'fast', url: 'u', version: 1, markdown: '# fast' }
    invoke.mockImplementation(async (_channel: string, payload?: unknown) =>
      pathOf(payload) === 'spaces/A/slow/index.md' ? slow.promise : fast,
    )

    const first = useAppStore.getState().openPage('spaces/A/slow/index.md')
    const second = useAppStore.getState().openPage('spaces/B/fast/index.md')
    await second
    slow.resolve({ title: 'slow', url: 'u', version: 1, markdown: '# slow' })
    await first

    expect(useAppStore.getState().selected?.path).toBe('spaces/B/fast/index.md')
  })
})
