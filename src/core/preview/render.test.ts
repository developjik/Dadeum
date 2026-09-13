import { describe, expect, it } from 'vitest'
import { ko } from '../i18n/ko'
import { renderPreviewHtml } from './render'

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
