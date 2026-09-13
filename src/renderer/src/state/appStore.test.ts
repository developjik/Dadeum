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
let updateEmit: ((payload: unknown) => void) | null = null

/** 스토어의 localStorage 의존(마지막 스페이스 복원)용 인메모리 스텁. */
const localStorageStub = (() => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  }
})()

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
    onUpdateEvent: (listener: (payload: unknown) => void) => {
      updateEmit = listener
    },
  }
  // DOM Window 타입과 무관한 테스트용 브리지 주입(언체크 캐스트 — 테스트 경계)
  const target = globalThis as unknown as { window: unknown }
  target.window = { confluenceLocal: bridge, localStorage: localStorageStub }
  ensureAgentEventSubscription()
})

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async () => ({}))
  localStorageStub.clear()
  useAppStore.setState({
    activeSpaceKey: undefined,
    changeset: null,
    pushOutcome: null,
    diffs: {},
    chatMessages: [],
    selected: null,
    editing: null,
    editLoading: false,
    agentRunning: false,
    activeRunId: undefined,
    error: undefined,
    notice: undefined,
    lastCredentials: undefined,
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
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'push:changeset')
        return { modified: [], added: [], missing: [], attachments: [] }
      return {}
    })
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
      pushOutcome: {
        uploaded: [],
        failed: [],
        conflicts: [],
        deletedAttachments: [],
        skippedRemoteAttachments: [],
      } as unknown as PushOutcome,
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

describe('수동 업데이트 흐름', () => {
  it('확인 → 신규 버전 발견 → 다운로드 진행 → 재시작 상태로 이행한다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'update:check')
        return { status: 'available', currentVersion: '0.1.0', newVersion: '0.2.0' }
      if (channel === 'update:install') return { started: true }
      return {}
    })

    await useAppStore.getState().checkUpdate()
    let state = useAppStore.getState()
    expect(state.updateStatus).toBe('available')
    expect(state.updateNewVersion).toBe('0.2.0')

    await useAppStore.getState().installUpdate()
    state = useAppStore.getState()
    expect(state.updatePhase).toBe('downloading')
    expect(invoke.mock.calls.some(([channel]) => channel === 'update:install')).toBe(true)

    updateEmit?.({ type: 'progress', percent: 42 })
    expect(useAppStore.getState().updateProgress).toBe(42)

    updateEmit?.({ type: 'downloaded', version: '0.2.0' })
    expect(useAppStore.getState().updatePhase).toBe('restarting')
  })

  it('최신 버전이면 안내만 띄운다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'update:check') return { status: 'up-to-date', currentVersion: '0.1.0' }
      return {}
    })

    await useAppStore.getState().checkUpdate()

    const state = useAppStore.getState()
    expect(state.updateStatus).toBe('up-to-date')
    expect(state.notice).toContain('최신')
  })

  it('다운로드 실패 이벤트는 idle로 되돌리고 오류를 표시한다', async () => {
    useAppStore.setState({ updatePhase: 'downloading' })
    updateEmit?.({ type: 'error', message: 'network down' })
    const state = useAppStore.getState()
    expect(state.updatePhase).toBe('idle')
    expect(state.error).toContain('업데이트 실패')
  })
})

describe('변경 감사(리뷰 게이트) 라우팅', () => {
  it('감사 런의 텍스트는 채팅에 섞이지 않고 판정으로 파싱된다', () => {
    useAppStore.setState({ activeSpaceKey: 'A', reviewRunning: true })
    agentEmit?.({
      runId: 'rev-1',
      spaceKey: 'A',
      kind: 'review',
      event: {
        type: 'text',
        value: '```json\n{"files":[{"path":"a/index.md","status":"warn","note":"제목 무관 변경"}]}',
      },
    })
    agentEmit?.({
      runId: 'rev-1',
      spaceKey: 'A',
      kind: 'review',
      event: { type: 'text', value: '\n```\n' },
    })
    agentEmit?.({
      runId: 'rev-1',
      spaceKey: 'A',
      kind: 'review',
      event: { type: 'terminal', state: 'completed' },
    })

    const state = useAppStore.getState()
    expect(state.chatMessages).toHaveLength(0)
    expect(state.reviewRunning).toBe(false)
    expect(state.reviewVerdict?.files[0]?.status).toBe('warn')
    expect(state.reviewVerdict?.files[0]?.note).toContain('무관')
  })

  it('감사 판독 실패는 안내 문구로 떨어진다', () => {
    useAppStore.setState({ activeSpaceKey: 'A', reviewRunning: true })
    agentEmit?.({
      runId: 'rev-2',
      spaceKey: 'A',
      kind: 'review',
      event: { type: 'text', value: '모든 파일이 괜찮아 보입니다.' },
    })
    agentEmit?.({
      runId: 'rev-2',
      spaceKey: 'A',
      kind: 'review',
      event: { type: 'terminal', state: 'completed' },
    })
    expect(useAppStore.getState().reviewVerdict).toBeNull()
    expect(useAppStore.getState().reviewNote).toContain('판독')
  })

  it('편집 런 정상 종료 후 변경이 있으면 감사를 자동 시작한다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'push:changeset')
        return {
          modified: [{ path: 'spaces/A/x/index.md' }],
          added: [],
          missing: [],
          attachments: [],
        }
      if (channel === 'review:run') return { runId: 'rev-3', empty: false }
      return {}
    })
    useAppStore.setState({
      activeSpaceKey: 'A',
      agentRunning: true,
      chatMessages: [
        { role: 'user', text: '가이드 문단 추가해줘' },
        { role: 'assistant', text: '추가했습니다' },
      ],
    })

    agentEmit?.({ runId: 'w-1', spaceKey: 'A', event: { type: 'terminal', state: 'completed' } })

    // loadChangeset → maybeAutoReview → runReview 비동기 체인: 실제 신호(review:run 호출)를
    // 마이크로태스크 플러시로 폴링한다 — 고정 대기가 아니라 조건 충족 시 즉시 반환
    for (let i = 0; i < 50 && !invoke.mock.calls.some(([c]) => c === 'review:run'); i++) {
      await Promise.resolve()
    }

    const reviewCall = invoke.mock.calls.find(([channel]) => channel === 'review:run')
    const payload = reviewCall?.[1] as { spaceKey?: string; instruction?: string }
    expect(payload.spaceKey).toBe('A')
    expect(payload.instruction).toBe('가이드 문단 추가해줘')
    expect(useAppStore.getState().reviewRunning).toBe(true)
  })

  it('변경이 없으면 감사를 시작하지 않는다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'push:changeset')
        return { modified: [], added: [], missing: [], attachments: [] }
      return {}
    })
    useAppStore.setState({ activeSpaceKey: 'A', agentRunning: true })

    agentEmit?.({ runId: 'w-2', spaceKey: 'A', event: { type: 'terminal', state: 'completed' } })
    for (let i = 0; i < 50; i++) {
      await Promise.resolve()
    }

    expect(invoke.mock.calls.some(([channel]) => channel === 'review:run')).toBe(false)
  })
})

describe('직접 편집 세션', () => {
  it('beginEdit은 디스크 원문을 새로 읽어 세션을 만든다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:read')
        return { title: '가이드', url: 'u', version: 2, markdown: '# 본문' }
      return {}
    })

    await useAppStore.getState().beginEdit('spaces/A/p/index.md')

    const editing = useAppStore.getState().editing
    expect(editing).toMatchObject({
      path: 'spaces/A/p/index.md',
      baseline: '# 본문',
      body: '# 본문',
      saving: false,
    })
    expect(useAppStore.getState().editLoading).toBe(false)
  })

  it('다른 문서의 저장 안 된 세션이 있으면 새 편집 시작을 게이트한다', async () => {
    useAppStore.setState({
      editing: { path: 'spaces/A/a/index.md', baseline: 'x', body: '변경됨', saving: false },
    })

    await useAppStore.getState().beginEdit('spaces/A/b/index.md')

    expect(useAppStore.getState().editing?.path).toBe('spaces/A/a/index.md')
    expect(useAppStore.getState().error).toBeTruthy()
    expect(invoke.mock.calls.some(([channel]) => channel === 'pages:read')).toBe(false)
  })

  it('다른 문서 세션이 저장되지 않았더라도 본문이 그대로면 게이트하지 않는다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:read')
        return { title: '가이드', url: 'u', version: 2, markdown: '원문' }
      return {}
    })
    useAppStore.setState({
      editing: { path: 'spaces/A/a/index.md', baseline: 'x', body: 'x', saving: false },
    })

    await useAppStore.getState().beginEdit('spaces/A/b/index.md')

    expect(useAppStore.getState().editing?.path).toBe('spaces/A/b/index.md')
    expect(useAppStore.getState().error).toBeUndefined()
  })

  it('beginEdit 실패 시 로딩이 풀리고 오류가 표시된다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:read') throw new Error('파일 없음')
      return {}
    })

    await useAppStore.getState().beginEdit('spaces/A/p/index.md')

    expect(useAppStore.getState().editing).toBeNull()
    expect(useAppStore.getState().editLoading).toBe(false)
    expect(useAppStore.getState().error).toContain('편집할 문서를 불러오지 못했습니다')
  })

  it('saveEdit은 pages:write 후 세션을 정리하고 미리보기·changeset을 갱신한다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:write')
        return { pageId: '1', title: '가이드', url: 'u', version: 2, markdown: '새 본문' }
      if (channel === 'push:changeset')
        return { modified: [], added: [], missing: [], attachments: [] }
      return {}
    })
    useAppStore.setState({
      activeSpaceKey: 'A',
      selected: {
        path: 'spaces/A/a/index.md',
        title: '가이드',
        url: 'u',
        version: 2,
        html: '<p>old</p>',
      },
      editing: { path: 'spaces/A/a/index.md', baseline: 'old', body: '새 본문', saving: false },
    })

    await useAppStore.getState().saveEdit()

    const state = useAppStore.getState()
    expect(state.editing).toBeNull()
    expect(state.selected?.html).toContain('새 본문')
    expect(state.notice).toBeTruthy()
    expect(
      invoke.mock.calls.some(
        ([channel, payload]) =>
          channel === 'pages:write' && (payload as { body?: string }).body === '새 본문',
      ),
    ).toBe(true)
    expect(
      invoke.mock.calls.some(
        ([channel, payload]) => channel === 'push:changeset' && spaceKeyOf(payload) === 'A',
      ),
    ).toBe(true)
  })

  it('saveEdit 실패 시 세션과 입력을 보존해 재시도할 수 있게 한다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:write') throw new Error('캐리어 무결성 검증 실패')
      return {}
    })
    useAppStore.setState({
      activeSpaceKey: 'A',
      editing: { path: 'spaces/A/a/index.md', baseline: 'old', body: '초안', saving: false },
    })

    await useAppStore.getState().saveEdit()

    const editing = useAppStore.getState().editing
    expect(editing).toMatchObject({ path: 'spaces/A/a/index.md', body: '초안', saving: false })
    expect(useAppStore.getState().error).toContain('캐리어 무결성')
  })

  it('cancelEdit은 세션을 버린다(확인 UI는 컴포넌트가 담당)', () => {
    useAppStore.setState({
      editing: { path: 'spaces/A/a/index.md', baseline: 'x', body: '변경됨', saving: false },
    })

    useAppStore.getState().cancelEdit()

    expect(useAppStore.getState().editing).toBeNull()
  })

  it('연결 해제 시 편집 세션도 정리된다', async () => {
    useAppStore.setState({
      editing: { path: 'spaces/A/a/index.md', baseline: 'x', body: '변경됨', saving: false },
    })

    await useAppStore.getState().disconnect()

    expect(useAppStore.getState().editing).toBeNull()
  })

  it('beginEdit 응답 경쟁 — 늦은 응답이 최종 세션을 덜어쓰지 않는다', async () => {
    interface PageReadResult {
      title: string
      url: string
      version: number
      markdown: string
    }
    const slow = Promise.withResolvers<PageReadResult>()
    const fast: PageReadResult = { title: 'fast', url: 'u', version: 1, markdown: 'fast 본문' }
    invoke.mockImplementation(async (_channel: string, payload?: unknown) =>
      pathOf(payload) === 'spaces/A/slow/index.md' ? slow.promise : fast,
    )

    const first = useAppStore.getState().beginEdit('spaces/A/slow/index.md')
    const second = useAppStore.getState().beginEdit('spaces/A/fast/index.md')
    await second
    slow.resolve({ title: 'slow', url: 'u', version: 1, markdown: 'slow 본문' })
    await first

    expect(useAppStore.getState().editing?.body).toBe('fast 본문')
  })
})

describe('시작 복원(재실행 시 온보딩 반복 방지)', () => {
  const space = { id: '1', key: 'A', name: 'Alpha' }
  const emptyChangeset = { modified: [], added: [], missing: [], attachments: [] }

  function mockConnectedLaunch(spaces: unknown[]): void {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'auth:status')
        return { connected: true, baseUrl: 'https://x.atlassian.net', email: 'a@b.c' }
      if (channel === 'spaces:list') return { spaces }
      if (channel === 'pages:tree') return { tree: [] }
      if (channel === 'conflict:list') return { candidates: [] }
      if (channel === 'push:changeset') return emptyChangeset
      return {}
    })
  }

  it('selectSpace는 마지막 선택을 localStorage에 기록한다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pages:tree') return { tree: [] }
      if (channel === 'conflict:list') return { candidates: [] }
      if (channel === 'push:changeset') return emptyChangeset
      return {}
    })

    await useAppStore.getState().selectSpace('A')

    expect(localStorageStub.getItem('space.last')).toBe('A')
  })

  it('refreshStatus는 연결 시 마지막 스페이스를 복원한다', async () => {
    localStorageStub.setItem('space.last', 'A')
    mockConnectedLaunch([space])

    await useAppStore.getState().refreshStatus()

    expect(useAppStore.getState().activeSpaceKey).toBe('A')
    expect(
      invoke.mock.calls.some(
        ([channel, payload]) => channel === 'pages:tree' && spaceKeyOf(payload) === 'A',
      ),
    ).toBe(true)
  })

  it('마지막 스페이스가 목록에 없으면 선택하지 않는다', async () => {
    localStorageStub.setItem('space.last', 'GONE')
    mockConnectedLaunch([space])

    await useAppStore.getState().refreshStatus()

    expect(useAppStore.getState().activeSpaceKey).toBeUndefined()
    expect(invoke.mock.calls.some(([channel]) => channel === 'pages:tree')).toBe(false)
  })

  it('토큰 복호화 실패 상태는 주소·이메일 프리필을 남긴다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'auth:status')
        return {
          connected: false,
          baseUrl: 'https://x.atlassian.net',
          email: 'a@b.c',
          reason: 'token-decrypt-failed',
        }
      return {}
    })

    await useAppStore.getState().refreshStatus()

    expect(useAppStore.getState().status).toBe('disconnected')
    expect(useAppStore.getState().lastCredentials).toEqual({
      baseUrl: 'https://x.atlassian.net',
      email: 'a@b.c',
    })
  })

  it('저장된 자격증명 자체가 없으면 프리필도 없다', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'auth:status') return { connected: false }
      return {}
    })

    await useAppStore.getState().refreshStatus()

    expect(useAppStore.getState().lastCredentials).toBeUndefined()
  })

  it('연결 성공·수동 해제 모두 프리필을 지운다', async () => {
    useAppStore.setState({
      lastCredentials: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c' },
    })

    await useAppStore.getState().disconnect()

    expect(useAppStore.getState().lastCredentials).toBeUndefined()
  })
})
