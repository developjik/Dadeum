import type { WebContents } from 'electron'
import type { AgentAdapter, AgentRunHandle } from '../../core/agent/types'
import type { SyncStateDb } from '../../core/store/syncState'
import type { SpaceStateMachine } from '../../core/sync/spaceStateMachine'
import { machineFor as sharedMachineFor } from '../sync/machines'

/**
 * 채팅 → 에이전트 런 오케스트레이션(계획 §8.5).
 * - 스페이스당 동시 run 1개(상태머신 agent-run 락)
 * - 이벤트는 webContents.send('agent:event', …)로 스트리밍
 * - 세션 매핑은 sync-state.db의 chat_sessions에 보관(1:1, --resume 연속)
 */
export class ChatRunService {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly activeRuns = new Map<string, { handle: AgentRunHandle; spaceKey: string }>()

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter)
  }

  machineFor(spaceKey: string): SpaceStateMachine {
    return sharedMachineFor(spaceKey) // B-2: pull/push/agent-run이 하나의 레지스트리 공유
  }

  startRun(options: {
    sender: WebContents
    adapterName: string
    spaceKey: string
    prompt: string
    spaceRoot: string
    db: SyncStateDb
  }): { runId: string } {
    const { sender, spaceKey, prompt, spaceRoot, db } = options
    const adapterName = options.adapterName || 'claude-code'
    const adapter = this.adapters.get(adapterName)
    if (!adapter) throw new Error(`에이전트 어댑터가 없습니다: ${adapterName}`)

    const machine = this.machineFor(spaceKey)
    const started = machine.apply('startAgentRun')
    if (!started.ok) {
      const blocking =
        machine.current === 'pulling'
          ? '동기화가'
          : machine.current === 'pushing'
            ? '업로드가'
            : '에이전트 편집이'
      throw new Error(`${blocking} 이미 진행 중입니다. 종료 후 다시 시도하세요.`)
    }

    let handle: AgentRunHandle
    try {
      const sessionId = db.getAgentSessionId(spaceKey) ?? undefined
      handle = adapter.start({ prompt, cwd: spaceRoot, sessionId })
    } catch (cause) {
      // start 동기 실패 시 락을 즉시 반납해 스페이스가 agent-run에 갇히지 않게 한다
      machine.apply('endAgentRun')
      throw cause
    }
    this.activeRuns.set(handle.runId, { handle, spaceKey })

    handle.onEvent((event) => {
      if (event.type === 'started' && event.sessionId) {
        db.setAgentSessionId(spaceKey, event.sessionId)
      }
      if (!sender.isDestroyed()) {
        sender.send('agent:event', { runId: handle.runId, spaceKey, event })
      }
    })

    void handle.terminal.then((state) => {
      this.activeRuns.delete(handle.runId)
      machine.apply('endAgentRun')
      if (!sender.isDestroyed()) {
        sender.send('agent:event', {
          runId: handle.runId,
          spaceKey,
          event: { type: 'terminal', state },
        })
      }
    })

    return { runId: handle.runId }
  }

  cancelRun(runId: string): void {
    this.activeRuns.get(runId)?.handle.cancel()
  }

  cancelForSpace(spaceKey: string): void {
    for (const { handle, spaceKey: runSpace } of this.activeRuns.values()) {
      if (runSpace === spaceKey) handle.cancel()
    }
  }

  /** 앱 종료(will-quit) 시 실행 중인 모든 런을 취소한다 — detached 고아 프로세스 방지. */
  cancelAll(): void {
    for (const { handle } of this.activeRuns.values()) handle.cancel()
  }
}
