import { join } from 'node:path'
import type { ConfluenceClient, ConfluenceSpace } from '../../core/confluence/client'
import type { SyncStateDb } from '../../core/store/syncState'
import { PollScheduler, realTimer } from '../../core/sync/pollScheduler'
import { reconcilePageIds } from '../../core/sync/reconciler'
import { machineFor } from './machines'
import { pullIncremental } from './pullIncremental'
import { broadcastSyncEvent } from './syncNotifier'

/**
 * ef-6/AC-7 자동 pull: 스페이스별 PollScheduler(기본 300초, 지터 ±10%).
 * agent-run·pushing 중에는 shouldSkip으로 건너뛰고(연기), pull 실패는 스케줄 유지.
 * 각 폴링마다 원격 삭제 대차(reconciler)를 실행해 원격 삭제 페이지를 tombstone 처리한다.
 */
const schedulers = new Map<string, PollScheduler>()

/**
 * 증분 기준점 갱신: 직전 'pull 시작 시각' 기준 since를 반환하고 이번 pull 시작을 기록한다.
 * pull 종료 시각(MAX(synced_at))을 기준으로 쓰면 긴 pull 진행 중 발생한 원격 변경이
 * 다음 증분 쿼리에서 영구히 누락되므로 시작 시각으로 닫는다(5분 overlap 유지).
 */
export function beginIncrementalPull(db: SyncStateDb, spaceKey: string): string {
  const previous = db.lastPullStartAt(spaceKey) ?? db.lastSyncedAt(spaceKey)
  const base = previous ? Date.parse(previous) : Date.now()
  db.recordPullStart(spaceKey, new Date().toISOString())
  return new Date(base - 5 * 60 * 1000).toISOString()
}

export function startAutoPull(options: {
  client: ConfluenceClient
  space: ConfluenceSpace
  workspaceRoot: string
  db: SyncStateDb
  intervalMs?: number
}): void {
  const { client, space, workspaceRoot, db } = options
  if (schedulers.has(space.key)) return
  const scheduler = new PollScheduler({
    baseIntervalMs: options.intervalMs ?? 300000,
    jitterRatio: 0.1,
    shouldSkip: () => {
      const machine = machineFor(space.key)
      return machine.current === 'agent-run' || machine.current === 'pushing'
    },
    onPoll: async () => {
      const sinceIso = beginIncrementalPull(db, space.key)
      const result = await pullIncremental({
        client,
        space,
        workspaceRoot,
        db,
        sinceIso,
      })

      // 원격 삭제 대차(F-3): 원격 목록에 없는 로컬 페이지를 tombstone(.sync/trash 이동)
      let tombstoned = 0
      try {
        const remotePages = await client.listAllPagesBySpace(space.id)
        const reconciliation = reconcilePageIds({
          spaceKey: space.key,
          remotePageIds: remotePages.map((page) => page.id),
          db,
          workspaceRoot,
          trashDir: join(workspaceRoot, '.sync', 'trash'),
          now: new Date(),
        })
        tombstoned = reconciliation.tombstoned.length
      } catch {
        // 대차 실패는 폴링 자체를 실패로 만들지 않는다(다음 폴링에서 재시도)
      }

      const machine = machineFor(space.key)
      if (machine.current === 'idle' && !machine.hasDeferredPull()) {
        machine.clearDeferredPull()
      }

      if (
        result.updated.length > 0 ||
        result.skippedDirty.length > 0 ||
        result.failed.length > 0 ||
        tombstoned > 0
      ) {
        broadcastSyncEvent({
          type: 'poll',
          spaceKey: space.key,
          updated: result.updated.length,
          skippedDirty: result.skippedDirty.length,
          tombstoned,
          failed: result.failed.length,
        })
      }
    },
    timer: realTimer,
    random: Math.random,
  })
  scheduler.start()
  schedulers.set(space.key, scheduler)
}

export function isAutoPullRunning(spaceKey: string): boolean {
  return schedulers.has(spaceKey)
}

export function stopAutoPull(spaceKey: string): void {
  schedulers.get(spaceKey)?.stop()
  schedulers.delete(spaceKey)
}

export function stopAllAutoPull(): void {
  for (const scheduler of schedulers.values()) scheduler.stop()
  schedulers.clear()
}

/** 앱 재시작 시 자동 폴링 복원용: db에 기록된 스페이스의 폴링 여부. */
export function stoppedSpaces(db: SyncStateDb): string[] {
  return db.listSpaceKeys().filter((spaceKey) => !schedulers.has(spaceKey))
}
