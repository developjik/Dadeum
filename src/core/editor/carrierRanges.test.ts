import { describe, expect, it } from 'vitest'
import { carrierFence, contentHash } from '../converter/carriers'
import { findCarrierRanges } from './carrierRanges'

const XML =
  '<ac:structured-macro ac:name="info"><ac:rich-text-body>안내</ac:rich-text-body></ac:structured-macro>'

function page(...blocks: string[]): string {
  return ['제목 문단', '', ...blocks, '', '마무리 문단'].join('\n')
}

describe('findCarrierRanges', () => {
  it('3백틱 캐리어의 전체 구간과 내용 구간, id/name을 찾는다', () => {
    const carrier = carrierFence('info', contentHash(XML), XML)
    const text = page(carrier)
    const ranges = findCarrierRanges(text)

    expect(ranges).toHaveLength(1)
    const range = ranges[0]!
    expect(text.slice(range.from, range.to)).toBe(carrier)
    expect(text.slice(range.contentFrom, range.contentTo)).toBe(XML)
    expect(range.id).toBe(contentHash(XML))
    expect(range.name).toBe('info')
  })

  it('내부에 ```가 있는 캐리어는 더 긴 펜스로 감싸지며 조기 종료되지 않는다', () => {
    const tricky = '<p>코드 예시</p>\n```\nplain\n```'
    const carrier = carrierFence('fragment', contentHash(tricky), tricky)
    const ranges = findCarrierRanges(page(carrier))

    expect(ranges).toHaveLength(1)
    expect(page(carrier).slice(ranges[0]!.contentFrom, ranges[0]!.contentTo)).toBe(tricky)
  })

  it('캐리어 여러 개와 사이 텍스트를 모두 정확히 잡는다', () => {
    const xmlA = '<ac:task-list/>'
    const xmlB =
      '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell /></ac:layout-section></ac:layout>'
    const carrierA = carrierFence('a', contentHash(xmlA), xmlA)
    const carrierB = carrierFence('b', contentHash(xmlB), xmlB)
    const text = page(carrierA, '중간 문단', carrierB)

    const ranges = findCarrierRanges(text)
    expect(ranges).toHaveLength(2)
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe(carrierA)
    expect(text.slice(ranges[1]!.from, ranges[1]!.to)).toBe(carrierB)
    expect(ranges[0]!.to).toBeLessThan(ranges[1]!.from)
  })

  it('confluence-storage이 아닌 코드블록은 무시한다', () => {
    const text = page('```js\nconsole.log(1)\n```')
    expect(findCarrierRanges(text)).toHaveLength(0)
  })

  it('info string이 비었거나 다른 매크로명이어도 confluence-storage면 잠근다', () => {
    const text = page('````confluence-storage name=x id=deadbeef\n<ac:placeholder/>\n````')
    const ranges = findCarrierRanges(text)
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.id).toBe('deadbeef')
    expect(ranges[0]!.name).toBe('x')
  })

  it('닫히지 않은 펜스는 잠그지 않는다(저장 게이트가 수습)', () => {
    const text = page('```confluence-training name=x id=abcd1234\n<ac:x/>')
    expect(findCarrierRanges(text)).toHaveLength(0)
  })

  it('빈 문서·캐리어 없는 문서는 빈 배열을 반환한다', () => {
    expect(findCarrierRanges('')).toEqual([])
    expect(findCarrierRanges('일반 텍스트만\n있는 문서')).toEqual([])
  })
})
