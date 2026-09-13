import type { Node as XmlNode } from '@xmldom/xmldom'
import { isElement, isText, parseStorageFragment } from './xml'

/**
 * storage 조각의 의미적 동등성 비교(AC-5 왕복 무손실 판정).
 * - 엔티티 정규화: 텍스트는 엔티티 해석 후 비교(&nbsp; ↔ U+00A0 동일 취급)
 * - 블록 사이 공백 전용 텍스트 노드는 무시(마크다운은 블록 간 공백을 정규화함)
 * - 속성 순서는 무시, 속성 집합이 같아야 함
 */
export function storageSemanticallyEqual(a: string, b: string): boolean {
  const aNodes = parseStorageFragment(a).filter((n) => !isWhitespaceOnly(n))
  const bNodes = parseStorageFragment(b).filter((n) => !isWhitespaceOnly(n))
  if (aNodes.length !== bNodes.length) return false
  return aNodes.every((node, index) => nodesEqual(node, bNodes[index]))
}

function isWhitespaceOnly(node: XmlNode): boolean {
  return isText(node) && (node.nodeValue ?? '').trim().length === 0
}

function nodesEqual(a: XmlNode, b: XmlNode): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (isText(a) && isText(b)) return (a.nodeValue ?? '') === (b.nodeValue ?? '')
  if (!isElement(a) || !isElement(b)) return true

  if (a.nodeName !== b.nodeName) return false

  const aAttrs = attributeMap(a)
  const bAttrs = attributeMap(b)
  if (aAttrs.size !== bAttrs.size) return false
  for (const [name, value] of aAttrs) {
    if (bAttrs.get(name) !== value) return false
  }

  const aChildren = Array.from(a.childNodes).filter((n) => !isWhitespaceOnly(n))
  const bChildren = Array.from(b.childNodes).filter((n) => !isWhitespaceOnly(n))
  if (aChildren.length !== bChildren.length) return false
  return aChildren.every((child, index) => nodesEqual(child, bChildren[index]))
}

function attributeMap(element: {
  attributes: { length: number; item(i: number): { name: string; value: string } | null } | null
}): Map<string, string> {
  const map = new Map<string, string>()
  const attrs = element.attributes
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs.item(i)
      if (attr) map.set(attr.name, attr.value)
    }
  }
  return map
}
