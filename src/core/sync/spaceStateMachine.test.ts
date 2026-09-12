import { describe, expect, it } from 'vitest'
import { SpaceStateMachine } from './spaceStateMachine'

describe('SpaceStateMachine', () => {
  it('idle에서 pulling/pushing/agent-run으로 진입하고 복귀한다', () => {
    const sm = new SpaceStateMachine()
    expect(sm.apply('startPull')).toMatchObject({ ok: true, state: 'pulling' })
    expect(sm.apply('endPull')).toMatchObject({ ok: true, state: 'idle' })
    expect(sm.apply('startPush')).toMatchObject({ ok: true, state: 'pushing' })
    expect(sm.apply('endPush')).toMatchObject({ ok: true, state: 'idle' })
    expect(sm.apply('startAgentRun')).toMatchObject({ ok: true, state: 'agent-run' })
    expect(sm.apply('endAgentRun')).toMatchObject({ ok: true, state: 'idle' })
  })

  it('agent run 중 pull은 연기로 기록되고 run 종료 후 소비된다', () => {
    const sm = new SpaceStateMachine()
    sm.apply('startAgentRun')
    const result = sm.apply('startPull')
    expect(result).toMatchObject({ ok: true, note: 'pull-deferred' })
    expect(sm.hasDeferredPull()).toBe(true)
    sm.apply('endAgentRun')
    expect(sm.hasDeferredPull()).toBe(true) // 소비는 호출자 몫(드레인 후 재호출)
  })

  it('agent run 중 push는 차단된다(F-2)', () => {
    const sm = new SpaceStateMachine()
    sm.apply('startAgentRun')
    expect(sm.canStartPush()).toBe(false)
    expect(sm.apply('startPush').ok).toBe(false)
    sm.apply('endAgentRun')
    expect(sm.canStartPush()).toBe(true)
  })

  it('pushing 중 pull은 연기된다', () => {
    const sm = new SpaceStateMachine()
    sm.apply('startPush')
    expect(sm.apply('startPull').note).toBe('pull-deferred')
    expect(sm.current).toBe('pushing')
    sm.apply('endPush')
    expect(sm.hasDeferredPull()).toBe(true)
  })

  it('idle이 아닌 상태에서 push 종료 등 불가 전이는 거부한다', () => {
    const sm = new SpaceStateMachine()
    expect(sm.apply('endPush').ok).toBe(false)
    expect(sm.apply('endAgentRun').ok).toBe(false)
  })
})
