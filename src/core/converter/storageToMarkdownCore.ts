import type { Element, Node } from '@xmldom/xmldom'
import { carrierFence, fenceFor, inlineRefToken } from './carrierTokens'
import {
  escapeStorageAttr,
  isElement,
  isNamespaced,
  isText,
  localName,
  serializeNode,
  textContent,
} from './xml'

/**
 * storage → Markdown 변환 핵심(node 의존 없음 — renderer import 가능,
 * renderer-no-node 규칙). 캐리어 해시는 주입받는다: main은 sha256(contentHash),
 * 미리보기는 충돌만 안 나면 되는 preview 해시를 쓴다.
 */

export type CarrierHashFn = (serializedXml: string) => string

export interface StorageToMarkdownResult {
  markdown: string
  /** 승격된 조각 수(인라인 ref 사용) — 미리보기 점선 표기 참고용 */
  promotedInlineCount: number
}

interface ConversionContext {
  carriers: string[]
  promotedInlineCount: number
  hash: CarrierHashFn
}

/** 블록 수준 화이트리스트: 이 요소들은 Markdown 구조로 손실 없이 변환된다. */
export const BLOCK_WHITELIST = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'blockquote',
  'hr',
  'pre',
])

const INLINE_WHITELIST = new Set([
  'strong',
  'b',
  'em',
  'i',
  'code',
  'a',
  'br',
  's',
  'strike',
  'del',
  'span',
  'sub',
  'sup',
])

const MAX_CONVERT_DEPTH = 200

/** 파싱된 storage 노드 배열을 Markdown으로 변환한다(해시 함수 주입형). */
export function nodesToMarkdown(nodes: Node[], hash: CarrierHashFn): StorageToMarkdownResult {
  const context: ConversionContext = { carriers: [], promotedInlineCount: 0, hash }
  const blocks = nodes.map((node) => convertBlock(node, context)).filter((line) => line !== null)

  let markdown = blocks.join('\n\n')
  if (context.carriers.length > 0) {
    // 인라인 승격 조각들의 본문은 문서 끝 캐리어 구역에 모은다(역변환 때 소비됨).
    markdown += `\n\n<!-- confluence:carriers -->\n\n${context.carriers.join('\n\n')}`
  }
  return { markdown, promotedInlineCount: context.promotedInlineCount }
}

function convertBlock(node: Node, context: ConversionContext, depth = 0): string | null {
  if (isText(node)) {
    const text = (node.nodeValue ?? '').trim()
    return text.length > 0 ? text : null
  }
  if (!isElement(node)) return null

  // 재귀 깊이 책(QA P2): 상한 초과 구간은 캐리어로 승격해 무손실 보존
  if (depth > MAX_CONVERT_DEPTH) return blockCarrier(node, context)
  if (isNamespaced(node) || !BLOCK_WHITELIST.has(localName(node))) {
    return blockCarrier(node, context)
  }

  switch (localName(node)) {
    case 'p':
      return convertInlineChildren(node, context).trim()
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(localName(node)[1])
      return `${'#'.repeat(level)} ${convertInlineChildren(node, context).trim()}`
    }
    case 'ul':
      return convertList(node, context, undefined, depth)
    case 'ol': {
      // <ol start="N">은 마크다운 'N. ' 번호로 보존된다(remark-gfm start 지원)
      const start = Number(node.getAttribute('start') ?? 1)
      return convertList(node, context, Number.isFinite(start) && start > 0 ? start : 1, depth)
    }
    case 'blockquote': {
      const inner = Array.from(node.childNodes)
        .map((child) => convertBlock(child, context, depth + 1))
        .filter((line): line is string => line !== null)
        .join('\n\n')
      return inner
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n')
    }
    case 'hr':
      return '---'
    case 'table':
      return convertTable(node, context, depth)
    case 'pre':
      return convertPre(node)
    case 'li':
      // li가 최상위에 온 경우(비정상 storage) — 목록으로 감싼다
      return `- ${convertInlineChildren(node, context).trim()}`
    default:
      return blockCarrier(node, context)
  }
}

function blockCarrier(node: Node, context: ConversionContext): string {
  const serialized = serializeNode(node)
  // 블록 캐리어는 제자리에 펜스를 남긴다(위치 보존). 캐리어 구역은 인라인 승격 전용.
  return carrierFence(localName(node), context.hash(serialized), serialized)
}

function convertInlineChildren(node: Element, context: ConversionContext, depth = 0): string {
  return Array.from(node.childNodes)
    .map((child) => convertInline(child, context, depth))
    .join('')
}

function convertInline(node: Node, context: ConversionContext, depth = 0): string {
  if (isText(node)) {
    return escapeMarkdownText(node.nodeValue ?? '')
  }
  if (!isElement(node)) return ''

  const name = localName(node)
  // 속성 있는 span(색상·배경 등)은 화이트리스트 경로로는 속성이 조용히 사라진다 —
  // 무손실 규약에 따라 캐리어로 승격해 원본 XML을 그대로 보존한다.
  const lossySpan =
    name === 'span' && (node.getAttribute('style') !== null || node.getAttribute('class') !== null)
  if (
    depth <= MAX_CONVERT_DEPTH &&
    !isNamespaced(node) &&
    !lossySpan &&
    INLINE_WHITELIST.has(name)
  ) {
    const inner = convertInlineChildren(node, context, depth + 1)
    switch (name) {
      case 'strong':
      case 'b':
        return `**${inner}**`
      case 'em':
      case 'i':
        return `*${inner}*`
      case 's':
      case 'strike':
      case 'del':
        return `~~${inner}~~`
      case 'code':
        return `\`${textContent(node)}\``
      case 'br':
        return '  \n'
      case 'span':
        // 속성 있는 span은 위에서 캐리어로 승격됐다 — 여기 남은 span은 내용만 보존해도 손실이 없다
        return inner
      case 'sub':
        return `<sub>${inner}</sub>`
      case 'sup':
        return `<sup>${inner}</sup>`
      case 'a': {
        const href = node.getAttribute('href') ?? node.getAttribute('rhref') ?? ''
        return `[${inner}](${escapeLinkHref(href)})`
      }
      default:
        return inner
    }
  }

  // 화이트리스트 밖 인라인 요소 → 블록 승격: 본문 자리에는 ref 토큰만 남기고
  // 원본은 문서 끝 캐리어 구역으로 옮긴다(역변환 때 해시로 제자리 재주입).
  const serialized = serializeNode(node)
  const hash = context.hash(serialized)
  context.carriers.push(carrierFence(name || 'fragment', hash, serialized))
  context.promotedInlineCount += 1
  return inlineRefToken(hash)
}

function convertList(
  node: Element,
  context: ConversionContext,
  startIndex?: number,
  depth = 0,
): string {
  const lines: string[] = []
  let index = startIndex ?? 1
  for (const child of Array.from(node.childNodes)) {
    if (!isElement(child) || localName(child) !== 'li') continue
    const marker = startIndex === undefined ? '-' : `${index}.`
    const nestedLists = Array.from(child.childNodes).filter(
      (grandchild): grandchild is Element =>
        isElement(grandchild) && (localName(grandchild) === 'ul' || localName(grandchild) === 'ol'),
    )
    // li의 직접 텍스트/인라인만 마커 뒤에 붙이고, 중첩 목록은 들여쓰기로 처리
    const cloneContent = Array.from(child.childNodes).filter(
      (grandchild) => !nestedLists.includes(grandchild as Element),
    )
    const inlineText = cloneContent
      .map((grandchild) => convertInlineOrBlockShallow(grandchild, context, depth))
      .join('')
      .trim()
    lines.push(`${marker} ${inlineText}`)
    for (const nested of nestedLists) {
      const nestedMarkdown = convertList(
        nested,
        context,
        localName(nested) === 'ol' ? 1 : undefined,
        depth + 1,
      )
      lines.push(
        nestedMarkdown
          .split('\n')
          .map((line) => (line.length > 0 ? `  ${line}` : line))
          .join('\n'),
      )
    }
    if (startIndex !== undefined) index += 1
  }
  return lines.join('\n')
}

function convertInlineOrBlockShallow(node: Node, context: ConversionContext, depth = 0): string {
  if (isText(node)) return escapeMarkdownText(node.nodeValue ?? '')
  if (!isElement(node)) return ''
  if (!isNamespaced(node) && BLOCK_WHITELIST.has(localName(node)) && localName(node) === 'p') {
    return convertInlineChildren(node, context, depth)
  }
  return convertInline(node, context)
}

function convertPre(node: Element): string {
  const codeNode = Array.from(node.getElementsByTagName('code'))[0]
  const content = codeNode ? (codeNode.textContent ?? '') : (node.textContent ?? '')
  const body = content.replace(/\n$/, '')
  // 내용에 ``` 라인이 있으면 3백틱 펜스가 조기 닫혀 구조가 붕괴한다 — 런보다 길게.
  const fence = fenceFor(body)
  return `${fence}\n${body}\n${fence}`
}

function convertTable(node: Element, context: ConversionContext, depth = 0): string {
  // 병합 셀(colspan/rowspan)·정렬 스타일은 Markdown 표로 무손실 표현 불가 —
  // 표 전체를 캐리어로 승격해 verbatim 보존한다(셀 병합이 조용히 풀리는 것 방지).
  if (hasUnsupportedCellAttributes(node)) return blockCarrier(node, context)

  // 직계 tr만 수집 — getElementsByTagName은 중첩 표의 tr까지 재귀 수집해
  // 외부 표에 유령 행을 병합시킨다(왕복 시 원본에 없는 행 추가).
  const rowContainers = Array.from(node.childNodes).filter(
    (child) => isElement(child) && ['tbody', 'thead', 'tfoot'].includes(localName(child)),
  ) as Element[]
  const rowsSource: Array<Element | Node> = rowContainers.length > 0 ? rowContainers : [node]
  const rows = rowsSource.flatMap((container) =>
    Array.from(container.childNodes).filter(
      (child) => isElement(child) && localName(child) === 'tr',
    ),
  ) as Element[]
  if (rows.length === 0) return blockCarrier(node, context)
  const cellElements = (row: Element): Element[] =>
    Array.from(row.childNodes).filter(
      (child) => isElement(child) && (localName(child) === 'th' || localName(child) === 'td'),
    ) as Element[]
  const alignOf = (cell: Element): 'left' | 'center' | 'right' | null => {
    const value = cell.getAttribute('align')
    return value && /^(left|center|right)$/i.test(value)
      ? (value.toLowerCase() as 'left' | 'center' | 'right')
      : null
  }
  // 열 정렬: GFM은 열 단위 정렬만 표현한다 — 같은 열의 셀 정렬이 서로 다르면
  // 캐리어로 승격해 verbatim 보존한다(부분 정렬이 조용히 사라지는 것 방지).
  const columnCount = cellElements(rows[0]).length
  const columnAligns: Array<'left' | 'center' | 'right' | null> = []
  for (let col = 0; col < columnCount; col++) {
    let decided: 'left' | 'center' | 'right' | null | undefined
    for (const row of rows) {
      const cellsInRow = cellElements(row)
      if (col >= cellsInRow.length) continue
      const cellAlign = alignOf(cellsInRow[col])
      if (decided === undefined) decided = cellAlign
      else if (decided !== cellAlign) return blockCarrier(node, context)
    }
    columnAligns.push(decided ?? null)
  }
  const cellText = (row: Element): string[] =>
    cellElements(row).map((cell) => {
      const text = convertInlineChildren(cell, context, depth)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ')
        .trim()
      return text.length > 0 ? text : ' '
    })

  const header = cellText(rows[0])
  const separator = header.map((_, index) => {
    const align = columnAligns[index]
    if (align === 'center') return ':---:'
    if (align === 'right') return '---:'
    if (align === 'left') return ':---'
    return '---'
  })
  const bodyRows = rows.slice(1).map(cellText)
  const renderRow = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [renderRow(header), renderRow(separator), ...bodyRows.map(renderRow)].join('\n')
}

function escapeMarkdownText(text: string): string {
  return (
    text
      .replace(/\\/g, '\\\\')
      .replace(/([*_[\]`~<>])/g, '\\$1')
      .replace(/^(#{1,6})(\s)/gm, '\\$1$2')
      .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
      .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\. $3')
      // 라인 전체가 -/=만으로 이루어지면 setext 밑줄·thematicBreak로 해석된다
      .replace(
        /^(\s*)([-=]+)(\s*)$/gm,
        (_match, indent: string, marker: string) => `${indent}\\${marker}`,
      )
  )
}

/** Markdown 표가 보존할 수 없는 셀 속성을 가졌는지 판정. */
function hasUnsupportedCellAttributes(node: Element): boolean {
  const cells = [
    ...Array.from(node.getElementsByTagName('td')),
    ...Array.from(node.getElementsByTagName('th')),
  ]
  for (const cell of cells) {
    for (const attr of ['colspan', 'rowspan', 'style', 'valign']) {
      if (cell.getAttribute(attr)) return true
    }
    // left/center/right align는 GFM 구분자 행(:---:)으로 무손실 표현 가능하다.
    const align = cell.getAttribute('align')
    if (align && !/^(left|center|right)$/i.test(align)) return true
  }
  return false
}

function escapeLinkHref(href: string): string {
  return escapeStorageAttr(href).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')
}
