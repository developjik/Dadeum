import { contextBridge, ipcRenderer } from 'electron'
import { assertWhitelistedChannel } from '../core/ipc/channels'

/**
 * renderer에 노출되는 유일한 main 경계(계획 §6-7).
 * channel 인자는 core 화이트리스트로 이중 검증된다.
 */
const confluenceLocal = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    assertWhitelistedChannel(channel)
    return ipcRenderer.invoke(channel, payload)
  },
  /** 에이전트 런 이벤트 스트림(단일 채널 — runId로 구분). */
  onAgentEvent: (listener: (payload: { runId: string; spaceKey: string; event: unknown }) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: { runId: string; spaceKey: string; event: unknown }): void => {
      listener(payload)
    }
    ipcRenderer.on('agent:event', wrapped as never)
    return () => ipcRenderer.removeListener('agent:event', wrapped as never)
  }
}

export type ConfluenceLocalApi = typeof confluenceLocal

contextBridge.exposeInMainWorld('confluenceLocal', confluenceLocal)
