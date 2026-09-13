import { describe, expect, it } from 'vitest'
import {
  computeBackoffMultiplier,
  computeNextDelay,
  PollScheduler,
  type PollTimer,
} from './pollScheduler'

/** 수동 구동 타이머 — 지연 콜백을 큐에 담아 테스트가 결정적으로 전진시킨다. */
function manualTimer(): PollTimer & {
  advance(): void
  pendingDelay(): number | null
} {
  let handle = 0
  let lastDelay = 0
  let queue: Array<{ id: number; fn: () => void }> = []
  return {
    setTimeout: (fn, ms) => {
      handle += 1
      queue.push({ id: handle, fn })
      lastDelay = ms
      return handle
    },
    clearTimeout: (h) => {
      queue = queue.filter((entry) => entry.id !== h)
    },
    advance: () => {
      const entry = queue.shift()
      entry?.fn()
    },
    pendingDelay: () => (queue.length > 0 ? lastDelay : null),
  }
}

describe('computeBackoffMultiplier', () => {
  it('연속 실패마다 2배씩 늘고 상한에서 멈춘다', () => {
    expect(computeBackoffMultiplier(0)).toBe(1)
    expect(computeBackoffMultiplier(1)).toBe(2)
    expect(computeBackoffMultiplier(2)).toBe(4)
    expect(computeBackoffMultiplier(3)).toBe(4) // 기본 상한 4배
    expect(computeBackoffMultiplier(9, 8)).toBe(8) // 사용자 상한
  })
})

describe('computeNextDelay', () => {
  it('지터 중앙값(rand=0.5)이면 기본 주기를 그대로 반환한다', () => {
    expect(computeNextDelay(300000, 0.1, 0.5)).toBe(300000)
  })
})

describe('PollScheduler', () => {
  it('연속 실패하면 지연이 백오프 배수만큼 늘어나고 성공하면 리셋된다', async () => {
    const timer = manualTimer()
    let failures = 0
    const scheduler = new PollScheduler({
      baseIntervalMs: 1000,
      jitterRatio: 0, // 지터 제거 — 배수만 검증
      onPoll: async () => {
        if (failures > 0) throw new Error(`boom ${failures}`)
      },
      timer,
      random: () => 0.5,
    })
    scheduler.start()
    expect(timer.pendingDelay()).toBe(1000)

    // 1차 실패 → 연속 실패 1 → 다음 지연 2배
    failures = 1
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.failureStreak).toBe(1)
    expect(timer.pendingDelay()).toBe(2000)

    // 2차 실패 → 연속 실패 2 → 다음 지연 4배(상한)
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.failureStreak).toBe(2)
    expect(timer.pendingDelay()).toBe(4000)

    // 3차 실패 → 상한 유지
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.failureStreak).toBe(3)
    expect(timer.pendingDelay()).toBe(4000)

    // 성공 → streak 리셋, 지연 기본 복귀
    failures = 0
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.failureStreak).toBe(0)
    expect(timer.pendingDelay()).toBe(1000)
    scheduler.stop()
  })

  it('실패 시 onError에 에러가 전달된다', async () => {
    const timer = manualTimer()
    const seen: unknown[] = []
    const scheduler = new PollScheduler({
      baseIntervalMs: 1000,
      onPoll: async () => {
        throw new Error('network down')
      },
      onError: (error) => seen.push(error),
      timer,
      random: () => 0.5,
    })
    scheduler.start()
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('network down')
    scheduler.stop()
  })

  it('shouldSkip이면 onPoll을 부르지 않고 스케줄은 유지한다', async () => {
    const timer = manualTimer()
    let polls = 0
    const scheduler = new PollScheduler({
      baseIntervalMs: 1000,
      onPoll: async () => {
        polls += 1
      },
      shouldSkip: () => true,
      timer,
      random: () => 0.5,
    })
    scheduler.start()
    timer.advance()
    await Promise.resolve()
    await Promise.resolve()
    expect(polls).toBe(0)
    expect(timer.pendingDelay()).toBe(1000)
    scheduler.stop()
  })
})
