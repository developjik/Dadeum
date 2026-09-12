import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { SyncStateDb } from '../../core/store/syncState'
import { fileHashOf } from '../../core/store/hash'
import { machineFor } from './machines'
import { pullSpaceByKey } from './pullService'
import { resolveConflict } from './conflictService'
import { pushApprovedPages } from '../push/pushService'
import { isAutoPullRunning, stopAutoPull } from './pollCoordinator'

/** R-2 회귀 테스트(세대 3 아키텍트 COMMENT 조건): B-4 기동·B-2R 개인 스페이스 차단·B-7 push 후 DB 갱신. */

describe('R-2 회귀 테스트', () => {
  it('B-4: pullSpaceByKey가 전체 pull 후 자동 pull을 기동한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reg-autopull-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async (input: Request | string | URL) => {
        const url = String(input)
        if (url.includes('/api/v2/spaces/sp-x/pages')) return new Response(JSON.stringify({ results: [], _links: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.includes('/api/v2/spaces')) return new Response(JSON.stringify({ results: [{ id: 'sp-x', key: 'REG', name: '회귀' }], _links: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch
    })

    const result = await pullSpaceByKey({ client, spaceKey: 'REG', workspaceRoot: root, db })
    expect(result.pages).toBe(0)
    expect(isAutoPullRunning('REG')).toBe(true)
    stopAutoPull('REG')
    expect(isAutoPullRunning('REG')).toBe(false)
  })

  it('B-2R: 개인 스페이스(~키)에서 agent-run 중 덮어쓰기는 차단된다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reg-personal-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    mkdirSync(join(root, 'spaces/personal-63dcb/가이드'), { recursive: true })
    const relPath = 'spaces/personal-63dcb/가이드/index.md'
    writeFileSync(join(root, relPath), '---\npageId: "1001"\nspaceKey: "~63dcbacc"\ntitle: "가이드"\nversion: 2\nparentId: null\nurl: ""\nupdatedAt: null\nsyncedAt: null\n---\n\n로컬 본문')
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    db.upsertPage({
      pageId: '1001',
      spaceKey: '~63dcbacc',
      path: relPath,
      title: '가이드',
      version: 2,
      parentId: null,
      contentHash: 'stale'
    })

    // agent-run 진입(머신 키 = 원본 스페이스 키 '~63dcbacc')
    const machine = machineFor('~63dcbacc')
    machine.apply('startAgentRun')

    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async () => new Response(JSON.stringify({ id: '1001', title: '가이드', version: { number: 9 }, body: { storage: { value: '<p>원격</p>' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    })

    await expect(
      resolveConflict({ choice: 'overwrite', path: relPath, pageId: '1001', client, workspaceRoot: root, db })
    ).rejects.toThrow(/덮어쓸 수 없습니다/)
    machine.apply('endAgentRun')
  })

  it('B-7: push 후 db 버전·해시가 갱신된다(영구 dirty 해소)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reg-pushdb-'))
    mkdirSync(join(root, '.sync'), { recursive: true })
    mkdirSync(join(root, 'spaces/DEV/가이드'), { recursive: true })
    const relPath = 'spaces/DEV/가이드/index.md'
    writeFileSync(
      join(root, relPath),
      '---\npageId: "1001"\nspaceKey: "DEV"\ntitle: "가이드"\nversion: 2\nparentId: null\nurl: "https://acme.atlassian.net/wiki/spaces/DEV/pages/1001"\nupdatedAt: null\nsyncedAt: null\n---\n\n수정 본문'
    )
    const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
    db.upsertPage({
      pageId: '1001',
      spaceKey: 'DEV',
      path: relPath,
      title: '가이드',
      version: 2,
      parentId: null,
      contentHash: 'old-hash'
    })

    const snapshot = {
      capturedAt: new Date().toISOString(),
      entries: new Map([[relPath, { hash: fileHashOf(readFileSync(join(root, relPath))) }]])
    }
    const client = new ConfluenceClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'dev@acme.io',
      apiToken: 'tok',
      sleep: () => Promise.resolve(),
      fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v2/pages/1001') && method === 'GET') {
          return new Response(JSON.stringify({ id: '1001', title: '가이드', version: { number: 2 }, body: { storage: { value: '<p>서버</p>' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/api/v2/pages/1001') && method === 'PUT') {
          const requested = JSON.parse(String(init?.body)) as { version: { number: number } }
          return new Response(JSON.stringify({ id: '1001', title: '가이드', version: { number: requested.version.number } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch
    })

    const outcome = await pushApprovedPages({
      client,
      workspaceRoot: root,
      db,
      machine: machineFor('DEV'),
      snapshot,
      approvedPaths: [relPath],
      spaceId: 'sp-1'
    })

    expect(outcome.uploaded).toHaveLength(1)
    const page = db.getPage('1001')
    expect(page?.version).toBe(3)
    expect(page?.contentHash).toBe(fileHashOf(readFileSync(join(root, relPath))))
    expect(db.getPage('1001')?.contentHash).not.toBe('old-hash')
  })
})
