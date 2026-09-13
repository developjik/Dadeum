import { create } from 'zustand'
import type { AgentRunEvent } from '../../../core/agent/types'
import type { ConfluenceSpace } from '../../../core/confluence/types'
import { ko } from '../../../core/i18n/ko'
import { renderPreviewHtml } from '../../../core/preview/render'
import type { ChangeSet } from '../../../core/push/changeSet'
import type { LineChange } from '../../../core/push/diff'
import type { PushOutcome } from '../../../core/push/types'
import { parseReviewVerdict, type ReviewVerdict } from '../../../core/review/verdict'
import type { PageTreeNode } from '../../../core/store/tree'
import type { UpdateCheckOutcome } from '../../../core/updater/types'

type AuthStatus = 'loading' | 'disconnected' | 'connected'

export interface SelectedPage {
  path: string
  title: string
  url: string
  version: number
  html: string
}

/** 폴링 결과 알림(main → sync:event). */
interface SyncPollEvent {
  type: 'poll'
  spaceKey: string
  updated: number
  skippedDirty: number
  tombstoned: number
  failed?: number
}

interface AppUiState {
  status: AuthStatus
  baseUrl?: string
  email?: string
  spaces: ConfluenceSpace[]
  tree: PageTreeNode[]
  selected: SelectedPage | null
  error?: string
  /** 자동으로 사라지는 성공·동기화 알림 */
  notice?: string
  busy: boolean
  syncingSpace?: string
  syncingProgress?: { spaceKey: string; done: number; total: number }
  activeSpaceKey?: string
  chatMessages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>
  agentRunning: boolean
  activeRunId?: string
  /** agent:run IPC 왕복이 진행 중이다(왕복 내 중지 요청은 플래그로 큐잉). */
  agentStarting: boolean
  /** 시작 왕복 중 눌린 중지 — runId 수령 즉시 agent:cancel로 소비한다. */
  agentStartAborted: boolean
  /** 수동 업데이트 상태(버튼 확인 → 설치 → 재시작). */
  updateStatus: 'idle' | 'checking' | 'available' | 'up-to-date' | 'unavailable'
  updateNewVersion?: string
  updatePhase: 'idle' | 'downloading' | 'restarting'
  updateProgress?: number
  changeset: ChangeSet | null
  pushOutcome: PushOutcome | null
  /** 변경 감사(읽기 전용 리뷰 런) 상태 — 검토 패널에 표시된다. */
  reviewRunning: boolean
  reviewVerdict: ReviewVerdict | null
  reviewNote?: string
  conflicts: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }>
  diffs: Record<string, LineChange[]>

  refreshStatus: () => Promise<void>
  dismissError: () => void
  connect: (siteUrl: string, email: string, apiToken: string) => Promise<void>
  disconnect: () => Promise<void>
  pullSpace: (spaceKey: string) => Promise<void>
  cancelPull: (spaceKey: string) => Promise<void>
  loadSpaces: () => Promise<void>
  installUpdate: () => Promise<void>
  runReview: (spaceKey: string, instruction: string) => Promise<void>
  loadTree: (spaceKey: string) => Promise<void>
  openPage: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  cancelAgent: () => Promise<void>
  checkUpdate: () => Promise<void>
  selectSpace: (spaceKey: string) => Promise<void>
  sendChat: (prompt: string) => Promise<void>
  loadChangeset: (spaceKey: string) => Promise<void>
  approveUpload: (spaceKey: string, paths: string[]) => Promise<void>
  openDiff: (path: string) => Promise<void>
  loadConflicts: (spaceKey: string) => Promise<void>
  resolveConflict: (
    candidate: { pageId: string; path: string; reason: string },
    choice: 'overwrite' | 'take-remote' | 'manual',
  ) => Promise<void>
}

async function api<T>(channel: string, payload?: unknown): Promise<T> {
  if (!window.confluenceLocal) throw new Error(ko.errors.preloadNotReady)
  return window.confluenceLocal.invoke(channel, payload) as Promise<T>
}

let agentUnsubscribe: (() => void) | null = null
let syncUnsubscribe: (() => void) | null = null
let updateUnsubscribe: (() => void) | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
/** openPage 응답 경쟁 가드 — 마지막 선택만 화면에 반영한다. */
let openPageSeq = 0

function appendSystemMessage(text: string): void {
  const { chatMessages } = useAppStore.getState()
  useAppStore.setState({ chatMessages: [...chatMessages, { role: 'system', text }] })
}

/** 감사 런의 텍스트 누적 버퍼 — 판정은 런 종료 시 한 번 파싱한다. */
let reviewTextBuffer = ''

/** 감사(읽기 전용 리뷰) 런 이벤트 — 채팅에 섞지 않고 검토 판정 상태로만 간다. */
function handleReviewEvent(
  event: AgentRunEvent | { type: 'terminal'; state: string },
  isActiveSpace: boolean,
): void {
  if (!isActiveSpace) return
  if ('type' in event && event.type === 'text') {
    reviewTextBuffer += event.value
    return
  }
  if ('type' in event && event.type === 'error') {
    useAppStore.setState({ reviewNote: event.message })
    return
  }
  if ('type' in event && event.type === 'terminal') {
    const verdict = parseReviewVerdict(reviewTextBuffer)
    reviewTextBuffer = ''
    useAppStore.setState({
      reviewRunning: false,
      reviewVerdict: verdict,
      reviewNote: verdict ? undefined : ko.review.auditUnparsable,
    })
  }
}

/** 편집 런 정상 종료 후 변경이 있으면 감사 런을 자동으로 띄운다(기계 리뷰 게이트). */
function maybeAutoReview(spaceKey: string, terminalState: string): void {
  if (terminalState !== 'completed') return
  const state = useAppStore.getState()
  const changeset = state.changeset
  if (!changeset || (changeset.modified.length === 0 && changeset.added.length === 0)) return
  const instruction = [...state.chatMessages].reverse().find((m) => m.role === 'user')?.text ?? ''
  void state.runReview(spaceKey, instruction)
}

function showNotice(message: string): void {
  clearTimeout(noticeTimer)
  useAppStore.setState({ notice: message })
  noticeTimer = setTimeout(() => {
    useAppStore.setState({ notice: undefined })
    noticeTimer = undefined
  }, 6000)
}
/** main → sync:event의 auth-error 변형 판별(토큰 만료 안내). */
function isAuthErrorEvent(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    payload.type === 'auth-error'
  )
}

function spaceKeyOfAuthError(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'spaceKey' in payload) {
    const key = payload.spaceKey
    return typeof key === 'string' ? key : ''
  }
  return ''
}

/** main → sync:event의 pull-progress 변형(진행률 표시용). */
function pullProgressOf(
  payload: unknown,
): { spaceKey: string; done: number; total: number } | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('type' in payload) ||
    payload.type !== 'pull-progress'
  ) {
    return null
  }
  if (!('spaceKey' in payload && 'done' in payload && 'total' in payload)) return null
  const { spaceKey, done, total } = payload
  if (typeof spaceKey !== 'string' || typeof done !== 'number' || typeof total !== 'number') {
    return null
  }
  return { spaceKey, done, total }
}

/**
 * main 이벤트 구독(앱 최초 연결 시 1회) — 에이전트 런 + 동기화 폴링 알림.
 * 에이전트 이벤트는 run의 스페이스가 현재 활성 스페이스일 때만 채팅에 기록한다
 * (스페이스 전환 중 다른 스페이스 런의 출력이 섞이는 오염 방지).
 */
export function ensureAgentEventSubscription(): void {
  if (!window.confluenceLocal) return
  if (!agentUnsubscribe) {
    agentUnsubscribe = window.confluenceLocal.onAgentEvent((payload) => {
      const event = payload.event as AgentRunEvent | { type: 'terminal'; state: string }
      const kind = payload.kind === 'review' ? 'review' : 'write'
      const isActiveSpace = payload.spaceKey === useAppStore.getState().activeSpaceKey

      if (kind === 'review') {
        handleReviewEvent(event, isActiveSpace)
        return
      }

      if ('type' in event && event.type === 'text' && isActiveSpace) {
        const { chatMessages } = useAppStore.getState()
        const messages = [...chatMessages]
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant') {
          messages[messages.length - 1] = { role: 'assistant', text: `${last.text}${event.value}` }
        } else {
          messages.push({ role: 'assistant', text: event.value })
        }
        useAppStore.setState({ chatMessages: messages })
      } else if ('type' in event && event.type === 'tool' && isActiveSpace) {
        appendSystemMessage(`${ko.chat.toolPrefix}: ${event.name}`)
      } else if ('type' in event && event.type === 'result' && isActiveSpace) {
        // CLI 최종 result 레코드 — 성공 요약은 스트리밍 텍스트와 중복되니 표시하지 않고,
        // 실패(is_error/error_* subtype)만 사용자에게 보여 실패 원인을 감추지 않는다.
        if (event.isError) {
          const reason = event.value ?? event.subtype ?? ko.chat.agentFailed
          appendSystemMessage(`${ko.chat.errorPrefix} ${reason}`)
        }
      } else if ('type' in event && event.type === 'terminal') {
        useAppStore.setState({
          agentRunning: false,
          activeRunId: undefined,
          agentStarting: false,
          agentStartAborted: false,
        })
        // 비활성 스페이스 런의 changeset으로 현재 검토 화면을 덮어쓰지 않는다(스페이스 간 오염 방지)
        if (isActiveSpace) {
          appendSystemMessage(`${ko.chat.terminalPrefix} ${event.state}`)
          // 편집이 끝났으면 해당 스페이스의 변경 세트를 자동으로 다시 검사한다
          void useAppStore
            .getState()
            .loadChangeset(payload.spaceKey)
            .then(() => {
              maybeAutoReview(payload.spaceKey, event.state)
            })
        }
      } else if ('type' in event && event.type === 'error' && isActiveSpace) {
        appendSystemMessage(`${ko.chat.errorPrefix} ${event.message}`)
      }
    })
  }
  if (!syncUnsubscribe) {
    syncUnsubscribe = window.confluenceLocal.onSyncEvent((payload) => {
      const progress = pullProgressOf(payload)
      if (progress) {
        useAppStore.setState({ syncingProgress: progress })
        return
      }
      // 401 감지: 폴링이 조용히 죽지 않게 사용자에게 재연결을 요청한다
      if (isAuthErrorEvent(payload)) {
        useAppStore.setState({ error: ko.sync.authExpired(spaceKeyOfAuthError(payload)) })
        return
      }
      const event = payload as SyncPollEvent
      if (event?.type !== 'poll') return
      const state = useAppStore.getState()
      if (event.spaceKey !== state.activeSpaceKey) return
      // 백그라운드 동기화 결과를 트리·충돌 후보에 즉시 반영
      void state.loadTree(event.spaceKey)
      void state.loadConflicts(event.spaceKey)
      if (
        event.updated > 0 ||
        event.skippedDirty > 0 ||
        (event.failed ?? 0) > 0 ||
        event.tombstoned > 0
      ) {
        showNotice(
          ko.sync.pullDone(event.updated, 0, event.skippedDirty, event.tombstoned, event.failed),
        )
      }
    })
  }
  if (!updateUnsubscribe) {
    updateUnsubscribe = window.confluenceLocal.onUpdateEvent((payload) => {
      const event = payload as { type?: string; percent?: number; message?: string }
      if (event?.type === 'progress' && typeof event.percent === 'number') {
        useAppStore.setState({ updateProgress: event.percent })
      } else if (event?.type === 'downloaded') {
        useAppStore.setState({ updatePhase: 'restarting' })
      } else if (event?.type === 'error') {
        useAppStore.setState({
          updatePhase: 'idle',
          error: ko.update.failed(event.message ?? ''),
        })
      }
    })
  }
}

export const useAppStore = create<AppUiState>((set, get) => ({
  status: 'loading',
  spaces: [],
  tree: [],
  selected: null,
  busy: false,
  chatMessages: [],
  agentRunning: false,
  agentStarting: false,
  agentStartAborted: false,
  updateStatus: 'idle',
  updatePhase: 'idle',
  reviewRunning: false,
  reviewVerdict: null,
  changeset: null,
  pushOutcome: null,
  diffs: {},
  conflicts: [],
  notice: undefined,

  dismissError: () => {
    set({ error: undefined })
  },

  refreshStatus: async () => {
    try {
      const status = await api<{ connected: boolean; baseUrl?: string; email?: string }>(
        'auth:status',
      )
      if (status.connected) {
        set({ status: 'connected', baseUrl: status.baseUrl, email: status.email, error: undefined })
        await get().loadSpaces()
      } else {
        set({ status: 'disconnected', spaces: [], tree: [] })
      }
    } catch (cause) {
      set({ status: 'disconnected', error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  connect: async (siteUrl, email, apiToken) => {
    set({ busy: true, error: undefined })
    try {
      const result = await api<{ baseUrl: string; email: string; spaces: ConfluenceSpace[] }>(
        'auth:connect',
        {
          siteUrl,
          email,
          apiToken,
        },
      )
      set({
        status: 'connected',
        baseUrl: result.baseUrl,
        email: result.email,
        spaces: result.spaces,
      })
      if (result.spaces.length > 0) await get().pullSpace(result.spaces[0]!.key)
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    } finally {
      set({ busy: false })
    }
  },

  disconnect: async () => {
    set({ busy: true })
    try {
      await api('auth:disconnect')
      set({
        status: 'disconnected',
        baseUrl: undefined,
        email: undefined,
        spaces: [],
        tree: [],
        selected: null,
      })
    } finally {
      set({ busy: false })
    }
  },

  loadSpaces: async () => {
    try {
      const result = await api<{ spaces: ConfluenceSpace[] }>('spaces:list')
      set({ spaces: result.spaces, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  pullSpace: async (spaceKey) => {
    set({ busy: true, syncingSpace: spaceKey, syncingProgress: undefined, error: undefined })
    try {
      const result = await api<{
        spaceKey: string
        pages: number
        attachments: number
        skippedDirty: number
        tombstoned: number
        failed?: Array<{ pageId: string; title: string; error: string }>
      }>('spaces:pull', { spaceKey })
      showNotice(
        ko.sync.pullDone(
          result.pages,
          result.attachments,
          result.skippedDirty,
          result.tombstoned,
          result.failed?.length ?? 0,
        ),
      )
      await get().selectSpace(spaceKey)
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    } finally {
      set({ busy: false, syncingSpace: undefined, syncingProgress: undefined })
    }
  },

  cancelPull: async (spaceKey) => {
    try {
      await api('pull:cancel', { spaceKey })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  selectSpace: async (spaceKey) => {
    ensureAgentEventSubscription()
    // 이전 스페이스에서 진행 중이던 미리보기 렌더 무효화
    openPageSeq++
    // 검토 상태는 스페이스에 귀속 — 잔류 시 이전 스페이스 변경을 새 스페이스로 오승인할 수 있다
    set({
      activeSpaceKey: spaceKey,
      chatMessages: [],
      selected: null,
      changeset: null,
      pushOutcome: null,
      reviewVerdict: null,
      reviewRunning: false,
      reviewNote: undefined,
      diffs: {},
    })
    await get().loadTree(spaceKey)
    // 충돌 탭 배지를 최신으로 유지
    void get().loadConflicts(spaceKey)
    // 검토 탭도 스페이스 전환 시 새로 불러온다(잔류 데이터 오승인 방지)
    void get().loadChangeset(spaceKey)
  },

  sendChat: async (prompt) => {
    const spaceKey = get().activeSpaceKey
    if (!spaceKey || get().agentRunning) return
    set({
      chatMessages: [...get().chatMessages, { role: 'user', text: prompt }],
      agentRunning: true,
      agentStarting: true,
    })
    try {
      const { runId } = await api<{ runId: string }>('agent:run', { spaceKey, prompt })
      set({ activeRunId: runId, agentStarting: false })
      // 시작 왕복 중 중지가 요청됐다 — runId를 받은 지금 즉시 취소한다(사전-시작 취소 큐).
      if (get().agentStartAborted) {
        set({ agentStartAborted: false })
        try {
          await api('agent:cancel', { runId })
        } catch {
          // 시작 직후 취소 실패는 런 종료(terminal) 이벤트가 수습한다
        }
      }
    } catch (cause) {
      set({
        agentRunning: false,
        agentStarting: false,
        agentStartAborted: false,
        error: String(cause instanceof Error ? cause.message : cause),
      })
    }
  },

  loadChangeset: async (spaceKey: string) => {
    try {
      const changeset = await api<ChangeSet>('push:changeset', { spaceKey })
      set({ changeset, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  approveUpload: async (spaceKey: string, paths: string[]) => {
    set({ busy: true, error: undefined })
    try {
      const outcome = await api<PushOutcome>('push:approve', { spaceKey, paths })
      await get().loadTree(spaceKey)
      // push 결과의 충돌이 배지에 반영되게 충돌 후보도 갱신한다
      void get().loadConflicts(spaceKey)
      // 오래된 변경 세트 재승인 방지: 업로드 결과와 함께 최신 세트로 갱신
      const changeset = await api<ChangeSet>('push:changeset', { spaceKey }).catch(() => null)
      set({ pushOutcome: outcome, changeset })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    } finally {
      set({ busy: false })
    }
  },

  openDiff: async (path) => {
    try {
      const result = await api<{ path: string; changes: LineChange[] }>('pages:diff', { path })
      set({ diffs: { ...get().diffs, [path]: result.changes } })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  loadConflicts: async (spaceKey) => {
    try {
      const result = await api<{
        candidates: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }>
      }>('conflict:list', { spaceKey })
      set({ conflicts: result.candidates, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  resolveConflict: async (candidate, choice) => {
    set({ busy: true, error: undefined })
    try {
      await api('conflict:resolve', { path: candidate.path, pageId: candidate.pageId, choice })
      const result = await api<{
        candidates: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }>
      }>('conflict:list', { spaceKey: get().activeSpaceKey })
      set({ conflicts: result.candidates })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    } finally {
      set({ busy: false })
    }
  },

  cancelAgent: async () => {
    const runId = get().activeRunId
    if (!runId) {
      // 시작 IPC 왕복 전/중 중지 요청 — 왕복 중이면 큐잉하고 runId 수령 즉시 취소한다
      if (get().agentStarting) {
        set({ agentStartAborted: true })
        showNotice(ko.chat.cancelQueued)
        return
      }
      showNotice(ko.chat.cancelPending)
      return
    }
    try {
      await api('agent:cancel', { runId })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  checkUpdate: async () => {
    if (get().updateStatus === 'checking') return
    set({ updateStatus: 'checking' })
    try {
      const result = await api<UpdateCheckOutcome>('update:check')
      if (result.status === 'available') {
        set({ updateStatus: 'available', updateNewVersion: result.newVersion })
      } else if (result.status === 'up-to-date') {
        set({ updateStatus: 'up-to-date' })
        showNotice(ko.update.upToDate)
      } else {
        set({ updateStatus: 'unavailable' })
        showNotice(ko.update.unavailable(result.message))
      }
    } catch (cause) {
      set({ updateStatus: 'idle' })
      showNotice(ko.update.failed(String(cause instanceof Error ? cause.message : cause)))
    }
  },

  installUpdate: async () => {
    if (get().updatePhase !== 'idle') return
    set({ updatePhase: 'downloading', updateProgress: 0 })
    try {
      // 다운로드 완료 후 앱이 재시작되며 이 invoke는 응답을 못 돌려줄 수 있다 —
      // 진행 상태는 update:event 스트림(progress/downloaded/error)이 담당한다.
      await api('update:install')
    } catch (cause) {
      set({
        updatePhase: 'idle',
        error: ko.update.failed(String(cause instanceof Error ? cause.message : cause)),
      })
    }
  },

  runReview: async (spaceKey, instruction) => {
    reviewTextBuffer = ''
    set({ reviewRunning: true, reviewVerdict: null, reviewNote: undefined })
    try {
      const result = await api<{ runId?: string; empty?: boolean }>('review:run', {
        spaceKey,
        instruction,
      })
      // 감사할 변경이 없거나 런이 시작 못 했으면 즉시 해제(terminal 이벤트가 오지 않는다)
      if (!result.runId || result.empty) {
        set({ reviewRunning: false, reviewNote: ko.review.auditEmpty })
      }
    } catch (cause) {
      set({
        reviewRunning: false,
        reviewNote: String(cause instanceof Error ? cause.message : cause),
      })
    }
  },

  loadTree: async (spaceKey) => {
    try {
      const result = await api<{ tree: PageTreeNode[] }>('pages:tree', { spaceKey })
      set({ tree: result.tree, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  openPage: async (path) => {
    const seq = ++openPageSeq
    try {
      const result = await api<{ title: string; url: string; version: number; markdown: string }>(
        'pages:read',
        { path },
      )
      const html = await renderPreviewHtml(result.markdown)
      // 이후 선택(또는 스페이스 전환)이 발생한 늦은 응답은 폐기한다
      if (seq !== openPageSeq) return
      set({
        selected: { path, title: result.title, url: result.url, version: result.version, html },
      })
    } catch (cause) {
      if (seq !== openPageSeq) return
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  openExternal: async (url) => {
    try {
      await api('app:open-external', { url })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },
}))
