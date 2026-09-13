import { describe, expect, it } from 'vitest'
import {
  describeInlineCarrier,
  extractCarrierBodyMarkdown,
  inlineRefPattern,
  previewContentHash,
  splitCarrierStorage,
} from './carrierContent'

describe('extractCarrierBodyMarkdown', () => {
  it('레이아웃 셀 본문을 순서대로 Markdown으로 노출한다', () => {
    const xml =
      '<ac:layout><ac:layout-section ac:type="two_equal">' +
      '<ac:layout-cell><h2>개요</h2><p>왼쪽 칸 본문</p></ac:layout-cell>' +
      '<ac:layout-cell><p>오른쪽 칸 본문</p></ac:layout-cell>' +
      '</ac:layout-section></ac:layout>'
    const markdown = extractCarrierBodyMarkdown(xml)
    expect(markdown).toContain('## 개요')
    expect(markdown).toContain('왼쪽 칸 본문')
    expect(markdown).toContain('오른쪽 칸 본문')
  })

  it('매크로 title 파라미터는 굵게, rich-text-body는 본문으로 노출한다', () => {
    const xml =
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">공지 제목</ac:parameter>' +
      '<ac:rich-text-body><p>패널 본문</p></ac:rich-text-body></ac:structured-macro>'
    const markdown = extractCarrierBodyMarkdown(xml)
    expect(markdown).toContain('**공지 제목**')
    expect(markdown).toContain('패널 본문')
  })

  it('plain-text-body(코드 매크로)는 코드펜스로 노출한다', () => {
    const xml =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[const x = 1]]></ac:plain-text-body></ac:structured-macro>'
    const markdown = extractCarrierBodyMarkdown(xml)
    expect(markdown).toContain('```\nconst x = 1\n```')
  })

  it('병합 셀 표는 속성을 벗긴 근사 Markdown 표로 노출한다', () => {
    const xml =
      '<table><tbody><tr><th colspan="2">제목</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>'
    const markdown = extractCarrierBodyMarkdown(xml)
    expect(markdown).toContain('| 제목 |')
    expect(markdown).toContain('| a | b |')
    expect(markdown).not.toContain('colspan')
  })

  it('중첩 매크로가 있으면 캐리어 펜스로 승격해 반환한다(미리보기 재귀용)', () => {
    const xml =
      '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>' +
      '<p>앞</p><ac:structured-macro ac:name="toc" /><p>뒤</p>' +
      '</ac:layout-cell></ac:layout-section></ac:layout>'
    const markdown = extractCarrierBodyMarkdown(xml)
    expect(markdown).toContain('앞')
    expect(markdown).toContain('confluence-storage')
  })

  it('본문 없는 매크로(jira 등)와 빈 레이아웃은 null을 반환한다', () => {
    expect(
      extractCarrierBodyMarkdown(
        '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ABC-1</ac:parameter></ac:structured-macro>',
      ),
    ).toBeNull()
    expect(extractCarrierBodyMarkdown('<ac:layout></ac:layout>')).toBeNull()
  })

  it('변형된 XML은 조용히 null로 떨어진다', () => {
    expect(extractCarrierBodyMarkdown('<ac:layout><p>닫힘 누락')).toBeNull()
  })
})

describe('describeInlineCarrier', () => {
  it('페이지 링크는 문서 제목을 반환한다', () => {
    expect(
      describeInlineCarrier('<ac:link><ri:page ri:content-title="운영 가이드" /></ac:link>'),
    ).toBe('운영 가이드')
  })

  it('emoji는 :shortname:을 반환한다', () => {
    expect(describeInlineCarrier('<ac:emoji ac:shortname="grinning" />')).toBe(':grinning:')
  })

  it('스타일 span 등은 텍스트 내용을 반환한다', () => {
    expect(describeInlineCarrier('<span style="color: red;">빨간 텍스트</span>')).toBe(
      '빨간 텍스트',
    )
  })

  it('빈 콘텐츠는 null을 반환한다', () => {
    expect(describeInlineCarrier('<ac:link />')).toBeNull()
  })
})

describe('splitCarrierStorage', () => {
  it('문서 끝 캐리어 구역을 본문에서 떼어내고 registry에 담는다', () => {
    const xml = '<ac:link><ri:page ri:content-title="대상" /></ac:link>'
    const markdown = [
      '본문 문단',
      '',
      '<!-- confluence:carriers -->',
      '',
      '```confluence-storage name=link id=abcd1234',
      xml,
      '```',
    ].join('\n')
    const { body, registry } = splitCarrierStorage(markdown)
    expect(body).not.toContain('confluence:carriers')
    expect(registry.get('abcd1234')).toBe(xml)
  })

  it('마커가 없으면 본문 전체를 유지한다', () => {
    const markdown = '# 제목\n\n본문'
    const { body, registry } = splitCarrierStorage(markdown)
    expect(body).toBe(markdown)
    expect(registry.size).toBe(0)
  })
})

describe('previewContentHash / inlineRefPattern', () => {
  it('해시는 8자리 16진수이고 내용에 따라 달라진다', () => {
    const a = previewContentHash('<p>a</p>')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(a).toBe(previewContentHash('<p>a</p>'))
    expect(a).not.toBe(previewContentHash('<p>b</p>'))
  })

  it('인라인 ref 토큰 패턴이 토큰을 찾는다', () => {
    const matches = [...'전 ⟦confluence-ref:abcd1234⟧ 후'.matchAll(inlineRefPattern())]
    expect(matches).toHaveLength(1)
    expect(matches[0]?.[1]).toBe('abcd1234')
  })
})
