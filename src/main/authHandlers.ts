import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfluenceClient } from '../core/confluence/client'
import { storageToMarkdown } from '../core/converter/storageToMarkdown'
import { captureSnapshot, verifySnapshot } from '../core/push/approval'
import { computeChangeSet } from '../core/push/changeSet'
import { markdownLineDiff } from '../core/push/diff'
import { fileHashOf } from '../core/store/hash'
import { safeSpaceDirName } from '../core/store/workspace'
import { ChatRunService } from './agent/chatService'
import { ClaudeCodeAdapter } from './agent/claudeCodeAdapter'
import { buildReviewPrompt } from './agent/reviewPrompt'
import {
  clearCredentials,
  createClientFromStoredCredentials,
  getConnectionStatus,
  saveCredentials,
} from './credentials'
import { registerIpcHandler } from './ipc'
import { pushApproved } from './push/pushApproval'
import { type ConflictChoice, resolveConflict } from './sync/conflictService'
import { machineFor } from './sync/machines'
import {
  beginIncrementalPull,
  isAutoPullRunning,
  startAutoPull,
  stopAllAutoPull,
  stoppedSpaces,
} from './sync/pollCoordinator'
import { pullIncremental } from './sync/pullIncremental'
import { pullSpaceByKey } from './sync/pullService'
import { broadcastSyncEvent } from './sync/syncNotifier'
import {
  getWorkspaceDb,
  isAllowedExternalUrl,
  listPageTree,
  readPageFileGuarded,
  resolveWorkspaceRoot,
} from './workspaceAccess'

interface ConnectPayload {
  siteUrl: string
  email: string
  apiToken: string
}

/** auth:connect — 자격증명 검증(스페이스 조회) 후 안전 저장하고 연결 상태+스페이스를 반환한다. */
async function handleConnect(payload: unknown): Promise<unknown> {
  const input = payload as Partial<ConnectPayload>
  const siteUrl = String(input.siteUrl ?? '').trim()
  const email = String(input.email ?? '').trim()
  const apiToken = String(input.apiToken ?? '')
  if (!siteUrl || !email || !apiToken) {
    throw new Error('사이트 주소, 이메일, API 토큰을 모두 입력하세요')
  }

  const probe = new ConfluenceClient({ baseUrl: siteUrl, email, apiToken })
  const spaces = await probe.verifyConnection()

  saveCredentials(probe.identity.baseUrl, email, apiToken)
  return { baseUrl: probe.identity.baseUrl, email, spaces }
}

function requireClient(): ConfluenceClient {
  const client = createClientFromStoredCredentials()
  if (!client) throw new Error('연결된 Confluence 사이트가 없습니다. 먼저 연결하세요.')
  return client
}

export const chatRuns = new ChatRunService()

/** 진행 중 전체 pull의 취소 요청 등록(spaces:pull ↔ pull:cancel). */
const pullCancelRequests = new Set<string>()
chatRuns.registerAdapter(new ClaudeCodeAdapter())

/**
 * 앱 재시작 후 auth:status가 연결 상태를 확인하면 저장된 스페이스의 자동 폴링을 복원한다.
 * 복원 실패(네트워크 등)는 연결 상태 자체를 실패로 만들지 않는다(다음 pull 시 재시도).
 */
async function restoreAutoPull(): Promise<void> {
  const client = createClientFromStoredCredentials()
  if (!client) return
  const db = getWorkspaceDb()
  const stopped = stoppedSpaces(db)
  if (stopped.length === 0) return
  // listAllSpaces는 페이지네이션 순회를 동반하는 비싼 호출 — 스페이스마다 반복하지 않는다
  const spaces = await client.listAllSpaces()
  for (const spaceKey of stopped) {
    if (isAutoPullRunning(spaceKey)) continue
    const space = spaces.find((candidate) => candidate.key === spaceKey)
    if (!space) continue
    startAutoPull({ client, space, workspaceRoot: resolveWorkspaceRoot(), db })
  }
}

export function registerAuthAndSpaceHandlers(): void {
  registerIpcHandler('auth:connect', (payload) => handleConnect(payload))
  registerIpcHandler('auth:status', async () => {
    const status = getConnectionStatus()
    if (status.connected) void restoreAutoPull().catch(() => undefined)
    return status
  })
  registerIpcHandler('auth:disconnect', () => {
    stopAllAutoPull()
    clearCredentials()
    return { connected: false }
  })
  registerIpcHandler('spaces:list', async () => {
    const client = requireClient()
    return { spaces: await client.listAllSpaces() }
  })
  registerIpcHandler('agent:run', (payload, sender) => {
    const input = payload as { spaceKey?: string; prompt?: string }
    const spaceKey = String(input.spaceKey ?? '')
    const prompt = String(input.prompt ?? '')
    if (!spaceKey || !prompt) throw new Error('spaceKey와 prompt가 필요합니다')
    const spaceRoot = join(resolveWorkspaceRoot(), 'spaces', safeSpaceDirName(spaceKey))
    return chatRuns.startRun({
      sender,
      adapterName: 'claude-code',
      spaceKey,
      prompt,
      spaceRoot,
      db: getWorkspaceDb(),
    })
  })
  registerIpcHandler('agent:cancel', (payload) => {
    const runId = String((payload as { runId?: string })?.runId ?? '')
    if (!runId) throw new Error('runId가 필요합니다')
    chatRuns.cancelRun(runId)
    return { ok: true }
  })
  registerIpcHandler('review:run', (payload, sender) => {
    if (typeof payload !== 'object' || payload === null || !('spaceKey' in payload)) {
      throw new Error('spaceKey가 필요합니다')
    }
    const spaceKey = String((payload as { spaceKey: unknown }).spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    const instruction =
      'instruction' in payload && typeof payload.instruction === 'string' ? payload.instruction : ''

    const changeset = computeChangeSet(resolveWorkspaceRoot(), getWorkspaceDb(), spaceKey)
    const paths = [...changeset.modified.map((p) => p.path), ...changeset.added.map((p) => p.path)]
    if (paths.length === 0) return { runId: undefined, empty: true }

    const spaceRoot = join(resolveWorkspaceRoot(), 'spaces', safeSpaceDirName(spaceKey))
    const { runId } = chatRuns.startRun({
      sender,
      adapterName: 'claude-code',
      spaceKey,
      prompt: buildReviewPrompt(instruction, paths),
      spaceRoot,
      db: getWorkspaceDb(),
      kind: 'review',
      readOnly: true,
      timeoutMs: 3 * 60 * 1000,
    })
    return { runId, empty: false }
  })
  registerIpcHandler('push:changeset', (payload) => {
    const spaceKey = String((payload as { spaceKey?: string })?.spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    return computeChangeSet(resolveWorkspaceRoot(), getWorkspaceDb(), spaceKey)
  })
  registerIpcHandler('push:approve', async (payload) => {
    const input = payload as { spaceKey?: string; paths?: string[] }
    const spaceKey = String(input.spaceKey ?? '')
    const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
    if (!spaceKey || paths.length === 0) throw new Error('spaceKey와 승인 경로가 필요합니다')
    const client = requireClient()
    const spaceId = (await client.listAllSpaces()).find((space) => space.key === spaceKey)?.id
    if (!spaceId) throw new Error(`스페이스를 찾을 수 없습니다: ${spaceKey}`)
    const root = resolveWorkspaceRoot()
    const snapshot = captureSnapshot(root, paths)
    const preCheck = verifySnapshot(root, snapshot)
    if (!preCheck.ok) throw new Error('승인 직전 파일이 변경되었습니다. 다시 검토하세요.')
    return await pushApproved({
      client,
      workspaceRoot: root,
      db: getWorkspaceDb(),
      machine: machineFor(spaceKey),
      snapshot,
      approvedPaths: paths,
      spaceId,
    })
  })
  registerIpcHandler('conflict:list', (payload) => {
    const spaceKey = String((payload as { spaceKey?: string })?.spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    const candidates: Array<{ pageId: string; path: string; reason: 'remote-deleted' | 'dirty' }> =
      []
    for (const page of getWorkspaceDb().listPagesBySpace(spaceKey)) {
      if (page.remoteDeleted) {
        candidates.push({ pageId: page.pageId, path: page.path, reason: 'remote-deleted' })
        continue
      }
      const absPath = join(resolveWorkspaceRoot(), page.path)
      if (page.contentHash !== null && existsSync(absPath)) {
        const current = fileHashOf(readFileSync(absPath))
        if (current !== page.contentHash) {
          candidates.push({ pageId: page.pageId, path: page.path, reason: 'dirty' })
        }
      }
    }
    return { candidates }
  })
  registerIpcHandler('conflict:resolve', (payload) => {
    const input = payload as { choice?: string; path?: string; pageId?: string }
    const choice = String(input.choice ?? '') as ConflictChoice
    const path = String(input.path ?? '')
    const pageId = String(input.pageId ?? '')
    if (!path || !pageId) throw new Error('path와 pageId가 필요합니다')
    const client = requireClient()
    return resolveConflict({
      choice,
      path,
      pageId,
      client,
      workspaceRoot: resolveWorkspaceRoot(),
      db: getWorkspaceDb(),
    })
  })
  registerIpcHandler('spaces:poll', async (payload) => {
    const input = payload as { spaceKey?: string }
    const spaceKey = String(input.spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    const client = requireClient()
    const space = (await client.listAllSpaces()).find((candidate) => candidate.key === spaceKey)
    if (!space) throw new Error(`스페이스를 찾을 수 없습니다: ${spaceKey}`)
    const since = beginIncrementalPull(getWorkspaceDb(), space.key)
    return await pullIncremental({
      client,
      space,
      workspaceRoot: resolveWorkspaceRoot(),
      db: getWorkspaceDb(),
      sinceIso: since,
    })
  })
  registerIpcHandler('pages:diff', async (payload) => {
    const input = payload as { path?: string }
    const path = String(input.path ?? '')
    if (!path) throw new Error('path가 필요합니다')
    const client = requireClient()
    const guarded = readPageFileGuarded(path)
    const remote = await client.getPageStorage(guarded.pageId)
    const remoteMarkdown = storageToMarkdown(remote.storageValue).markdown
    return { path, changes: markdownLineDiff(remoteMarkdown, guarded.markdown) }
  })
  registerIpcHandler('pages:tree', (payload) => {
    const spaceKey = String((payload as { spaceKey?: string })?.spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    return { tree: listPageTree(spaceKey) }
  })
  registerIpcHandler('pages:read', (payload) => {
    const path = String((payload as { path?: string })?.path ?? '')
    if (!path) throw new Error('path가 필요합니다')
    return readPageFileGuarded(path)
  })
  registerIpcHandler('app:open-external', (payload) => {
    const url = String((payload as { url?: string })?.url ?? '')
    const client = createClientFromStoredCredentials()
    const baseUrl = client?.identity.baseUrl ?? null
    if (!isAllowedExternalUrl(url, baseUrl)) {
      throw new Error('연결된 사이트의 페이지만 열 수 있습니다')
    }
    void import('electron').then(({ shell }) => shell.openExternal(url))
    return { ok: true }
  })
  registerIpcHandler('spaces:pull', async (payload) => {
    const client = requireClient()
    const spaceKey = String((payload as { spaceKey?: string })?.spaceKey ?? '')
    if (!spaceKey) throw new Error('spaceKey가 필요합니다')
    const spaces = await client.listAllSpaces()
    const space = spaces.find((candidate) => candidate.key === spaceKey)
    if (!space) throw new Error(`스페이스를 찾을 수 없습니다: ${spaceKey}`)

    pullCancelRequests.delete(spaceKey)
    try {
      return await pullSpaceByKey({
        client,
        spaceKey,
        workspaceRoot: resolveWorkspaceRoot(),
        db: getWorkspaceDb(),
        onProgress: (done, total) =>
          broadcastSyncEvent({ type: 'pull-progress', spaceKey, done, total }),
        shouldContinue: () => !pullCancelRequests.has(spaceKey),
      })
    } finally {
      pullCancelRequests.delete(spaceKey)
    }
  })
  registerIpcHandler('pull:cancel', (payload) => {
    const spaceKey = String((payload as { spaceKey?: string })?.spaceKey ?? '')
    if (spaceKey) pullCancelRequests.add(spaceKey)
    return { ok: true }
  })
}
