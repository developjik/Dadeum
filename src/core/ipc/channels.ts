/**
 * typed IPC 화이트리스트(계획 §6-7 보안 경계).
 * main/preload 양쪽에서 이 모듈 하나만을 통해 채널 허용 여부를 판정한다.
 * renderer↔main 경계는 여기 나열된 채널로만 소통할 수 있다.
 */
export const IPC_CHANNELS = [
  'app:versions',
  'auth:connect',
  'auth:status',
  'auth:disconnect',
  'spaces:list',
  'spaces:pull',
  'pages:tree',
  'pages:read',
  'pages:write',
  'app:open-external',
  'agent:run',
  'agent:cancel',
  'agent:list',
  'agent:select',
  'push:changeset',
  'push:approve',
  'pages:diff',
  'conflict:list',
  'conflict:resolve',
  'spaces:poll',
  'pull:cancel',
  'update:check',
  'update:install',
  'review:run',
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

export function isWhitelistedChannel(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel)
}

/** 화이트리스트 위반 시 throw한다(main 등록·preload 호출 양쪽에서 사용). */
export function assertWhitelistedChannel(channel: string): asserts channel is IpcChannel {
  if (!isWhitelistedChannel(channel)) {
    throw new Error(`허용되지 않은 IPC 채널: ${channel}`)
  }
}
