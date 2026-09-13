import type { Element, ElementContent, Root } from 'hast'
import { defaultSchema } from 'hast-util-sanitize'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { ko } from '../i18n/ko'

/**
 * 미리보기 렌더 파이프라인(계획 §6-1, ef-12 — Markdown 근사 렌더링).
 * - 캐리어 펜스(```confluence-storage)는 플레이스홀더 박스로 치환
 * - rehype-sanitize(defaultSchema 기반)로 위험 마크업 제거
 * - 실제 Confluence 모양 확인은 웹 링크로 대체(완전 재현 아님)
 */
export async function renderPreviewHtml(markdown: string): Promise<string> {
  const processor = unified()
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
    .use(carrierPlaceholders)
    .use(rehypeStringify)

  const file = await processor.process(markdown)
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
  for (const child of pre.children) {
    if (child.type === 'element' && child.tagName === 'code') {
      for (const grandchild of child.children) {
        if (grandchild.type === 'text') {
          const summary = grandchild.value.trim()
          return summary.length > 0
            ? `Confluence 요소 — ${describeCarrierXml(summary)}`
            : 'Confluence 요소'
        }
      }
    }
  }
  return 'Confluence 요소'
}

function toPlaceholder(pre: Element): Element {
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['confluence-placeholder'] },
    children: [
      {
        type: 'element',
        tagName: 'em',
        properties: {},
        children: [{ type: 'text', value: placeholderLabel(pre) }],
      },
    ],
  }
}

function isPlaceholderBox(node: unknown): node is Element {
  if (!node || typeof node !== 'object') return false
  const element = node as { type?: string; tagName?: string; properties?: { className?: unknown } }
  if (element.type !== 'element' || element.tagName !== 'div') return false
  const classes = element.properties?.className
  return Array.isArray(classes) && classes.includes('confluence-placeholder')
}

const carrierPlaceholders = () => {
  return (tree: Root): void => {
    walkChildren(tree as unknown as { children: unknown[] })
    appendCarrierOnlyHint(tree)
  }

  function walkChildren(parent: { children: unknown[] }): void {
    if (!Array.isArray(parent.children)) return
    const next: unknown[] = []
    for (const child of parent.children) {
      if (isCarrierPreElement(child)) {
        next.push(toPlaceholder(child))
        continue
      }
      if (
        child &&
        typeof child === 'object' &&
        Array.isArray((child as { children?: unknown[] }).children)
      ) {
        walkChildren(child as { children: unknown[] })
      }
      next.push(child)
    }
    parent.children = next as ElementContent[]
  }

  /** 문서가 플레이스홀더뿐이면(레이아웃 매크로 단독 페이지 등) 제한 안내를 덧붙인다. */
  function appendCarrierOnlyHint(tree: Root): void {
    const children = tree.children
    const hasPlaceholder = children.some((child) => isPlaceholderBox(child))
    if (!hasPlaceholder) return
    const hasOtherContent = children.some(
      (child) =>
        !isPlaceholderBox(child) && !(child.type === 'text' && child.value.trim().length === 0),
    )
    if (hasOtherContent) return
    children.push({
      type: 'element',
      tagName: 'div',
      properties: { className: ['confluence-placeholder'] },
      children: [{ type: 'text', value: ko.preview.carrierOnly }],
    })
  }
}
