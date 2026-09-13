import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ConfluenceClient } from '../../core/confluence/client'
import { markdownToStorage } from '../../core/converter/markdownToStorage'
import { storageToMarkdown } from '../../core/converter/storageToMarkdown'
import { fileHashOf } from '../../core/store/hash'
import type { SyncStateDb } from '../../core/store/syncState'
import {
  assertSyncPagePath,
  isWithinRoot,
  parsePageFile,
  renderPageFile,
} from '../../core/store/workspace'
import { machineFor } from './machines'

export type ConflictChoice = 'overwrite' | 'take-remote' | 'manual'

/**
 * 충돌 3지 선택 처리(ef-8, AC-6 — 안전 우선, 자동 진행 금지):
 * ① 덮어쓰기 — 최신 원격 버전을 기준 버전으로 로컬 내용 업로드(원격 변경 폐기 경고)
 * ② 원격 받기 — 로컬 변경은 .sync/trash/<ts>/ 백업 후 원격 판으로 교체
 * ③ 직접 처리 — 원격 본문을 <file>.remote.md로 생성(allowlist 제외), 사용자 병합 후 재승인
 */
export async function resolveConflict(options: {
  choice: ConflictChoice
  path: string
  pageId: string
  client: ConfluenceClient
  workspaceRoot: string
  db: SyncStateDb
}): Promise<{ applied: ConflictChoice; backupPath?: string; remoteFile?: string }> {
  const { choice, path, pageId, client, workspaceRoot, db } = options
  // B-2R: 머신 키는 db의 원본 spaceKey(개인 스페이스는 디렉터리명이 personal-*로 달라짐)
  const record = db.getPage(pageId)
  const safePath = assertSyncPagePath(path)
  const spaceKey = record?.spaceKey ?? spaceKeyFromPath(safePath)
  const machine = machineFor(spaceKey)
  const absPath = join(workspaceRoot, safePath)
  if (!isWithinRoot(workspaceRoot, absPath)) {
    throw new Error(`동기 대상이 아닌 경로입니다: ${safePath}`)
  }

  if (choice === 'overwrite') {
    const started = machine.apply('startPush')
    if (!started.ok) throw new Error('에이전트 실행 중이거나 동기화 중이라 덮어쓸 수 없습니다')
    try {
      const raw = readFileSync(absPath, 'utf8')
      const { meta, body } = parsePageFile(raw)
      const remote = await client.getPageStorage(pageId) // 최신 원격 버전 = 새 기준 버전
      const storageValue = markdownToStorage(body)
      const updated = await client.updatePage({
        pageId,
        currentVersion: remote.version,
        title: meta.title,
        storageValue,
      })
      if (updated.version !== remote.version + 1) {
        throw new Error(`버전 증가 확인 실패: 기대 ${remote.version + 1}, 응답 ${updated.version}`)
      }
      const updatedRaw = renderPageFile(
        { ...meta, version: updated.version, syncedAt: new Date().toISOString() },
        body,
      )
      writeFileSync(absPath, updatedRaw, 'utf8')
      db.upsertPage({
        pageId,
        spaceKey: meta.spaceKey,
        path: safePath,
        title: meta.title,
        version: updated.version,
        parentId: meta.parentId,
        contentHash: fileHashOf(updatedRaw),
        updatedAt: null,
      })
      return { applied: 'overwrite' }
    } finally {
      machine.apply('endPush')
    }
  }

  if (choice === 'take-remote') {
    // 폴링 pull·push와 같은 index.md/db를 두고 경합하지 않게 머신 락을 취득한다
    // (overwrite와 동일 보호 — take-remote도 파일·db를 다시 쓰는 원격 조작이다).
    const started = machine.apply('startPush')
    if (!started.ok) throw new Error('에이전트 실행 중이거나 동기화 중이라 처리할 수 없습니다')
    try {
      const remote = await client.getPageStorage(pageId)
      const markdown = storageToMarkdown(remote.storageValue).markdown
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      let backupPath: string | undefined
      if (existsSync(absPath)) {
        backupPath = join(
          workspaceRoot,
          '.sync',
          'trash',
          ts,
          safePath.replace(/\/index\.md$/, '.local-backup.md'),
        )
        mkdirSync(dirname(backupPath), { recursive: true })
        writeFileSync(backupPath, readFileSync(absPath)) // 로컬 변경 1회 백업(trash는 allowlist 밖)
      }
      const baseMeta = currentMeta(absPath)
      const updatedRaw = renderPageFile(
        { ...baseMeta, version: remote.version, syncedAt: new Date().toISOString() },
        markdown,
      )
      writeFileSync(absPath, updatedRaw, 'utf8')
      // db의 version·title도 원격 판으로 갱신 — 옛값이 남으면 트리 표시·버전 검사가 어긋난다
      db.upsertPage({
        pageId,
        spaceKey: baseMeta.spaceKey,
        path: safePath,
        title: remote.title || baseMeta.title,
        version: remote.version,
        parentId: baseMeta.parentId,
        contentHash: fileHashOf(updatedRaw),
        updatedAt: null,
      })
      db.clearRemoteDeleted(pageId)
      return { applied: 'take-remote', backupPath }
    } finally {
      machine.apply('endPush')
    }
  }

  if (choice === 'manual') {
    // 원격 판을 파일로 내려쓰는 조작 — pull과 겹치면 반쪽 원격 판이 생긴다. 동일 락으로 직렬화.
    const started = machine.apply('startPush')
    if (!started.ok) throw new Error('에이전트 실행 중이거나 동기화 중이라 처리할 수 없습니다')
    try {
      const remote = await client.getPageStorage(pageId)
      const markdown = storageToMarkdown(remote.storageValue).markdown
      const remoteFile = absPath.replace(/\.md$/, '.remote.md') // allowlist 제외 — 변경 세트 유입 없음(F3)
      writeFileSync(remoteFile, markdown, 'utf8')
      return { applied: 'manual', remoteFile }
    } finally {
      machine.apply('endPush')
    }
  }

  throw new Error(`알 수 없는 충돌 처리 선택: ${String(choice)}`)
}

function currentMeta(absPath: string): {
  pageId: string
  spaceKey: string
  title: string
  version: number
  parentId: string | null
  url: string
  updatedAt: string | null
  syncedAt: string | null
} {
  return parsePageFile(readFileSync(absPath, 'utf8')).meta
}

function spaceKeyFromPath(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts[1] : path
}
