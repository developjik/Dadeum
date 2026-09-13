import { describe, expect, it } from 'vitest'
import { contentHash, verifyCarrierIntegrity } from './carriers'
import { storageSemanticallyEqual } from './compare'
import { markdownToStorage } from './markdownToStorage'
import { storageToMarkdown } from './storageToMarkdown'

/** AC-5 게이트: storage → md → storage가 의미적으로 동일해야 한다. */
function expectRoundTripLossless(storage: string): string {
  const { markdown } = storageToMarkdown(storage)
  const back = markdownToStorage(markdown)
  expect(storageSemanticallyEqual(storage, back)).toBe(true)
  return markdown
}

describe('storageToMarkdown', () => {
  it('문단과 엔티티를 마크다운 텍스트로 변환한다', () => {
    const { markdown } = storageToMarkdown('<p>Hello &amp; world</p>')
    expect(markdown).toContain('Hello & world')
  })

  it('제목을 # 마커로 변환한다', () => {
    const { markdown } = storageToMarkdown('<h2>설치 가이드</h2>')
    expect(markdown).toBe('## 설치 가이드')
  })

  it('강조·이탤릭·링크를 변환한다', () => {
    const { markdown } = storageToMarkdown(
      '<p><strong>굵게</strong>와 <em>기울임</em>, <a href="https://example.com">링크</a></p>',
    )
    expect(markdown).toContain('**굵게**')
    expect(markdown).toContain('*기울임*')
    expect(markdown).toContain('[링크](https://example.com)')
  })

  it('매크로 블록을 펜스드 캐리어로 보존한다', () => {
    const macro =
      '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ABC-1</ac:parameter></ac:structured-macro>'
    const { markdown } = storageToMarkdown(`<p>앞 문단</p>${macro}<p>뒤 문단</p>`)

    expect(markdown).toContain('```confluence-storage name=structured-macro id=')
    expect(markdown).toContain('<ac:parameter ac:name="key">ABC-1</ac:parameter>')
    // 캐리어 본문 해시가 info string의 id와 일치한다(무결성).
    const fenceContent = markdown.split('```confluence-storage')[1]
    const content = fenceContent.slice(
      fenceContent.indexOf('\n') + 1,
      fenceContent.lastIndexOf('```'),
    )
    const id = /id=([0-9a-f]+)/.exec(markdown)![1]
    expect(
      verifyCarrierIntegrity({ name: 'structured-macro', id, content: content.replace(/\n$/, '') }),
    ).toBe(true)
  })

  it('인라인 승격 조각은 ref 토큰과 문서 끝 캐리어 구역을 만든다', () => {
    const storage = '<p>See <ac:link><ri:page ri:content-title="대상" /></ac:link> now</p>'
    const { markdown, promotedInlineCount } = storageToMarkdown(storage)

    expect(promotedInlineCount).toBe(1)
    expect(markdown).toMatch(/⟦confluence-ref:[0-9a-f]+⟧/)
    expect(markdown).toContain('<!-- confluence:carriers -->')
    expect(markdown).toContain('<ac:link>')
  })
  it('CDATA 내부의 named entity를 치환하지 않는다(코드 매크로 보존)', () => {
    const cdata = '<![CDATA[a&nbsp;b &copy; 2026]]>'
    const macro = `<ac:structured-macro ac:name="code"><ac:plain-text-body>${cdata}</ac:plain-text-body></ac:structured-macro>`
    const { markdown } = storageToMarkdown(`<p>앞</p>${macro}<p>뒤</p>`)
    expect(markdown).toContain('a&nbsp;b &copy; 2026')
    expect(markdown).not.toContain('&#160;')
    expect(markdownToStorage(markdown)).toContain(cdata)
  })
  it('확장 엔티티(zwj·there4·sube 등)도 문자로 복원되어 왕복 무손실이다', () => {
    // 실제 스페이스 풀에서 entity-not-found로 관측된 엔티티(2026-09 E2E).
    // zwj는 이모지·한글 조합 결합자 — 누락 시 조합이 깨진다.
    const storage = '<p>a&nbsp;∴b ‍c ≤d ≥e ∼f</p>'
    const markdown = expectRoundTripLossless(storage)
    expect(markdown).toContain('∴')
    expect(markdown).toContain('\u200d')
    expect(markdown).toContain('≤')
  })
})

describe('markdownToStorage', () => {
  it('제목과 문단을 storage로 되돌린다', () => {
    const storage = markdownToStorage('## 제목\n\n본문 텍스트')
    expect(storage).toContain('<h2>제목</h2>')
    expect(storage).toContain('<p>본문 텍스트</p>')
  })

  it('GFM 표를 storage 테이블로 되돌린다', () => {
    const storage = markdownToStorage('| 이름 | 값 |\n| --- | --- |\n | a | 1 |')
    expect(storage).toContain('<table>')
    expect(storage).toContain('<th>이름</th>')
    expect(storage).toContain('<td>1</td>')
  })

  it('캐리어 펜스를 verbatim으로 재주입한다', () => {
    const macro =
      '<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro>'
    const storage = markdownToStorage(
      `\`\`\`confluence-storage name=structured-macro id=${contentHash(macro)}\n${macro}\n\`\`\``,
    )
    expect(storage).toContain('<ac:parameter ac:name="colour">Green</ac:parameter>')
  })

  it('변조된 캐리어 펜스는 무결성 검증 실패로 재주입을 거부한다', () => {
    const original = '<ac:structured-macro ac:name="status"></ac:structured-macro>'
    const tampered = '<ac:structured-macro ac:name="evil"></ac:structured-macro>'
    expect(() =>
      markdownToStorage(
        `\`\`\`confluence-storage name=structured-macro id=${contentHash(original)}\n${tampered}\n\`\`\``,
      ),
    ).toThrow(/무결성/)
  })
  it('loose 목록 항목(문단 2개)이 불법 XML을 만들지 않는다', () => {
    expect(markdownToStorage('- 첫 문단\n\n  둘째 문단')).toBe(
      '<ul><li><p>첫 문단</p><p>둘째 문단</p></li></ul>',
    )
  })

  it('tight 목록 항목은 여전히 문단을 벗긴다', () => {
    expect(markdownToStorage('- 항목')).toBe('<ul><li>항목</li></ul>')
  })
})

describe('AC-5 왕복 무손실(픽스처 게이트)', () => {
  it.each([
    ['문단', '<p>일반 문단입니다</p>'],
    ['엔티티', '<p>a &nbsp; b &amp; c</p>'],
    ['제목·목록', '<h1>제목</h1><ul><li>항목1</li><li>항목2<ul><li>중첩</li></ul></li></ul>'],
    ['순서 목록', '<ol><li>첫째</li><li>둘째</li></ol>'],
    [
      '표',
      '<table><tbody><tr><th>이름</th><th>값</th></tr><tr><td>a</td><td>1</td></tr></tbody></table>',
    ],
    ['강조 조합', '<p><strong>굵음</strong><em>기울임</em><code>code</code></p>'],
    [
      '매크로 블록',
      '<p>앞</p><ac:structured-macro ac:name="info"><ac:parameter ac:name="title">공지</ac:parameter><ac:rich-text-body><p>내용</p></ac:rich-text-body></ac:structured-macro><p>뒤</p>',
    ],
    ['인라인 승격', '<p>참조 <ac:link><ri:page ri:content-title="문서" /></ac:link> 포함</p>'],
    ['인용·수평선', '<blockquote><p>인용</p></blockquote><hr/><p>끝</p>'],
  ])('%s 픽스처가 무손실로 왕복한다', (_name, storage) => {
    expectRoundTripLossless(storage)
  })

  it('복합 픽스처(표+매크로+인라인 승격)도 무손실로 왕복한다', () => {
    const storage = [
      '<h1>배포 가이드</h1>',
      '<p>요약: <strong>v2</strong> 배포 절차 — <ac:link><ri:page ri:content-title="롤백" /></ac:link></p>',
      '<table><tbody><tr><th>단계</th><th>담당</th></tr><tr><td>빌드</td><td>CI</td></tr></tbody></table>',
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">상세</ac:parameter><ac:rich-text-body><ul><li>항목</li></ul></ac:rich-text-body></ac:structured-macro>',
    ].join('')
    expectRoundTripLossless(storage)
  })
})

describe('왕복 하드닝(M8 확대 픽스처)', () => {
  it('rich-text-body에 표를 포함한 매크로가 무손실로 왕복한다', () => {
    const storage = [
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">상세</ac:parameter>',
      '<ac:rich-text-body><table><tbody><tr><th>항목</th></tr><tr><td>값 &amp; 단위</td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>',
    ].join('')
    expectRoundTripLossless(storage)
  })

  it('특수문자가 포함된 코드 블록이 무손실로 왕복한다', () => {
    const storage =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[const x = {a: 1 < 2, b: \'z\'}]]></ac:plain-text-body></ac:structured-macro>'
    expectRoundTripLossless(storage)
  })

  it('중첩 목록+강조 조합이 무손실로 왕복한다', () => {
    const storage =
      '<ul><li><strong>굵은</strong> 항목<ul><li><em>중첩 기울임</em></li></ul></li></ul>'
    expectRoundTripLossless(storage)
  })
})

describe('멱등성(md → storage → md)', () => {
  it('마크다운을 한 번 역변환 후 다시 정방향 변환해도 동일하다', () => {
    const md1 = storageToMarkdown(
      '<h2>헤더</h2><p>문단 — <em>강조</em></p><ac:structured-macro ac:name="toc" />',
    ).markdown
    const storage = markdownToStorage(md1)
    const md2 = storageToMarkdown(storage).markdown
    expect(md2).toBe(md1)
  })
})

describe('왕복 하드닝 2(P1 — 다중 에이전트 리뷰)', () => {
  it('코드 내용에 ``` 라인이 있으면 펜스가 길어져 조기 닫히지 않는다', () => {
    const storage = '<pre><code>before\n```\nafter</code></pre>'
    const { markdown } = storageToMarkdown(storage)
    expect(markdown).toBe('````\nbefore\n```\nafter\n````')
    expectRoundTripLossless(storage)
  })

  it('캐리어 내용의 백틱 런보다 펜스가 길다', () => {
    const macro =
      '<ac:structured-macro ac:name="x"><ac:parameter ac:name="k">a```b</ac:parameter></ac:structured-macro>'
    const { markdown } = storageToMarkdown(macro)
    expect(markdown).toContain('````confluence-storage name=structured-macro')
    expect(markdownToStorage(markdown)).toContain('a```b')
  })

  it('중첩 표의 행이 외부 표에 유령 행으로 병합되지 않는다', () => {
    const outer =
      '<table><tbody><tr><th>이름</th><th>값</th></tr><tr><td>외부</td><td><table><tbody><tr><td>중첩</td><td>1</td></tr></tbody></table></td></tr></tbody></table>'
    expectRoundTripLossless(outer)
  })

  it('병합 셀(colspan) 표는 캐리어로 verbatim 보존된다', () => {
    const storage =
      '<table><tbody><tr><th colspan="2">제목</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>'
    const { markdown } = storageToMarkdown(storage)
    expect(markdown).toContain('```confluence-storage name=table')
    expect(markdown).toContain('colspan="2"')
    expect(markdownToStorage(markdown)).toContain('colspan="2"')
  })

  it('문단의 --- / === 라인이 hr·setext 제목으로 변질되지 않는다', () => {
    expect(storageToMarkdown('<p>---</p>').markdown).toBe('\\---')
    expectRoundTripLossless('<p>---</p>')
    expectRoundTripLossless('<p>윗줄<br/>===</p>')
  })
})

describe('순서 목록 시작 번호(P3)', () => {
  it('ol start가 왕복에서 보존된다', () => {
    const storage = '<ol start="4"><li>넷째</li><li>다섯째</li></ol>'
    expectRoundTripLossless(storage)
    expect(markdownToStorage('4. 넷째\n5. 다섯째')).toContain('<ol start="4">')
  })
})
