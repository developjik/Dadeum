import type { Element, ElementContent, Root } from 'hast'
import { defaultSchema } from 'hast-util-sanitize'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { ko } from '../i18n/ko'
import {
  describeInlineCarrier,
  extractCarrierBodyMarkdown,
  inlineRefPattern,
  splitCarrierStorage,
} from './carrierContent'

/**
 * 미리보기 렌더 파이프라인(계획 §6-1, ef-12 — Markdown 근사 렌더링).
 * - 캐리어 펜스(```confluence-storage)는 요소 라벨이 붙은 플레이스홀더 박스로
 *   치환하고, 읽을 수 있는 본문(레이아웃 셀·매크로 rich-text-body 등)이 있으면
 *   박스 안에 근사 렌더링한다(중첩 캐리어는 같은 파이프라인으로 재귀 처리).
 * - 문서 끝 캐리어 구역은 역변환 전용 저장소이므로 숨기고, 본문의 인라인 ref
 *   토큰은 원본 XML 요약(문서 제목 등)으로 바꿔 보여준다.
 * - 삽입되는 hast는 항상 한 단계 깊은 파이프라인(rehype-sanitize 포함)의
 *   결과물이다 — 새니타이즈를 건너뛰는 콘텐츠는 없다.
 * - 실제 Confluence 모양 확인은 웹 링크로 대체(완전 재현 아님)
 */

/** 레이아웃 속 매크로 속 레이아웃… 같은 중첩 폭주 방지(초과 시 라벨만). */
const MAX_CARRIER_RENDER_DEPTH = 4

interface PlaceholderContext {
  depth: number
  registry: Map<string, string>
}

function createPreviewProcessor(context: PlaceholderContext) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSanitize, {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        code: [...(defaultSchema.attributes?.code ?? []), ['className']],
        div: [...(defaultSchema.attributes?.div ?? []), ['className']],
      },
    })
    .use(carrierPlaceholders, context)
    .use(rehypeStringify)
}

export async function renderPreviewHtml(markdown: string): Promise<string> {
  const { body, registry } = splitCarrierStorage(markdown)
  const file = await createPreviewProcessor({ depth: 0, registry }).process(body)
  return String(file)
}

/** 미리보기 파이프라인에서 캐리어 펜스(pre) 요소를 판별한다. */
function isCarrierPreElement(node: unknown): node is Element {
  if (!node || typeof node !== 'object') return false
  const element = node as { type?: string; tagName?: string; children?: unknown[] }
  if (element.type !== 'element' || element.tagName !== 'pre') return false
  for (const child of element.children ?? []) {
    const code = child as { type?: string; tagName?: string; properties?: { className?: unknown } }
    if (code.type === 'element' && code.tagName === 'code') {
      const classes = code.properties?.className
      if (Array.isArray(classes) && classes.includes('language-confluence-storage')) return true
    }
  }
  return false
}

/** 캐리어 펜스의 XML 본문 텍스트를 꺼낸다(없으면 빈 문자열). */
function carrierXml(pre: Element): string {
  for (const child of pre.children) {
    if (child.type === 'element' && child.tagName === 'code') {
      for (const grandchild of child.children) {
        if (grandchild.type === 'text') return grandchild.value.trim()
      }
    }
  }
  return ''
}

/**
 * 캐리어 XML의 뿌리 요소를 사용자 언어로 요약한다. 원문 XML을 그대로 보여주면
 * 페이지 전체가 레이아웃 매크로인 경우(구형 Confluence 페이지에 흔하다) 미리보기가
 * 개발자 도구처럼 보인다 — 요소 종류를 먼저 알려주고 알 수 없을 때만 원문 일부를 보인다.
 */
function describeCarrierXml(xml: string): string {
  const trimmed = xml.trim()
  if (/^<ac:layout[\s>]/.test(trimmed)) return '페이지 레이아웃'
  const macro = trimmed.match(/<ac:structured-macro[^>]*\bac:name="([^"]+)"/)
  if (macro) return `${macro[1]} 매크로`
  if (/^<ac:link[\s>]/.test(trimmed)) return '페이지 링크'
  if (/colspan=|rowspan=/.test(trimmed.slice(0, 500))) return '병합 셀 표'
  return trimmed.slice(0, 60)
}

function placeholderLabel(pre: Element): string {
  const summary = carrierXml(pre)
  return summary.length > 0 ? `Confluence 요소 — ${describeCarrierXml(summary)}` : 'Confluence 요소'
}

interface TextNode {
  type: 'text'
  value: string
}

function isTextNode(node: unknown): node is TextNode {
  return !!node && typeof node === 'object' && (node as { type?: string }).type === 'text'
}

const carrierPlaceholders = (context: PlaceholderContext) => {
  return async (tree: Root): Promise<void> => {
    await walkChildren(tree as unknown as { children: unknown[] })
    appendCarrierOnlyHint(tree)
  }

  async function walkChildren(parent: { children: unknown[] }): Promise<void> {
    if (!Array.isArray(parent.children)) return
    const next: unknown[] = []
    for (const child of parent.children) {
      if (isCarrierPreElement(child)) {
        next.push(await toPlaceholder(child, context))
        continue
      }
      if (isTextNode(child)) {
        next.push(...replaceInlineRefs(child.value, context.registry))
        continue
      }
      if (
        child &&
        typeof child === 'object' &&
        Array.isArray((child as { children?: unknown[] }).children)
      ) {
        await walkChildren(child as { children: unknown[] })
      }
      next.push(child)
    }
    parent.children = next as ElementContent[]
  }

  /** 캐리어 펜스 → 라벨 헤더 + (추출 가능하면) 근사 렌더링된 본문. */
  async function toPlaceholder(pre: Element, ctx: PlaceholderContext): Promise<Element> {
    const header: Element = {
      type: 'element',
      tagName: 'em',
      properties: { className: ['confluence-placeholder__header'] },
      children: [{ type: 'text', value: placeholderLabel(pre) }],
    }
    const body = await renderCarrierBody(carrierXml(pre), ctx)
    if (body === null) {
      return {
        type: 'element',
        tagName: 'div',
        properties: { className: ['confluence-placeholder'] },
        children: [header],
      }
    }
    return {
      type: 'element',
      tagName: 'div',
      properties: { className: ['confluence-placeholder'] },
      children: [
        header,
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['confluence-placeholder__body'] },
          children: body,
        },
      ],
    }
  }

  /**
   * 캐리어 XML 본문을 한 단계 깊은 파이프라인(새니타이즈 포함)으로 렌더링한
   * hast 자식 노드를 반환한다. 읽을 내용이 없거나 깊이 상한 초과면 null.
   */
  async function renderCarrierBody(
    xml: string,
    ctx: PlaceholderContext,
  ): Promise<ElementContent[] | null> {
    if (ctx.depth >= MAX_CARRIER_RENDER_DEPTH) return null
    const inner = extractCarrierBodyMarkdown(xml)
    if (inner === null) return null
    const { body, registry } = splitCarrierStorage(inner)
    if (body.trim().length === 0) return null
    const nested = createPreviewProcessor({ depth: ctx.depth + 1, registry })
    const mdast = nested.parse(body)
    const hast = (await nested.run(mdast)) as Root
    return hast.children as ElementContent[]
  }

  /** 문단 흐름의 인라인 ref 토큰을 원본 XML 요약 텍스트로 바꾼다. */
  function replaceInlineRefs(value: string, registry: Map<string, string>): ElementContent[] {
    if (!value.includes('confluence-ref')) return [{ type: 'text', value }]
    const nodes: ElementContent[] = []
    let lastIndex = 0
    for (const match of value.matchAll(inlineRefPattern())) {
      const index = match.index ?? 0
      if (index > lastIndex) nodes.push({ type: 'text', value: value.slice(lastIndex, index) })
      const xml = registry.get(match[1])
      const label = (xml !== undefined ? describeInlineCarrier(xml) : null) ?? 'Confluence 요소'
      nodes.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['confluence-ref'] },
        children: [{ type: 'text', value: label }],
      })
      lastIndex = index + match[0].length
    }
    if (lastIndex < value.length) nodes.push({ type: 'text', value: value.slice(lastIndex) })
    return nodes.length > 0 ? nodes : [{ type: 'text', value }]
  }

  /** 문서 전체가 "읽을 내용 없는 플레이스홀더"뿐이면 제한 안내를 덧붙인다. */
  function appendCarrierOnlyHint(tree: Root): void {
    const children = tree.children
    const boxes = children.filter(isPlaceholderBox)
    if (boxes.length === 0) return
    const hasOtherContent = children.some(
      (child) =>
        !isPlaceholderBox(child) && !(child.type === 'text' && child.value.trim().length === 0),
    )
    if (hasOtherContent) return
    const anyReadable = boxes.some((box) => hasRenderedBody(box))
    if (anyReadable) return
    children.push({
      type: 'element',
      tagName: 'div',
      properties: { className: ['confluence-placeholder'] },
      children: [{ type: 'text', value: ko.preview.carrierOnly }],
    })
  }
}

function isPlaceholderBox(node: unknown): node is Element {
  if (!node || typeof node !== 'object') return false
  const element = node as { type?: string; tagName?: string; properties?: { className?: unknown } }
  if (element.type !== 'element' || element.tagName !== 'div') return false
  const classes = element.properties?.className
  return Array.isArray(classes) && classes.includes('confluence-placeholder')
}

/** 플레이스홀더 박스가 렌더링된 본문(__body)을 갖고 있는지 — 빈 박스가 아닌지 판정. */
function hasRenderedBody(box: Element): boolean {
  for (const child of box.children) {
    if (child.type !== 'element') continue
    const classes = child.properties?.className
    if (Array.isArray(classes) && classes.includes('confluence-placeholder__body')) {
      return child.children.length > 0
    }
  }
  return false
}
