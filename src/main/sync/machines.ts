import { SpaceStateMachine } from '../../core/sync/spaceStateMachine'

/** 스페이스별 동기화 상태머신 레지스트리(채팅 락·폴링·push가 공유). */
const machines = new Map<string, SpaceStateMachine>()

export function machineFor(spaceKey: string): SpaceStateMachine {
  let machine = machines.get(spaceKey)
  if (!machine) {
    machine = new SpaceStateMachine()
    machines.set(spaceKey, machine)
  }
  return machine
}
