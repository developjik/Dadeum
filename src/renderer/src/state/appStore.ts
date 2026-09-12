import { create } from 'zustand'
import { ko } from '../../../core/i18n/ko'
import type { ConfluenceSpace } from '../../../core/confluence/types'
import type { PageTreeNode } from '../../../core/store/tree'
import type { AgentRunEvent } from '../../../core/agent/types'
import type { ChangeSet } from '../../../core/push/changeSet'
import type { LineChange } from '../../../core/push/diff'
import type { PushOutcome } from '../../../core/push/types'

export type AuthStatus = 'loading' | 'disconnected' | 'connected'

export interface SelectedPage {
  path: string
  title: string
  url: string
  version: number
  html: string
}

interface AppUiState {
  status: AuthStatus
  baseUrl?: string
  email?: string
  spaces: ConfluenceSpace[]
  tree: PageTreeNode[]
  selected: SelectedPage | null
  error?: string
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
  resolveConflict: (candidate: { pageId: string; path: string; reason: string }, choice: 'overwrite' | 'take-remote' | 'manual') => Promise<void>
}

async function api<T>(channel: string, payload?: unknown): Promise<T> {
  if (!window.confluenceLocal) throw new Error(ko.errors.preloadNotReady)
  return window.confluenceLocal.invoke(channel, payload) as Promise<T>
}

let eventUnsubscribe: (() => void) | null = null

/** 에이전트 이벤트 구독(앱 최초 연결 시 1회). */
export function ensureAgentEventSubscription(): void {
  if (eventUnsubscribe || !window.confluenceLocal) return
  eventUnsubscribe = window.confluenceLocal.onAgentEvent((payload) => {
    const event = payload.event as AgentRunEvent | { type: 'terminal'; state: string }
    const { chatMessages } = useAppStore.getState()
    if ('type' in event && event.type === 'text') {
      const messages = [...chatMessages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { role: 'assistant', text: `${last.text}${event.value}` }
      } else {
        messages.push({ role: 'assistant', text: event.value })
      }
      useAppStore.setState({ chatMessages: messages })
    } else if ('type' in event && event.type === 'terminal') {
      useAppStore.setState({
        chatMessages: [...chatMessages, { role: 'system', text: `${ko.chat.terminalPrefix} ${event.state}` }],
        agentRunning: false
      })
    } else if ('type' in event && event.type === 'error') {
      useAppStore.setState({ chatMessages: [...chatMessages, { role: 'system', text: `${ko.chat.errorPrefix} ${event.message}` }] })
    }
  })
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

  refreshStatus: async () => {
    try {
      const status = await api<{ connected: boolean; baseUrl?: string; email?: string }>('auth:status')
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
      const result = await api<{ baseUrl: string; email: string; spaces: ConfluenceSpace[] }>('auth:connect', {
        siteUrl,
        email,
        apiToken
      })
      set({ status: 'connected', baseUrl: result.baseUrl, email: result.email, spaces: result.spaces })
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
      set({ status: 'disconnected', baseUrl: undefined, email: undefined, spaces: [], tree: [], selected: null })
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
      await api('spaces:pull', { spaceKey })
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
  },

  sendChat: async (prompt) => {
    const spaceKey = get().activeSpaceKey
    if (!spaceKey || get().agentRunning) return
    set({ chatMessages: [...get().chatMessages, { role: 'user', text: prompt }], agentRunning: true })
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
      set({ pushOutcome: outcome })
      await get().loadTree(spaceKey)
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
      const result = await api<{ candidates: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }> }>('conflict:list', { spaceKey })
      set({ conflicts: result.candidates, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  resolveConflict: async (candidate, choice) => {
    set({ busy: true, error: undefined })
    try {
      await api('conflict:resolve', { path: candidate.path, pageId: candidate.pageId, choice })
      const result = await api<{ candidates: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }> }>('conflict:list', { spaceKey: get().activeSpaceKey })
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
      const result = await api<{ title: string; url: string; version: number; markdown: string }>('pages:read', { path })
      const { renderPreviewHtml } = await import('../../../core/preview/render')
      const html = await renderPreviewHtml(result.markdown)
      set({ selected: { path, title: result.title, url: result.url, version: result.version, html } })
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
  }
}))

export const emptyTreeMessage = ko.tree.empty
