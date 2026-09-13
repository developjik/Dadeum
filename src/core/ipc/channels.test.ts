import { describe, expect, it } from 'vitest'
import { assertWhitelistedChannel, IPC_CHANNELS, isWhitelistedChannel } from './channels'

describe('IPC channel whitelist', () => {
  it('화이트리스트에 등록된 채널만 허용한다', () => {
    expect(isWhitelistedChannel('app:versions')).toBe(true)
    expect(isWhitelistedChannel('app:nonexistent')).toBe(false)
    expect(isWhitelistedChannel('')).toBe(false)
    expect(isWhitelistedChannel('node:evil')).toBe(false)
  })

  it('페이지 읽기·쓰기 채널이 모두 등록되어 있다', () => {
    expect(isWhitelistedChannel('pages:read')).toBe(true)
    expect(isWhitelistedChannel('pages:write')).toBe(true)
  })

  it('에이전트 조회·선택 채널이 등록되어 있다', () => {
    expect(isWhitelistedChannel('agent:run')).toBe(true)
    expect(isWhitelistedChannel('agent:cancel')).toBe(true)
    expect(isWhitelistedChannel('agent:list')).toBe(true)
    expect(isWhitelistedChannel('agent:select')).toBe(true)
  })

  it('assert는 위반 시 throw한다', () => {
    expect(() => assertWhitelistedChannel('app:versions')).not.toThrow()
    expect(() => assertWhitelistedChannel('system:panic')).toThrow(/허용되지 않은 IPC 채널/)
  })

  it('채널 목록은 비어 있지 않다', () => {
    expect(IPC_CHANNELS.length).toBeGreaterThan(0)
  })
})
