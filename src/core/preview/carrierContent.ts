import type { Element, Node } from '@xmldom/xmldom'
import {
  CARRIER_LANG,
  fenceFor,
  INLINE_REF_PREFIX,
  INLINE_REF_SUFFIX,
} from '../converter/carrierTokens'
import { BLOCK_WHITELIST, nodesToMarkdown } from '../converter/storageToMarkdownCore'
import { isElement, isNamespaced, isText, localName, parseStorageFragment } from '../converter/xml'
import { findCarrierRanges } from '../editor/carrierRanges'

/**
 * 캐리어 XML에서 "읽을 수 있는 본문"을 뽑아내는 미리보기 전용 추출기.
 * 무손실 왕복 규약(마크다운 파일의 캐리어 펜스)은 그대로 두고, 미리보기
 * 렌더링에만 콘텐츠를 노출한다 — 레이아웃·매크로 단독 페이지가 안내문
 * 하나로만 보이는 문제(구형 Confluence 페이지에 흔함)를 완화한다.
 * 추출은 근사다: 열 배치·셀 병합·매크로 장식은 표현되지 않으며, 정확한
 * 모습은 Confluence 웹에서 확인한다(미리보기 파이프라인 원칙과 동일).
 */

/** 콘텐츠 원본 역할만 하는 래퍼 — 통과하고 자식을 노출한다. */
const TRANSPARENT_CONTAINERS = new Set([
  'layout',
  'layout-section',
  'layout-cell',
  'rich-text-body',
  'task-list',
  'task',
  'task-body',
])

/** nodesToMarkdown이 인라인 승격 조각 보관소로 쓰는 문서 끝 마커. */
const CARRIERS_MARKER = '<!-- confluence:carriers -->'

/** 미리보기 전용 캐리어 id — sha256과 달리 충돌만 안 나면 된다(FNV-1a 32bit). */
export function previewContentHash(serializedXml: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < serializedXml.length; index++) {
    hash ^= serializedXml.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** CDATA 섹션도 포함해 텍스트를 모은다(xmldom textContent는 CDATA를 건너뛴다). */
function deepText(node: Node): string {
  if (isText(node)) return node.nodeValue ?? ''
  if (node.nodeType === 4) return node.nodeValue ?? '' // CDATA_SECTION_NODE
  if (!isElement(node)) return ''
  return Array.from(node.childNodes).map(deepText).join('')
}

/**
 * 캐리어 XML 본문에서 읽을 수 있는 Markdown 조각을 만든다.
 * 읽을 내용이 없으면(toc·jira처럼 본문 없는 매크로) null.
 */
export function extractCarrierBodyMarkdown(xml: string): string | null {
  let nodes: Node[]
  try {
    nodes = parseStorageFragment(xml)
  } catch {
    return null // 변형된 펜스 내용 — 라벨만 보여준다
  }
  const segments: string[] = []
  for (const node of nodes) collectSegments(node, segments, false)
  if (segments.length === 0) return null
  // 노드별 변환(nodesToMarkdown)이 인라인 승격때마다 자기 캐리어 구역을 붙인다 —
  // 구역이 중간에 박히면 이후 내용이 저장소로 오인되므로 하나로 합친다.
  const bodies: string[] = []
  const sections: string[] = []
  for (const segment of segments) {
    const { body, section } = splitCarrierStorage(segment)
    if (body.trim().length > 0) bodies.push(body)
    if (section) sections.push(section)
  }
  let markdown = bodies.join('\n\n')
  if (sections.length > 0) {
    markdown += `\n\n${CARRIERS_MARKER}\n\n${sections.join('\n\n')}`
  }
  return markdown.trim().length > 0 ? markdown : null
}

/**
 * @param nested 컨테이너(레이아웃 셀·매크로 본문 등) 하강 중에 만난 노드인지.
 * true면 본문 없는 Confluence 요소도 캐리어 펜스로 승격해 자리를 보존하고
 * (미리보기에서 안쪽 플레이스홀더 박스로 재귀 렌더링), 캐리어 뿌리 자신이면
 * 읽을 게 없다는 뜻이므로 아무것도 내지 않는다(라벨만 박스).
 */
function collectSegments(node: Node, out: string[], nested: boolean): void {
  if (isText(node)) {
    const text = (node.nodeValue ?? '').trim()
    if (text.length > 0) out.push(text)
    return
  }
  if (!isElement(node)) return
  const name = localName(node)

  if (TRANSPARENT_CONTAINERS.has(name)) {
    for (const child of Array.from(node.childNodes)) collectSegments(child, out, true)
    return
  }

  if (name === 'structured-macro') {
    collectMacroSegments(node, out, nested)
    return
  }

  if (name === 'table') {
    const table = previewTableMarkdown(node)
    if (table !== null) {
      out.push(table)
      return
    }
    // 근사 변환마저 실패한 표 — 셀 내용이라도 줄 단위로 노출한다
    for (const child of Array.from(node.childNodes)) collectSegments(child, out, true)
    return
  }

  if (!isNamespaced(node) && BLOCK_WHITELIST.has(name)) {
    out.push(nodesToMarkdown([node], previewContentHash).markdown)
    return
  }

  if (isNamespaced(node)) {
    // 본문 없는 Confluence 요소(링크·emoji 등): 뿌리면 무시, 중첩이면 자리 보존
    if (nested) out.push(nodesToMarkdown([node], previewContentHash).markdown)
    return
  }

  if (name === 'script' || name === 'style') return // 실행·스타일 정보는 미리보기 콘텐츠가 아니다

  // 정체를 알 수 없는 HTML 래퍼(div 등) — 자식 중 읽을 수 있는 것만 노출
  for (const child of Array.from(node.childNodes)) collectSegments(child, out, true)
}

/** 매크로: title 파라미터는 굵게, rich-text-body는 재귀, plain-text-body는 코드펜스. */
function collectMacroSegments(macro: Element, out: string[], nested: boolean): void {
  const body: string[] = []
  for (const child of Array.from(macro.childNodes)) {
    if (!isElement(child)) continue
    const name = localName(child)
    if (name === 'parameter' && child.getAttribute('ac:name') === 'title') {
      const title = deepText(child).trim()
      if (title.length > 0) out.push(`**${title}**`)
    } else if (name === 'rich-text-body') {
      collectSegments(child, body, true)
    } else if (name === 'plain-text-body') {
      const code = deepText(child).replace(/\n$/, '')
      if (code.length > 0) {
        const fence = fenceFor(code)
        body.push(`${fence}\n${code}\n${fence}`)
      }
    }
  }
  if (body.length === 0 && nested) {
    // 본문 없는 매크로가 컨테이너 안에 중첩됐을 때 — 자리 보존(안쪽 박스로 렌더링)
    out.push(nodesToMarkdown([macro], previewContentHash).markdown)
    return
  }
  out.push(...body)
}

/**
 * 셀 병합·스타일 속성을 미리보기에서만 벗겨낸 표 사본으로 Markdown 표를 만든다.
 * (원본 캐리어는 그대로 — 왕복 무손실 규약에 영향 없음)
 */
function previewTableMarkdown(table: Element): string | null {
  const document = table.ownerDocument
  if (!document) return null
  const clone = document.importNode(table, true)
  if (!isElement(clone)) return null
  for (const cellName of ['td', 'th']) {
    for (const cell of Array.from(clone.getElementsByTagName(cellName))) {
      for (const attr of ['colspan', 'rowspan', 'style', 'valign', 'align']) {
        cell.removeAttribute(attr)
      }
    }
  }
  const markdown = nodesToMarkdown([clone], previewContentHash).markdown
  if (markdown.startsWith('```')) {
    // 여전히 캐리어로 승격됐다면(빈 표 등) 근사 실패 — 호출부가 셀 하강으로 대체
    if (markdown.includes(`${CARRIER_LANG} name=table`)) return null
  }
  return markdown
}

/** 인라인 ref 토큰(⟦confluence-ref:xxxxxxxx⟧)을 찾는 정규식(전역 — 재사용 시 lastIndex 주의). */
export function inlineRefPattern(): RegExp {
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `${escapeRegExp(INLINE_REF_PREFIX)}([0-9a-f]{8})${escapeRegExp(INLINE_REF_SUFFIX)}`,
    'g',
  )
}

/**
 * 인라인 캐리어 XML을 한 줄 텍스트로 요약한다(문단 흐름 안에서 보여줄 용도).
 * 페이지 링크는 문서 제목, emoji는 :shortname:, 그 외는 텍스트 내용.
 */
export function describeInlineCarrier(xml: string): string | null {
  let root: Node | undefined
  try {
    ;[root] = parseStorageFragment(xml)
  } catch {
    return null
  }
  if (!root || !isElement(root)) return null
  const name = localName(root)

  if (name === 'link') {
    const page = firstDescendant(root, 'page')
    const title = page?.getAttribute('ri:content-title')
    if (title) return title
    const attachment = firstDescendant(root, 'attachment')
    const filename = attachment?.getAttribute('ri:filename')
    if (filename) return filename
    const url = firstDescendant(root, 'url')
    const value = url?.getAttribute('ri:value')
    if (value) return value
    return deepText(root).trim() || null
  }

  if (name === 'emoji') {
    const shortname = root.getAttribute('ac:shortname')
    return shortname ? `:${shortname}:` : null
  }

  const text = deepText(root).trim()
  return text.length > 0 ? text : null
}

function firstDescendant(node: Element, name: string): Element | null {
  for (const child of Array.from(node.childNodes)) {
    if (!isElement(child)) continue
    if (localName(child) === name) return child
    const found = firstDescendant(child, name)
    if (found) return found
  }
  return null
}

export interface CarrierStorageSplit {
  /** 캐리어 저장 구역을 제외한 미리보기 본문 */
  body: string
  /** 캐리어 id → 원본 XML(인라인 ref 해소용) */
  registry: Map<string, string>
  /** 캐리어 저장 구역 원문(마커 없으면 null — 구역 병합용) */
  section: string | null
}

/**
 * 문서 끝 캐리어 구역(인라인 승격 조각의 원본 보관소)을 본문에서 떼어낸다.
 * 구역은 역변환 전용 저장소이지 콘텐츠가 아니므로 미리보기에서는 숨기고,
 * 인라인 ref 토큰 해소에만 registry로 쓴다(중복 박스·토큰 노출 방지).
 */
export function splitCarrierStorage(markdown: string): CarrierStorageSplit {
  const registry = new Map<string, string>()
  for (const range of findCarrierRanges(markdown)) {
    if (range.id) {
      registry.set(range.id, markdown.slice(range.contentFrom, range.contentTo))
    }
  }
  const markerIndex = markdown.indexOf(CARRIERS_MARKER)
  if (markerIndex === -1) {
    return { body: markdown.replace(/\s+$/, ''), registry, section: null }
  }
  const body = markdown.slice(0, markerIndex)
  const section = markdown.slice(markerIndex + CARRIERS_MARKER.length).trim()
  return { body: body.replace(/\s+$/, ''), registry, section: section.length > 0 ? section : null }
}
