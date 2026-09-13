import { contextBridge, ipcRenderer } from 'electron'
import { assertWhitelistedChannel } from '../core/ipc/channels'

/**
 * renderer에 노출되는 유일한 main 경계(계획 §6-7).
 * channel 인자는 core 화이트리스트로 이중 검증된다.
 */
const confluenceLocal = {
  invoke: async (channel: string, payload?: unknown): Promise<unknown> => {
    assertWhitelistedChannel(channel)
    try {
      return await ipcRenderer.invoke(channel, payload)
    } catch (cause) {
      throw reassembleIpcError(cause)
    }
  },
  /** 에이전트 런 이벤트 스트림(단일 채널 — runId로 구분). */
  onAgentEvent: (
    listener: (payload: { runId: string; spaceKey: string; event: unknown }) => void,
  ): (() => void) => {
    const wrapped = (
      _event: unknown,
      payload: { runId: string; spaceKey: string; event: unknown },
    ): void => {
      listener(payload)
    }
    ipcRenderer.on('agent:event', wrapped as never)
    return () => ipcRenderer.removeListener('agent:event', wrapped as never)
  },
  /** 동기화 알림 스트림(폴링 결과 — 충돌 후보·트리 자동 갱신용). */
  onSyncEvent: (listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload)
    }
    ipcRenderer.on('sync:event', wrapped as never)
    return () => ipcRenderer.removeListener('sync:event', wrapped as never)
  },
  /** 수동 업데이트 진행 스트림(다운로드 진행률·완료·실패). */
  onUpdateEvent: (listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      listener(payload)
    }
    ipcRenderer.on('update:event', wrapped as never)
    return () => ipcRenderer.removeListener('update:event', wrapped as never)
  },
}

/** main이 마커로 보낸 구조화 오류를 Error로 재조립(kind/status 포함). */
function reassembleIpcError(cause: unknown): unknown {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const jsonStart = raw.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        __ipcError?: boolean
        name?: string
        message?: string
        kind?: string
        status?: number
      }
      if (parsed.__ipcError) {
        const error = new Error(parsed.message ?? raw)
        error.name = parsed.name ?? 'IpcError'
        if (parsed.kind !== undefined) (error as { kind?: string }).kind = parsed.kind
        if (parsed.status !== undefined) (error as { status?: number }).status = parsed.status
        return error
      }
    } catch {
      // 마커가 아니면 원본 그대로
    }
  }
  return cause instanceof Error ? cause : new Error(raw)
}

export type ConfluenceLocalApi = typeof confluenceLocal

contextBridge.exposeInMainWorld('confluenceLocal', confluenceLocal)
