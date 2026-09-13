import type { List, PhrasingContent, Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { CARRIER_LANG, contentHash, INLINE_REF_PREFIX, INLINE_REF_SUFFIX } from './carriers'
import { escapeStorageAttr, escapeStorageText } from './xml'

interface CarrierRegistry {
  carriers: Map<string, { name: string; content: string }>
  emitted: Set<string>
}

/** 역변환 결과: storage XML 본문(조각 — 최상위 복수 요소 허용). */
export function markdownToStorage(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root

  // 캐리어 레지스트리: 펜스 전체를 미리 수집(인라인 ref 재주입용).
  // 수집 시점에 해시 무결성을 검증한다(carriers.ts 규약 — "push 시 해시로 무결성을 재확인").
  // 사용자가 펜스 내용을 수정했다면 재주입을 거부해 변질된 XML이 원격에 올라가는 것을 막는다.
  const ctx: CarrierRegistry = { carriers: new Map(), emitted: new Set() }
  for (const node of tree.children) {
    if (node.type === 'code' && node.lang === CARRIER_LANG) {
      const id = carrierId(node.meta)
      if (id) {
        if (contentHash(node.value) !== id) {
          throw new Error(
            `캐리어 무결성 검증 실패(name=${carrierName(node.meta)}, id=${id}). ` +
              '펜스 블록(confluence-storage)의 내용이 원본과 다릅니다. 원본 그대로 복원하거나, ' +
              '내용을 바꾸려면 펜스를 지우고 일반 마크다운으로 다시 작성하세요.',
          )
        }
        ctx.carriers.set(id, { name: carrierName(node.meta), content: node.value })
      }
    }
  }

  // 문서 흐름 변환: carriers 마커 구역은 소비(레지스트리로 흡수)하고 나머지는 storage로.
  const parts: string[] = []
  let insideCarrierSection = false
  for (const child of tree.children) {
    if (child.type === 'html' && child.value.includes('<!-- confluence:carriers')) {
      insideCarrierSection = true
      continue
    }
    if (insideCarrierSection && child.type === 'code') {
      continue // 캐리어 구역의 펜스는 레지스트리로만 존재 — 흐름에서 소비
    }
    insideCarrierSection = false
    const storage = convertRootContent(child, ctx)
    if (storage.length > 0) parts.push(storage)
  }

  // 고아 캐리어(제자리·ref 어디로도 재주입되지 않은 승격 조각)는 내용 손실
  // 방지를 위해 블록으로 복원한다(안전 우선 — 삭제보다 보존).
  for (const [hash, carrier] of ctx.carriers) {
    if (!ctx.emitted.has(hash)) parts.push(carrier.content)
  }

  return parts.join('\n')
}

function carrierMeta(meta: string | null | undefined): Map<string, string> {
  return new Map(
    (meta ?? '')
      .split(/\s+/)
      .filter((t) => t.includes('='))
      .map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]),
  )
}

function carrierId(meta: string | null | undefined): string | undefined {
  return carrierMeta(meta).get('id')
}

function carrierName(meta: string | null | undefined): string {
  return carrierMeta(meta).get('name') ?? 'fragment'
}

function convertRootContent(node: RootContent, ctx: CarrierRegistry): string {
  switch (node.type) {
    case 'heading':
      return `<h${node.depth}>${convertPhrasing(node.children, ctx)}</h${node.depth}>`
    case 'paragraph':
      return `<p>${convertPhrasing(node.children, ctx)}</p>`
    case 'list':
      return convertList(node, ctx)
    case 'blockquote': {
      const inner = node.children
        .map((child) => convertRootContent(child, ctx))
        .filter((part) => part.length > 0)
        .join('\n')
      return `<blockquote>${inner}</blockquote>`
    }
    case 'thematicBreak':
      return '<hr/>'
    case 'table': {
      const [header, ...body] = node.children
      const headerCells =
        header?.children
          .map((cell) => `<th>${convertPhrasing(cell.children, ctx)}</th>`)
          .join('') ?? ''
      const bodyRows = body
        .map(
          (row) =>
            `<tr>${row.children.map((cell) => `<td>${convertPhrasing(cell.children, ctx)}</td>`).join('')}</tr>`,
        )
        .join('')
      return `<table><tbody><tr>${headerCells}</tr>${bodyRows}</tbody></table>`
    }
    case 'code': {
      if (node.lang === CARRIER_LANG) {
        // 제자리 블록 캐리어 — 펜스 내용을 검증 없이 그대로 재주입(사용자 편집 의미 존중).
        const id = carrierId(node.meta)
        if (id) ctx.emitted.add(id)
        return node.value
      }
      return `<pre><code>${escapeStorageText(node.value)}</code></pre>`
    }
    case 'html':
      return ''
    default:
      return ''
  }
}

function convertList(node: List, ctx: CarrierRegistry): string {
  const tag = node.ordered ? 'ol' : 'ul'
  const items = node.children
    .map((item) => {
      const direct: RootContent[] = []
      const nested: string[] = []
      for (const child of item.children) {
        if (child.type === 'list') nested.push(convertList(child, ctx))
        else direct.push(child)
      }
      // loose 목록(문단 2개 이상·중첩 블록)은 <p>를 유지한다 —
      // 무조건 unwrap하면 <li>a</p><p>b</li> 같은 불법 XML이 만들어진다.
      const [single] = direct
      const directXml =
        direct.length === 1 && single?.type === 'paragraph'
          ? convertPhrasing(single.children, ctx)
          : direct.map((child) => convertRootContent(child, ctx)).join('')
      return `<li>${directXml}${nested.join('')}</li>`
    })
    .join('')
  const opening =
    tag === 'ol' && node.start !== null && node.start !== undefined && node.start > 1
      ? `<${tag} start="${node.start}">`
      : `<${tag}>`
  return `${opening}${items}</${tag}>`
}

function convertPhrasing(children: PhrasingContent[], ctx: CarrierRegistry): string {
  return children.map((child) => convertPhrasingNode(child, ctx)).join('')
}

function convertPhrasingNode(node: PhrasingContent, ctx: CarrierRegistry): string {
  switch (node.type) {
    case 'text':
      return splitInlineRefs(node.value, ctx)
    case 'strong':
      return `<strong>${convertPhrasing(node.children, ctx)}</strong>`
    case 'emphasis':
      return `<em>${convertPhrasing(node.children, ctx)}</em>`
    case 'delete':
      return `<del>${convertPhrasing(node.children, ctx)}</del>`
    case 'inlineCode':
      return `<code>${escapeStorageText(node.value)}</code>`
    case 'break':
      return '<br/>'
    case 'link':
      return `<a href="${escapeStorageAttr(node.url)}">${convertPhrasing(node.children, ctx)}</a>`
    case 'image':
      return `<img src="${escapeStorageAttr(node.url)}" alt="${escapeStorageAttr(node.alt ?? '')}"/>`
    case 'html': {
      // sub/sup 등 서식 태그만 verbatim 통과. script/iframe·이벤트 핸들러는 제거
      // (storage는 HTML이므로 정화 없이 넣으면 Confluence 열람자에게 XSS 가능)
      const value = node.value
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      if (/<\/?\s*(sub|sup)\b/i.test(value)) return value
      return escapeStorageText(value)
    }
    default: {
      const children = 'children' in node ? (node.children as PhrasingContent[]) : []
      return convertPhrasing(children, ctx)
    }
  }
}

function splitInlineRefs(text: string, ctx: CarrierRegistry): string {
  const escapePattern = INLINE_REF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escapePattern}([0-9a-f]+)${INLINE_REF_SUFFIX}`, 'g')
  let result = ''
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    result += escapeStorageText(text.slice(lastIndex, match.index))
    const hash = match[1]
    const carrier = ctx.carriers.get(hash)
    if (carrier) {
      ctx.emitted.add(hash)
      result += carrier.content // 제자리 재주입(원래 인라인 위치 보존)
    } else {
      result += escapeStorageText(match[0]) // 레지스트리에 없으면 토큰을 텍스트로 보존
    }
    lastIndex = match.index + match[0].length
  }
  result += escapeStorageText(text.slice(lastIndex))
  return result
}
