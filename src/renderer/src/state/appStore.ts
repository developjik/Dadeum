import { create } from 'zustand'
import type { AgentRunEvent } from '../../../core/agent/types'
import type { ConfluenceSpace } from '../../../core/confluence/types'
import { ko } from '../../../core/i18n/ko'
import type { ChangeSet } from '../../../core/push/changeSet'
import type { LineChange } from '../../../core/push/diff'
import type { PushOutcome } from '../../../core/push/types'
import type { PageTreeNode } from '../../../core/store/tree'

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
  activeSpaceKey?: string
  chatMessages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>
  agentRunning: boolean
  activeRunId?: string
  changeset: ChangeSet | null
  pushOutcome: PushOutcome | null
  conflicts: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }>
  diffs: Record<string, LineChange[]>

  refreshStatus: () => Promise<void>
  dismissError: () => void
  connect: (siteUrl: string, email: string, apiToken: string) => Promise<void>
  disconnect: () => Promise<void>
  loadSpaces: () => Promise<void>
  pullSpace: (spaceKey: string) => Promise<void>
  loadTree: (spaceKey: string) => Promise<void>
  openPage: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  selectSpace: (spaceKey: string) => Promise<void>
  sendChat: (prompt: string) => Promise<void>
  cancelAgent: () => Promise<void>
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
let noticeTimer: ReturnType<typeof setTimeout> | undefined

function showNotice(message: string): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  useAppStore.setState({ notice: message })
  noticeTimer = setTimeout(() => {
    useAppStore.setState({ notice: undefined })
    noticeTimer = undefined
  }, 6000)
}

function appendSystemMessage(text: string): void {
  const { chatMessages } = useAppStore.getState()
  useAppStore.setState({ chatMessages: [...chatMessages, { role: 'system', text }] })
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
      const isActiveSpace = payload.spaceKey === useAppStore.getState().activeSpaceKey

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
      } else if ('type' in event && event.type === 'terminal') {
        useAppStore.setState({ agentRunning: false, activeRunId: undefined })
        if (isActiveSpace) {
          appendSystemMessage(`${ko.chat.terminalPrefix} ${event.state}`)
        }
        // 편집이 끝났으면 해당 스페이스의 변경 세트를 자동으로 다시 검사한다
        void useAppStore.getState().loadChangeset(payload.spaceKey)
      } else if ('type' in event && event.type === 'error' && isActiveSpace) {
        appendSystemMessage(`${ko.chat.errorPrefix} ${event.message}`)
      }
    })
  }
  if (!syncUnsubscribe) {
    syncUnsubscribe = window.confluenceLocal.onSyncEvent((payload) => {
      const event = payload as SyncPollEvent
      if (event?.type !== 'poll') return
      const state = useAppStore.getState()
      if (event.spaceKey !== state.activeSpaceKey) return
      // 백그라운드 동기화 결과를 트리·충돌 후보에 즉시 반영
      void state.loadTree(event.spaceKey)
      void state.loadConflicts(event.spaceKey)
      if (event.updated > 0 || event.skippedDirty > 0 || event.tombstoned > 0) {
        showNotice(ko.sync.pullDone(event.updated, 0, event.skippedDirty, event.tombstoned))
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
    set({ busy: true, syncingSpace: spaceKey, error: undefined })
    try {
      const result = await api<{
        spaceKey: string
        pages: number
        attachments: number
        skippedDirty: number
        tombstoned: number
      }>('spaces:pull', { spaceKey })
      showNotice(
        ko.sync.pullDone(result.pages, result.attachments, result.skippedDirty, result.tombstoned),
      )
      await get().selectSpace(spaceKey)
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    } finally {
      set({ busy: false, syncingSpace: undefined })
    }
  },

  selectSpace: async (spaceKey) => {
    ensureAgentEventSubscription()
    set({ activeSpaceKey: spaceKey, chatMessages: [], selected: null })
    await get().loadTree(spaceKey)
    // 충돌 탭 배지를 최신으로 유지
    void get().loadConflicts(spaceKey)
  },

  sendChat: async (prompt) => {
    const spaceKey = get().activeSpaceKey
    if (!spaceKey || get().agentRunning) return
    set({
      chatMessages: [...get().chatMessages, { role: 'user', text: prompt }],
      agentRunning: true,
    })
    try {
      const { runId } = await api<{ runId: string }>('agent:run', { spaceKey, prompt })
      set({ activeRunId: runId })
    } catch (cause) {
      set({ agentRunning: false, error: String(cause instanceof Error ? cause.message : cause) })
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
    if (!runId) return
    try {
      await api('agent:cancel', { runId })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
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
    try {
      const result = await api<{ title: string; url: string; version: number; markdown: string }>(
        'pages:read',
        { path },
      )
      const { renderPreviewHtml } = await import('../../../core/preview/render')
      const html = await renderPreviewHtml(result.markdown)
      set({
        selected: { path, title: result.title, url: result.url, version: result.version, html },
      })
    } catch (cause) {
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
