export {}

declare global {
  interface Window {
    /** preload contextBridge가 노출한 유일한 main 경계(src/preload/index.ts). */
    confluenceLocal?: {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>
      onAgentEvent: (
        listener: (payload: {
          runId: string
          spaceKey: string
          kind?: 'write' | 'review'
          event: unknown
        }) => void,
      ) => () => void
      onSyncEvent: (listener: (payload: unknown) => void) => () => void
      onUpdateEvent: (listener: (payload: unknown) => void) => () => void
    }
  }
}
