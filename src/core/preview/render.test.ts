import { describe, expect, it } from 'vitest'
import { storageToMarkdown } from '../converter/storageToMarkdown'
import { ko } from '../i18n/ko'
import { renderPreviewHtml } from './render'

const layoutXml = (cells: string): string =>
  `<ac:layout><ac:layout-section ac:type="two_equal">${cells}</ac:layout-section></ac:layout>`

describe('renderPreviewHtml(AC-8)', () => {
  it('헤더와 문단을 렌더링한다', async () => {
    const html = await renderPreviewHtml('# 배포 가이드\n\n본문입니다.')
    expect(html).toContain('<h1>배포 가이드</h1>')
    expect(html).toContain('<p>본문입니다.</p>')
  })

  it('캐리어 펜스를 플레이스홀더 박스로 바꾼다', async () => {
    const md =
      '앞\n\n```confluence-storage name=structured-macro id=abc12345\n<ac:structured-macro ac:name="jira" />\n```\n\n뒤'
    const html = await renderPreviewHtml(md)
    expect(html).toContain('confluence-placeholder')
    expect(html).toContain('Confluence 요소')
    expect(html).not.toContain('<ac:structured-macro')
  })

  it('캐리어 종류를 원문 대신 한국어로 요약한다', async () => {
    const md =
      '```confluence-storage name=layout id=abc12345\n<ac:layout><ac:layout-section ac:type="two_left_sidebar"></ac:layout-section></ac:layout>\n```'
    const html = await renderPreviewHtml(md)
    expect(html).toContain('페이지 레이아웃')
    expect(html).not.toContain('<ac:layout')
  })

  it('레이아웃 전용 페이지도 셀 본문을 박스 안에 렌더링한다', async () => {
    const xml = layoutXml(
      '<ac:layout-cell><h2>개요</h2><p>왼쪽 칸 본문입니다</p></ac:layout-cell>' +
        '<ac:layout-cell><p>오른쪽 칸입니다</p></ac:layout-cell>',
    )
    const md = `\`\`\`confluence-storage name=layout id=abc12345\n${xml}\n\`\`\``
    const html = await renderPreviewHtml(md)
    expect(html).toContain('페이지 레이아웃')
    expect(html).toContain('<h2>개요</h2>')
    expect(html).toContain('왼쪽 칸 본문입니다')
    expect(html).toContain('오른쪽 칸입니다')
    expect(html).not.toContain('<ac:layout')
    // 읽을 내용이 있으므로 미리보기 제한 안내를 붙이지 않는다
    expect(html).not.toContain(ko.preview.carrierOnly)
  })

  it('실제 동기화 경로(storageToMarkdown 산출물)의 레이아웃 페이지도 본문이 보인다', async () => {
    // 구형 Confluence에서 흔한 "페이지 전체가 레이아웃" 형태 — 사용자 불만의 본 사례
    const storage = [
      '<ac:layout>',
      '<ac:layout-section ac:type="two_equal">',
      '<ac:layout-cell><h2>개요</h2><p>서비스 소개 문단입니다.</p></ac:layout-cell>',
      '<ac:layout-cell><p>담당자: 홍길동</p><p>문의: <ac:link><ri:page ri:content-title="운영 가이드" /></ac:link></p></ac:layout-cell>',
      '</ac:layout-section>',
      '<ac:layout-section ac:type="single">',
      '<ac:layout-cell><p>하단 공통 메모입니다.</p></ac:layout-cell>',
      '</ac:layout-section>',
      '</ac:layout>',
    ].join('')
    const { markdown } = storageToMarkdown(storage)
    const html = await renderPreviewHtml(markdown)
    expect(html).toContain('서비스 소개 문단입니다.')
    expect(html).toContain('담당자: 홍길동')
    expect(html).toContain('하단 공통 메모입니다.')
    // 셀 안 인라인 링크 승격 ref는 문서 제목 배지로 보인다
    expect(html).toContain('운영 가이드')
    expect(html).not.toContain('confluence-ref:')
    expect(html).not.toContain(ko.preview.carrierOnly)
  })

  it('매크로 패널(title + rich-text-body)도 본문을 렌더링한다', async () => {
    const xml =
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">공지 제목</ac:parameter>' +
      '<ac:rich-text-body><p>패널 본문</p></ac:rich-text-body></ac:structured-macro>'
    const md = `\`\`\`confluence-storage name=structured-macro id=abc12345\n${xml}\n\`\`\``
    const html = await renderPreviewHtml(md)
    expect(html).toContain('<strong>공지 제목</strong>')
    expect(html).toContain('패널 본문')
  })

  it('코드 매크로(plain-text-body)는 코드 블록으로 렌더링한다', async () => {
    const xml =
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[const x = 1]]></ac:plain-text-body></ac:structured-macro>'
    const md = `\`\`\`confluence-storage name=structured-macro id=abc12345\n${xml}\n\`\`\``
    const html = await renderPreviewHtml(md)
    expect(html).toContain('<pre><code>const x = 1\n</code></pre>')
  })

  it('병합 셀 표 캐리어도 근사 표로 렌더링한다', async () => {
    const xml =
      '<table><tbody><tr><th colspan="2">제목</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>'
    const md = `\`\`\`confluence-storage name=table id=abc12345\n${xml}\n\`\`\``
    const html = await renderPreviewHtml(md)
    expect(html).toContain('병합 셀 표')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>a</td>')
    expect(html).not.toContain('colspan')
  })

  it('문서가 캐리어뿐이면 미리보기 제한 안내를 덧붙인다', async () => {
    const md = '```confluence-storage name=layout id=abc12345\n<ac:layout></ac:layout>\n```'
    const html = await renderPreviewHtml(md)
    expect(html).toContain(ko.preview.carrierOnly)
  })

  it('캐리어 외 본문이 있으면 제한 안내를 붙이지 않는다', async () => {
    const md =
      '본문 문단\n\n```confluence-storage name=layout id=abc12345\n<ac:layout></ac:layout>\n```'
    const html = await renderPreviewHtml(md)
    expect(html).not.toContain(ko.preview.carrierOnly)
  })

  it('인라인 ref 토큰은 원본 요약으로 바꾸고 문서 끝 캐리어 구역은 숨긴다', async () => {
    const link = '<ac:link><ri:page ri:content-title="운영 가이드" /></ac:link>'
    const md = [
      '참고: ⟦confluence-ref:abcd1234⟧ 문서 확인',
      '',
      '<!-- confluence:carriers -->',
      '',
      '```confluence-storage name=link id=abcd1234',
      link,
      '```',
    ].join('\n')
    const html = await renderPreviewHtml(md)
    expect(html).toContain('confluence-ref')
    expect(html).toContain('운영 가이드')
    expect(html).not.toContain('confluence-ref:abcd1234')
    // 저장소 구역의 펜스가 본문 말미에 박스로 이중 노출되지 않는다
    expect(html).not.toContain('confluence-placeholder__header')
  })

  it('레이아웃 셀 내부의 위험 마크업도 새니타이즈된다', async () => {
    const xml = layoutXml('<ac:layout-cell><p>본문</p><script>alert(1)</script></ac:layout-cell>')
    const md = `\`\`\`confluence-storage name=layout id=abc12345\n${xml}\n\`\`\``
    const html = await renderPreviewHtml(md)
    expect(html).toContain('본문')
    expect(html).not.toContain('<script')
  })

  it('스크립트 등 위험 마크업을 제거한다(sanitize)', async () => {
    const md = '안전한 문단\n\n<script>alert(1)</script>\n\n[링크](javascript:alert(2))'
    const html = await renderPreviewHtml(md)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('javascript:')
  })

  it('GFM 표를 렌더링한다', async () => {
    const md = '| 이름 | 값 |\n| --- | --- |\n| a | 1 |'
    const html = await renderPreviewHtml(md)
    expect(html).toContain('<table>')
    expect(html).toContain('<td>a</td>')
  })
})
