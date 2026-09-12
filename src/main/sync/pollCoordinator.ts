import type { ConfluenceClient, ConfluenceSpace } from '../../core/confluence/client'
import { PollScheduler, realTimer } from '../../core/sync/pollScheduler'
import type { SyncStateDb } from '../../core/store/syncState'
import { machineFor } from './machines'
import { pullIncremental } from './pullIncremental'

/**
 * ef-6/AC-7 자동 pull: 스페이스별 PollScheduler(기본 300초, 지터 ±10%).
 * agent-run·pushing 중에는 shouldSkip으로 건너뛰고(연기), pull 실패는 스케줄 유지.
 */
const schedulers = new Map<string, PollScheduler>()

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
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString() // overlap window
      await pullIncremental({ client, space, workspaceRoot, db, sinceIso: since })
    },
    timer: realTimer,
    random: Math.random
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
