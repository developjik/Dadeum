import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfluenceClient } from '../../core/confluence/client'
import { SyncStateDb } from '../../core/store/syncState'
import { machineFor } from './machines'
import { pullFullSpace } from './pullService'

/**
 * 풀pull 안전장치 회귀:
 * - dirty(미푸시 로컬 편집) 파일을 덮어쓰지 않는다(증분 pull과 동일 기준)
 * - agent-run·push 중에는 상태머신 락으로 실행을 차단한다
 * - 풀pull 후 원격 삭제 페이지를 tombstone(.sync/trash 이동 + remote_deleted) 처리한다
 */

interface MutableFake {
  pageSummaries: Array<{
    id: string
    title: string
    version: { number: number }
    parentId: string | null
  }>
  storage: Record<string, string>
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeClient(fake: MutableFake, spaceId = 'sp-1'): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: 'https://acme.atlassian.net',
    email: 'dev@acme.io',
    apiToken: 'tok',
    sleep: () => Promise.resolve(),
    fetchImpl: (async (input: Request | string | URL) => {
      const url = String(input)
      if (url.includes(`/api/v2/spaces/${spaceId}/pages`)) {
        return jsonResponse({ results: fake.pageSummaries, _links: {} })
      }
      for (const [pageId, storageValue] of Object.entries(fake.storage)) {
        const summary = fake.pageSummaries.find((page) => page.id === pageId)
        if (url.includes(`/api/v2/pages/${pageId}`)) {
          return jsonResponse({
            id: pageId,
            title: summary?.title ?? pageId,
            version: { number: summary?.version.number ?? 1 },
            body: { storage: { value: storageValue } },
          })
        }
      }
      if (url.includes('/child/attachment')) return jsonResponse({ results: [] })
      return jsonResponse({ results: [], _links: {} })
    }) as unknown as typeof fetch,
  })
}

function setup(spaceKey: string): { root: string; db: SyncStateDb } {
  const root = mkdtempSync(join(tmpdir(), `pull-safety-${spaceKey}-`))
  mkdirSync(join(root, '.sync'), { recursive: true })
  const db = new SyncStateDb(join(root, '.sync', 'sync-state.db'))
  return { root, db }
}

describe('풀pull 안전장치(P0 회귀)', () => {
  it('dirty 페이지는 덮어쓰지 않고 skippedDirty로 보고한다(로컬 편집 보존)', async () => {
    const { root, db } = setup('DIRTYA')
    const fake: MutableFake = {
      pageSummaries: [{ id: '990001', title: '가이드', version: { number: 3 }, parentId: null }],
      storage: { '990001': '<p>원격 본문 v3</p>' },
    }
    const client = fakeClient(fake, 'sp-dirtya')
    const first = await pullFullSpace({
      client,
      space: { id: 'sp-dirtya', key: 'DIRTYA', name: '테스트' },
      workspaceRoot: root,
      db,
    })
    expect(first.skippedDirty).toBe(0)

    // 사용자(에이전트)가 로컬 편집
    const indexPath = join(root, 'spaces/DIRTYA/가이드/index.md')
    writeFileSync(
      indexPath,
      readFileSync(indexPath, 'utf8').replace('원격 본문 v3', '로컬 편집!'),
      'utf8',
    )

    // 원격이 v4로 바뀐 상태에서 재 pull
    fake.pageSummaries[0]!.version.number = 4
    fake.storage['990001'] = '<p>원격 본문 v4</p>'
    const second = await pullFullSpace({
      client,
      space: { id: 'sp-dirtya', key: 'DIRTYA', name: '테스트' },
      workspaceRoot: root,
      db,
    })

    expect(second.skippedDirty).toBe(1)
    // 로컬 편집이 보존된다
    expect(readFileSync(indexPath, 'utf8')).toContain('로컬 편집!')
    // db 해시가 갱신되지 않아 충돌 후보 스캔이 계속 본다
    const record = db.getPage('990001')
    expect(record?.version).toBe(3)
    db.close()
  })

  it('agent-run 중 풀pull은 차단된다(상태머신 락)', async () => {
    const { root, db } = setup('LOCKB')
    const client = fakeClient({ pageSummaries: [], storage: {} }, 'sp-lockb')
    const machine = machineFor('LOCKB')
    machine.apply('startAgentRun')
    await expect(
      pullFullSpace({
        client,
        space: { id: 'sp-lockb', key: 'LOCKB', name: '테스트' },
        workspaceRoot: root,
        db,
      }),
    ).rejects.toThrow(/전체 동기화/)
    machine.apply('endAgentRun')
    db.close()
  })

  it('풀pull 후 원격에서 삭제된 페이지를 tombstone 처리한다', async () => {
    const { root, db } = setup('TOMBC')
    const fake: MutableFake = {
      pageSummaries: [
        { id: '880001', title: '남는 페이지', version: { number: 1 }, parentId: null },
        { id: '880002', title: '삭제된 페이지', version: { number: 1 }, parentId: null },
      ],
      storage: { '880001': '<p>남음</p>', '880002': '<p>삭제됨</p>' },
    }
    const client = fakeClient(fake, 'sp-tombc')
    await pullFullSpace({
      client,
      space: { id: 'sp-tombc', key: 'TOMBC', name: '테스트' },
      workspaceRoot: root,
      db,
    })
    expect(existsSync(join(root, 'spaces/TOMBC/삭제된-페이지/index.md'))).toBe(true)

    // 원격에서 880002가 삭제된 상태로 재 pull
    fake.pageSummaries = [fake.pageSummaries[0]!]
    const second = await pullFullSpace({
      client,
      space: { id: 'sp-tombc', key: 'TOMBC', name: '테스트' },
      workspaceRoot: root,
      db,
    })
    expect(second.tombstoned).toBe(1)
    expect(db.getPage('880002')?.remoteDeleted).toBe(true)
    expect(existsSync(join(root, 'spaces/TOMBC/삭제된-페이지/index.md'))).toBe(false)
    // 자동 삭제가 아니라 trash 이동 백업이다
    const trashRoot = join(root, '.sync', 'trash')
    expect(readdirSync(trashRoot).length).toBeGreaterThan(0)
    db.close()
  })
})
