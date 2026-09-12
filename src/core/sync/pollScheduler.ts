/**
 * 폴링 스케줄러(계획 §8.1): 스페이스별 주기 폴링 + 무작위 지터로 동시 폭발 방지.
 * 타이머는 주입형 — 테스트에서 결정적으로 구동한다.
 */
export interface PollTimer {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimer: PollTimer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 기본 주기에 지터(±ratio)를 적용한 다음 폴링 지연(ms)을 계산한다. */
export function computeNextDelay(baseMs: number, jitterRatio: number, rand: number): number {
  const bounded = Math.max(0, Math.min(1, rand))
  return Math.max(0, Math.round(baseMs * (1 - jitterRatio + 2 * jitterRatio * bounded)))
}

export class PollScheduler {
  private handle: unknown = null
  private running = false

  constructor(
    private readonly options: {
      baseIntervalMs: number
      jitterRatio?: number
      onPoll: () => Promise<void>
      timer?: PollTimer
      random?: () => number
      /** 폴링을 건너뛰어야 하면 true(agent-run 등). 건너뛰면 연기로 기록한다. */
      shouldSkip?: () => boolean
    }
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.handle !== null) {
      const timer = this.options.timer ?? realTimer
      timer.clearTimeout(this.handle)
      this.handle = null
    }
  }

  private scheduleNext(): void {
    if (!this.running) return
    const timer = this.options.timer ?? realTimer
    const random = this.options.random ?? Math.random
    const delay = computeNextDelay(this.options.baseIntervalMs, this.options.jitterRatio ?? 0.1, random())
    this.handle = timer.setTimeout(() => {
      void this.tick()
    }, delay)
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    if (this.options.shouldSkip?.() !== true) {
      try {
        await this.options.onPoll()
      } catch {
        // 폴링 실패는 스케줄을 중단시키지 않는다(다음 주기 재시도)
      }
    }
    this.scheduleNext()
  }
}
