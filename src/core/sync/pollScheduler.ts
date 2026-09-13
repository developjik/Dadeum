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
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 기본 주기에 지터(±ratio)를 적용한 다음 폴링 지연(ms)을 계산한다. */
export function computeNextDelay(baseMs: number, jitterRatio: number, rand: number): number {
  const bounded = Math.max(0, Math.min(1, rand))
  return Math.max(0, Math.round(baseMs * (1 - jitterRatio + 2 * jitterRatio * bounded)))
}

/**
 * 연속 실패 백오프 배수 — 실패할 때마다 2배씩 늘리고 상한(maxMultiplier)에서 멈춘다.
 * 성공(0회 연속)이면 1. 서버 오류·네트워크 단절 시 일정 주기 재시도가 사용자에게
 * 보이지 않는 5분 간격 실패 반복이 되지 않게 한다.
 */
export function computeBackoffMultiplier(consecutiveFailures: number, maxMultiplier = 4): number {
  if (consecutiveFailures <= 0) return 1
  return Math.min(2 ** consecutiveFailures, maxMultiplier)
}

export class PollScheduler {
  private handle: unknown = null
  private running = false
  private consecutiveFailures = 0

  constructor(
    private readonly options: {
      baseIntervalMs: number
      jitterRatio?: number
      onPoll: () => Promise<void>
      /** 폴링 실패 시 호출(사용자 표시용). 스케줄에는 영향을 주지 않는다. */
      onError?: (error: unknown) => void
      /** 연속 실패 백오프 상한 배수(기본 4). */
      maxBackoffMultiplier?: number
      timer?: PollTimer
      random?: () => number
      /** 폴링을 건너뛰어야 하면 true(agent-run 등). 건너뛰면 연기로 기록한다. */
      shouldSkip?: () => boolean
    },
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

  /** 현재 연속 실패 수 — 백오프 상태 노출·테스트용. */
  get failureStreak(): number {
    return this.consecutiveFailures
  }

  private scheduleNext(): void {
    if (!this.running) return
    const timer = this.options.timer ?? realTimer
    const random = this.options.random ?? Math.random
    const effectiveBase =
      this.options.baseIntervalMs *
      computeBackoffMultiplier(this.consecutiveFailures, this.options.maxBackoffMultiplier ?? 4)
    const delay = computeNextDelay(effectiveBase, this.options.jitterRatio ?? 0.1, random())
    this.handle = timer.setTimeout(() => {
      void this.tick()
    }, delay)
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    if (this.options.shouldSkip?.() !== true) {
      try {
        await this.options.onPoll()
        this.consecutiveFailures = 0
      } catch (error) {
        // 폴링 실패는 스케줄을 중단시키지 않는다(백오프 후 다음 주기 재시도)
        this.consecutiveFailures += 1
        this.options.onError?.(error)
      }
    }
    this.scheduleNext()
  }
}
