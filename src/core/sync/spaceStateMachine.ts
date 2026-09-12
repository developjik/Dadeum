/**
 * 스페이스 동기화 상태머신(계획 §8.2, AC-7).
 * - agent run 실행 중: pull 연기(deferred), push 차단
 * - push 실행 중: pull 연기
 * - run 종료: deferred pull 1회 실행(호출자가 drainDeferredPull로 확인)
 * 읽기(미리보기)는 항상 허용이므로 이 머신이 막지 않는다.
 */
export type SpaceSyncState = 'idle' | 'pulling' | 'pushing' | 'agent-run'

export type SpaceSyncAction = 'startPull' | 'endPull' | 'startPush' | 'endPush' | 'startAgentRun' | 'endAgentRun'

export class SpaceStateMachine {
  private state: SpaceSyncState = 'idle'
  private deferredPull = false

  get current(): SpaceSyncState {
    return this.state
  }

  /** agent run 중에 연기된 pull이 대기 중인지. */
  hasDeferredPull(): boolean {
    return this.deferredPull
  }

  /** push 승인 후 업로드를 시작할 수 있는지(TOCTOU 2차 검사용 — F-2). */
  canStartPush(): boolean {
    return this.state === 'idle'
  }

  canStartPull(): boolean {
    return this.state === 'idle' || this.state === 'agent-run' || this.state === 'pushing'
  }

  apply(action: SpaceSyncAction): { ok: boolean; state: SpaceSyncState; note?: 'pull-deferred' } {
    switch (action) {
      case 'startPull':
        if (this.state === 'agent-run') {
          this.deferredPull = true
          return { ok: true, state: this.state, note: 'pull-deferred' }
        }
        if (this.state === 'pushing') {
          this.deferredPull = true
          return { ok: true, state: this.state, note: 'pull-deferred' }
        }
        if (this.state === 'idle') {
          this.state = 'pulling'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      case 'endPull':
        if (this.state === 'pulling') {
          this.state = 'idle'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      case 'startPush':
        if (this.state === 'agent-run') return { ok: false, state: this.state }
        if (this.state === 'idle') {
          this.state = 'pushing'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      case 'endPush':
        if (this.state === 'pushing') {
          this.state = 'idle'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      case 'startAgentRun':
        if (this.state === 'idle') {
          this.state = 'agent-run'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      case 'endAgentRun':
        if (this.state === 'agent-run') {
          this.state = 'idle'
          return { ok: true, state: this.state }
        }
        return { ok: false, state: this.state }
      default:
        return { ok: false, state: this.state }
    }
  }
}
