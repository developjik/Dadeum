import { describe, expect, it } from 'vitest'
import { normalizeId } from './id'

describe('normalizeId(F-9)', () => {
  it('문자열은 그대로 유지한다', () => {
    expect(normalizeId('9007199254740993')).toBe('9007199254740993')
  })

  it('숫자는 문자열로 변환한다', () => {
    expect(normalizeId(12345)).toBe('12345')
  })

  it('bigint는 문자열로 변환한다', () => {
    expect(normalizeId(9007199254740993n)).toBe('9007199254740993')
  })

  it('null/undefined/객체는 거부한다', () => {
    expect(() => normalizeId(null)).toThrow(/식별자/)
    expect(() => normalizeId(undefined)).toThrow(/식별자/)
    expect(() => normalizeId({ id: '1' })).toThrow(/식별자/)
  })
})
