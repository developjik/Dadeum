import { create } from 'zustand'
import type { AgentDescriptor, AgentRunEvent } from '../../../core/agent/types'
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

/**
 * 직접 편집 세션 — 문서 경로에 귀속된다. 페이지 이동으로 파괴되지 않으며
 * (selected.path === editing.path일 때만 노출), dirty 판정은 baseline과 비교한다.
 */
interface EditSession {
  path: string
  /** 저장 기준 본문(더티 판정·충돌 감지 기준) */
  baseline: string
  body: string
  saving: boolean
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
  /**
   * 저장된 자격증명은 있으나 토큰 복호화에 실패한 경우의 프리필 값 —
   * 연결 화면에서 사이트 주소·이메일을 채운 채 시작하고 토큰만 요청한다.
   */
  lastCredentials?: { baseUrl: string; email: string }
  spaces: ConfluenceSpace[]
  tree: PageTreeNode[]
  selected: SelectedPage | null
  /** 문서 열기(openPage) 왕복 진행 중 — 미리보기 헤더의 로딩 표시용 */
  pageLoading: boolean
  /** 직접 편집 세션(없으면 미리보기 모드) */
  editing: EditSession | null
  /** beginEdit 왕복 진행 중 — 에디터 진입 로딩 표시용 */
  editLoading: boolean
  error?: string
  /** 자동으로 사라지는 성공·동기화 알림 */
  notice?: string
  busy: boolean
  syncingSpace?: string
  syncingProgress?: { spaceKey: string; done: number; total: number }
  /** 마지막 자동 폴링 실패 사유 — 헤더 상태 점이 경고색으로 바뀐다(성공 폴링 시 해제). */
  syncError?: string
  activeSpaceKey?: string
  chatMessages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>
  agentRunning: boolean
  /** agent:list로 발견한 에이전트(설치 여부·기능 포함) — 선택 UI 원천 */
  agents: AgentDescriptor[]
  /** 현재 스페이스가 쓰는 에이전트(서버 저장값, 없으면 기본 어댑터) */
  selectedAgent?: string
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
  dismissNotice: () => void
  connect: (siteUrl: string, email: string, apiToken: string) => Promise<void>
  disconnect: () => Promise<void>
  pullSpace: (spaceKey: string) => Promise<void>
  cancelPull: (spaceKey: string) => Promise<void>
  loadSpaces: () => Promise<void>
  installUpdate: () => Promise<void>
  runReview: (spaceKey: string, instruction: string) => Promise<void>
  loadTree: (spaceKey: string) => Promise<void>
  openPage: (path: string) => Promise<void>
  beginEdit: (path: string) => Promise<void>
  setEditBody: (body: string) => void
  saveEdit: () => Promise<void>
  cancelEdit: () => void
  openExternal: (url: string) => Promise<void>
  cancelAgent: () => Promise<void>
  checkUpdate: () => Promise<void>
  selectSpace: (spaceKey: string) => Promise<void>
  sendChat: (prompt: string) => Promise<void>
  loadAgents: (spaceKey: string) => Promise<void>
  selectAgent: (spaceKey: string, adapterName: string) => Promise<void>
  loadChangeset: (spaceKey: string) => Promise<void>
  approveUpload: (spaceKey: string, paths: string[]) => Promise<void>
  openDiff: (path: string) => Promise<void>
  loadConflicts: (spaceKey: string) => Promise<void>
  resolveConflict: (
    candidate: { pageId: string; path: string; reason: string },
    choice: 'overwrite' | 'keep-both' | 'take-remote' | 'manual',
  ) => Promise<void>
}

async function api<T>(channel: string, payload?: unknown): Promise<T> {
  if (!window.confluenceLocal) throw new Error(ko.errors.preloadNotReady)
  return window.confluenceLocal.invoke(channel, payload) as Promise<T>
}

/** 마지막으로 선택한 스페이스 키(재실행 시 복원용). localStorage 접근은
 * 스토리지가 없는 테스트 환경을 고려해 가드한다. */
const LAST_SPACE_KEY_STORAGE = 'space.last'

function persistLastSpaceKey(spaceKey: string): void {
  try {
    window.localStorage.setItem(LAST_SPACE_KEY_STORAGE, spaceKey)
  } catch {
    // 저장 실패는 복원 기능만 죽는다(앱 동작에는 무해)
  }
}

function readLastSpaceKey(): string | null {
  try {
    return window.localStorage.getItem(LAST_SPACE_KEY_STORAGE)
  } catch {
    return null
  }
}

let agentUnsubscribe: (() => void) | null = null
let syncUnsubscribe: (() => void) | null = null
let updateUnsubscribe: (() => void) | null = null
let noticeTimer: ReturnType<typeof setTimeout> | undefined
/** openPage 응답 경쟁 가드 — 마지막 선택만 화면에 반영한다. */
let openPageSeq = 0
/** beginEdit 응답 경쟁 가드 — 마지막 요청의 세션만 남긴다. */
let beginEditSeq = 0

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

/** main → sync:event의 sync-error 변형 판별(폴링 실패 안내). 사유가 없으면 빈 문자열. */
function syncErrorMessageOf(payload: unknown): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('type' in payload) ||
    payload.type !== 'sync-error'
  ) {
    return null
  }
  if (!('message' in payload) || typeof payload.message !== 'string') return ''
  return payload.message
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
            .catch((cause: unknown) => {
              // 자동 감사 팝업 경로에서라도 미처리 거부로 렌더러가 죽지 않게 한다
              useAppStore.setState({
                error: cause instanceof Error ? cause.message : String(cause),
              })
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
      // 폴링 실패(네트워크·서버 오류): 상태 점을 경고로 바꾸고 자동 소멸 알림으로 알린다.
      // 스케줄러가 백오프하며 자동 재시도하므로 스티키 에러 배너는 쓰지 않는다.
      const syncErrorMessage = syncErrorMessageOf(payload)
      if (syncErrorMessage !== null) {
        useAppStore.setState({ syncError: syncErrorMessage || ko.sync.degraded })
        showNotice(ko.sync.degradedNotice(syncErrorMessage || ko.sync.degraded))
        return
      }
      const event = payload as SyncPollEvent
      if (event?.type !== 'poll') return
      // 폴링 성공은 저하 상태를 해제한다(활성 스페이스와 무관하게).
      if (useAppStore.getState().syncError !== undefined) {
        useAppStore.setState({ syncError: undefined })
      }
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
  agents: [],
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
  pageLoading: false,
  editing: null,
  editLoading: false,

  dismissError: () => {
    set({ error: undefined })
  },

  dismissNotice: () => {
    clearTimeout(noticeTimer)
    noticeTimer = undefined
    set({ notice: undefined })
  },

  refreshStatus: async () => {
    try {
      const status = await api<{
        connected: boolean
        baseUrl?: string
        email?: string
        reason?: 'token-decrypt-failed'
      }>('auth:status')
      if (status.connected) {
        set({ status: 'connected', baseUrl: status.baseUrl, email: status.email, error: undefined })
        await get().loadSpaces()
        // 마지막으로 선택한 스페이스 복원 — 목록에 없으면(삭제 등) 빈 상태로 둔다
        const last = readLastSpaceKey()
        if (last && get().spaces.some((space) => space.key === last)) {
          await get().selectSpace(last)
        }
      } else {
        set({
          status: 'disconnected',
          spaces: [],
          tree: [],
          lastCredentials:
            status.baseUrl && status.email
              ? { baseUrl: status.baseUrl, email: status.email }
              : undefined,
        })
      }
    } catch (cause) {
      set({
        status: 'disconnected',
        lastCredentials: undefined,
        error: String(cause instanceof Error ? cause.message : cause),
      })
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
        lastCredentials: undefined,
      })
      // 첫 스페이스를 자동으로 전량 풀하지 않는다 — 수천 페이지 팀 스페이스에서
      // 사용자 동의 없이 수 분짜리 다운로드가 시작되는 문제가 있었다(실기기 E2E).
      // 선택만 하고 가져오기는 사용자가 결정한다.
      if (result.spaces.length > 0) {
        await get().selectSpace(result.spaces[0]!.key)
        set({ notice: ko.sync.pullHint })
      }
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
        editing: null,
        editLoading: false,
        // 직접 연결 해제는 프리필 없이 빈 연결 화면으로 시작한다
        lastCredentials: undefined,
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
    persistLastSpaceKey(spaceKey)
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

  /** 스페이스의 에이전트 목록·선택을 불러온다(선택 UI 갱신용 — 실패는 조용히 무시). */
  loadAgents: async (spaceKey) => {
    try {
      const result = await api<{ agents?: AgentDescriptor[]; selected?: string }>('agent:list', {
        spaceKey,
      })
      // main 경계 밖(테스트 목 등)에서는 응답 스키마가 비어 있을 수 있다
      if (!Array.isArray(result.agents)) return
      set({
        agents: result.agents,
        selectedAgent: typeof result.selected === 'string' ? result.selected : undefined,
      })
    } catch {
      // 에이전트 선택은 부가 기능 — 목록 조회 실패를 에러 배너로 세우지 않는다
    }
  },

  /** 스페이스가 쓸 에이전트를 서버에 저장한다(이후 agent:run이 이 값을 따른다). */
  selectAgent: async (spaceKey, adapterName) => {
    try {
      await api('agent:select', { spaceKey, adapterName })
      set({ selectedAgent: adapterName, error: undefined })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
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
    set({ pageLoading: true })
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
        pageLoading: false,
      })
    } catch (cause) {
      if (seq !== openPageSeq) return
      set({ error: String(cause instanceof Error ? cause.message : cause), pageLoading: false })
    }
  },

  /**
   * 직접 편집 시작 — 디스크 원문을 새로 읽어 세션을 만든다(오래된 본문 편집 방지).
   * 페이지 이동은 세션을 파괴하지 않으므로 확인이 필요 없고, 다른 문서의
   * 저장 안 된 세션이 남아 있을 때만 새 세션 시작을 게이트한다(무손실 원칙).
   */
  beginEdit: async (path) => {
    const current = get().editing
    if (current && current.path !== path && current.body !== current.baseline) {
      set({ error: ko.editor.blockedByOtherDraft })
      return
    }
    const seq = ++beginEditSeq
    set({ editLoading: true })
    try {
      const result = await api<{ markdown: string }>('pages:read', { path })
      if (seq !== beginEditSeq) return
      set({
        editing: { path, baseline: result.markdown, body: result.markdown, saving: false },
        editLoading: false,
      })
    } catch (cause) {
      if (seq !== beginEditSeq) return
      set({
        error: `${ko.editor.loadFailed} — ${cause instanceof Error ? cause.message : String(cause)}`,
        editLoading: false,
      })
    }
  },

  setEditBody: (body) => {
    const current = get().editing
    if (!current) return
    set({ editing: { ...current, body } })
  },

  /** 편집 저장 — pages:write 후 미리보기를 갱신하고 검토 배지(changeset)를 재검사한다. */
  saveEdit: async () => {
    const current = get().editing
    if (!current || current.saving) return
    set({ editing: { ...current, saving: true } })
    try {
      const result = await api<{
        title: string
        url: string
        version: number
        markdown: string
      }>('pages:write', { path: current.path, body: current.body })
      const html = await renderPreviewHtml(result.markdown)
      set((state) => ({
        editing: null,
        selected:
          state.selected && state.selected.path === current.path
            ? { ...state.selected, title: result.title, version: result.version, html }
            : state.selected,
      }))
      showNotice(ko.editor.savedNotice)
      const spaceKey = get().activeSpaceKey
      if (spaceKey) void get().loadChangeset(spaceKey)
    } catch (cause) {
      // 저장 실패 시 세션과 입력을 보존한다(재시도 가능해야 한다)
      const still = get().editing
      if (still && still.path === current.path) set({ editing: { ...still, saving: false } })
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },

  /** 편집 취소(폐기) — 확인 대화상자는 호출하는 Editor 컴포넌트의 인라인 확인이 담당한다. */
  cancelEdit: () => {
    set({ editing: null })
  },

  openExternal: async (url) => {
    try {
      await api('app:open-external', { url })
    } catch (cause) {
      set({ error: String(cause instanceof Error ? cause.message : cause) })
    }
  },
}))
