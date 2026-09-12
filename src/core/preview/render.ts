import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import { defaultSchema } from 'hast-util-sanitize'
import { unified } from 'unified'
import type { Element, ElementContent, Root } from 'hast'

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
        div: [...(defaultSchema.attributes?.div ?? []), ['className']]
      }
    })
    .use(carrierPlaceholders)
    .use(rehypeStringify)

  const file = await processor.process(markdown)
  return String(file)
}

/** 미리보기 파이프라인이 캐리어를 플레이스홀더로 바꾸는지 판정용 헬퍼(테스트·UI 공용). */
export function isCarrierPreElement(node: unknown): node is Element {
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

function placeholderLabel(pre: Element): string {
  for (const child of pre.children) {
    if (child.type === 'element' && child.tagName === 'code') {
      for (const grandchild of child.children) {
        if (grandchild.type === 'text') {
          const summary = grandchild.value.trim()
          return summary.length > 0 ? `Confluence 요소 — ${summary.slice(0, 60)}` : 'Confluence 요소'
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
        children: [{ type: 'text', value: placeholderLabel(pre) }]
      }
    ]
  }
}

const carrierPlaceholders = () => {
  return (tree: Root): void => {
    walkChildren(tree as unknown as { children: unknown[] })
  }

  function walkChildren(parent: { children: unknown[] }): void {
    if (!Array.isArray(parent.children)) return
    const next: unknown[] = []
    for (const child of parent.children) {
      if (isCarrierPreElement(child)) {
        next.push(toPlaceholder(child))
        continue
      }
      if (child && typeof child === 'object' && Array.isArray((child as { children?: unknown[] }).children)) {
        walkChildren(child as { children: unknown[] })
      }
      next.push(child)
    }
    parent.children = next as ElementContent[]
  }
}
