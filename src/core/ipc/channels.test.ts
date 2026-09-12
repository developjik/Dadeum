import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, assertWhitelistedChannel, isWhitelistedChannel } from './channels'

describe('IPC channel whitelist', () => {
  it('화이트리스트에 등록된 채널만 허용한다', () => {
    expect(isWhitelistedChannel('app:versions')).toBe(true)
    expect(isWhitelistedChannel('app:nonexistent')).toBe(false)
    expect(isWhitelistedChannel('')).toBe(false)
    expect(isWhitelistedChannel('node:evil')).toBe(false)
  })

  it('assert는 위반 시 throw한다', () => {
    expect(() => assertWhitelistedChannel('app:versions')).not.toThrow()
    expect(() => assertWhitelistedChannel('system:panic')).toThrow(/허용되지 않은 IPC 채널/)
  })

  it('채널 목록은 비어 있지 않다', () => {
    expect(IPC_CHANNELS.length).toBeGreaterThan(0)
  })
})
