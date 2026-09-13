import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { type PageRecord, SyncStateDb } from '../core/store/syncState'
import { buildPageTree, type PageTreeNode } from '../core/store/tree'
import {
  assertSyncPagePath,
  isWithinRoot,
  parsePageFile,
  workspaceLayout,
} from '../core/store/workspace'

/**
 * 워크스페이스 접근 게이트(계획 §6-7).
 * renderer가 요청하는 파일·URL은 반드시 이 모듈의 검사를 통과해야 한다.
 */
export function resolveWorkspaceRoot(): string {
  const fallback = join(app.getPath('documents'), 'ConfluenceLocal')
  if (!existsSync(fallback)) {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.mkdirSync(fallback, { recursive: true })
  }
  return fallback
}

let cachedDb: SyncStateDb | null = null

/**
 * 앱 수명 동안 열려 있는 워크스페이스 DB 싱글턴.
 * 채팅 이벤트 클로저가 런 종료 후에도 db를 사용하므로 close하면 안 된다(B-1).
 */
export function getWorkspaceDb(): SyncStateDb {
  if (cachedDb) return cachedDb
  const layout = workspaceLayout(resolveWorkspaceRoot())
  mkdirSync(layout.syncDir, { recursive: true })
  cachedDb = new SyncStateDb(layout.stateDb)
  return cachedDb
}

export function listPageTree(spaceKey: string): PageTreeNode[] {
  const pages = getWorkspaceDb().listPagesBySpace(spaceKey)
  return buildPageTree(
    pages.map((page: PageRecord) => ({
      pageId: page.pageId,
      title: page.title,
      path: page.path,
      version: page.version,
      parentId: page.parentId,
      remoteDeleted: page.remoteDeleted,
    })),
  )
}

export interface ReadPageResult {
  pageId: string
  title: string
  url: string
  version: number
  markdown: string
}

/** 페이지 파일 읽기 — 경로 탈출·비대상 파일 차단 후 원문과 메타를 반환한다. */
export function readPageFileGuarded(relativePath: string): ReadPageResult {
  const root = resolveWorkspaceRoot()
  const normalized = assertSyncPagePath(relativePath)
  const absPath = join(root, normalized)
  if (!isWithinRoot(root, absPath) || !existsSync(absPath)) {
    throw new Error(`페이지 파일을 찾을 수 없습니다: ${normalized}`)
  }
  const { meta, body } = parsePageFile(readFileSync(absPath, 'utf8'))
  return {
    pageId: meta.pageId,
    title: meta.title,
    url: meta.url,
    version: meta.version,
    markdown: body,
  }
}

/** 온보딩에 필요한 Atlassian 공식 도메인(API 토큰 발급 페이지 등). */
const TRUSTED_HOSTS = new Set(['id.atlassian.com', 'support.atlassian.com'])

/** 외부 브라우저로 열 수 있는 URL인지 판정 — 연결된 사이트와 Atlassian 공식 도메인의 https만 허용. */
export function isAllowedExternalUrl(url: string, connectedBaseUrl: string | null): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    if (TRUSTED_HOSTS.has(parsed.hostname)) return true
    if (!connectedBaseUrl) return false
    const base = new URL(connectedBaseUrl)
    return parsed.hostname === base.hostname
  } catch {
    return false
  }
}
