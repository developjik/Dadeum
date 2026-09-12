import {
  escapeStorageAttr,
  isElement,
  isNamespaced,
  isText,
  localName,
  parseStorageFragment,
  serializeNode,
  textContent
} from './xml'
import { carrierFence, contentHash, inlineRefToken } from './carriers'
import type { Element, Node } from '@xmldom/xmldom'

export interface StorageToMarkdownResult {
  markdown: string
  /** 승격된 조각 수(인라인 ref 사용) — 미리보기 점선 표기 참고용 */
  promotedInlineCount: number
}

interface ConversionContext {
  carriers: string[]
  promotedInlineCount: number
}

/** 블록 수준 화이트리스트: 이 요소들은 Markdown 구조로 손실 없이 변환된다. */
const BLOCK_WHITELIST = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'hr', 'pre'])

const INLINE_WHITELIST = new Set(['strong', 'b', 'em', 'i', 'code', 'a', 'br', 's', 'strike', 'del', 'span', 'sub', 'sup'])

const MAX_CONVERT_DEPTH = 200

export function storageToMarkdown(storageXml: string): StorageToMarkdownResult {
  const nodes = parseStorageFragment(storageXml)
  const context: ConversionContext = { carriers: [], promotedInlineCount: 0 }
  const blocks = nodes.map((node) => convertBlock(node, context)).filter((line) => line !== null)

  let markdown = blocks.join('\n\n')
  if (context.carriers.length > 0) {
    // 인라인 승격 조각들의 본문은 문서 끝 캐리어 구역에 모은다(역변환 때 소비됨).
    markdown += '\n\n<!-- confluence:carriers -->\n\n' + context.carriers.join('\n\n')
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
    case 'ol':
      return convertList(node, context, localName(node) === 'ol' ? 1 : undefined, depth)
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
  void context
  const serialized = serializeNode(node)
  const hash = contentHash(serialized)
  // 블록 캐리어는 제자리에 펜스를 남긴다(위치 보존). 캐리어 구역은 인라인 승격 전용.
  return carrierFence(localName(node), hash, serialized)
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
  if (!isNamespaced(node) && INLINE_WHITELIST.has(name)) {
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
      case 'span': {
        const style = node.getAttribute('style')
        return style ? inner : inner // span은 래핑 없이 내용만 보존(스타일은 근사)
      }
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
  const hash = contentHash(serialized)
  context.carriers.push(carrierFence(name || 'fragment', hash, serialized))
  context.promotedInlineCount += 1
  return inlineRefToken(hash)
}

function convertList(node: Element, context: ConversionContext, startIndex?: number, depth = 0): string {
  const lines: string[] = []
  let index = startIndex ?? 1
  for (const child of Array.from(node.childNodes)) {
    if (!isElement(child) || localName(child) !== 'li') continue
    const marker = startIndex === undefined ? '-' : `${index}.`
    const nestedLists = Array.from(child.childNodes).filter(
      (grandchild): grandchild is Element =>
        isElement(grandchild) && (localName(grandchild) === 'ul' || localName(grandchild) === 'ol')
    )
    // li의 직접 텍스트/인라인만 마커 뒤에 붙이고, 중첩 목록은 들여쓰기로 처리
    const cloneContent = Array.from(child.childNodes).filter((grandchild) => !nestedLists.includes(grandchild as Element))
    const inlineText = cloneContent
      .map((grandchild) => convertInlineOrBlockShallow(grandchild, context, depth))
      .join('')
      .trim()
    lines.push(`${marker} ${inlineText}`)
    for (const nested of nestedLists) {
      const nestedMarkdown = convertList(nested, context, localName(nested) === 'ol' ? 1 : undefined, depth + 1)
      lines.push(
        nestedMarkdown
          .split('\n')
          .map((line) => (line.length > 0 ? `  ${line}` : line))
          .join('\n')
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
  return '```\n' + content.replace(/\n$/, '') + '\n```'
}

function convertTable(node: Element, context: ConversionContext, depth = 0): string {
  const rows = Array.from(node.getElementsByTagName('tr'))
  if (rows.length === 0) return blockCarrier(node, context)

  const cellText = (row: Element): string[] => {
    const cells = Array.from(row.childNodes).filter(
      (child) => isElement(child) && (localName(child) === 'th' || localName(child) === 'td')
    ) as Element[]
    return cells.map((cell) => {
      const text = convertInlineChildren(cell, context, depth).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
      return text.length > 0 ? text : ' '
    })
  }

  const header = cellText(rows[0])
  const separator = header.map(() => '---')
  const bodyRows = rows.slice(1).map(cellText)
  const renderRow = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [renderRow(header), renderRow(separator), ...bodyRows.map(renderRow)].join('\n')
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_[\]`~<>])/g, '\\$1')
    .replace(/^(#{1,6})(\s)/gm, '\\$1$2')
    .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\. $3')
}

function escapeLinkHref(href: string): string {
  return escapeStorageAttr(href).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')
}
