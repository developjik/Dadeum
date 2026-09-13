import { describe, expect, it } from 'vitest'
import { buildPageTree, type PageTreeNode } from './tree'

const row = (pageId: string, title: string, parentId: string | null, path = '') => ({
  pageId,
  title,
  path: path || `spaces/DEV/${pageId}/index.md`,
  version: 1,
  parentId,
  remoteDeleted: false,
})

describe('buildPageTree', () => {
  it('parentId 기준으로 부모-자식 트리를 만든다', () => {
    const tree = buildPageTree([
      row('p1', '루트', null),
      row('p2', '자식', 'p1'),
      row('p3', '손주', 'p2'),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.pageId).toBe('p1')
    expect(tree[0]?.children[0]?.pageId).toBe('p2')
    expect(tree[0]?.children[0]?.children[0]?.pageId).toBe('p3')
  })

  it('고아 페이지(부모 레코드 부재)는 루트로 강등해 유실하지 않는다', () => {
    const tree = buildPageTree([row('orphan', '고아', 'missing-parent')])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.pageId).toBe('orphan')
  })

  it('한글 제목 가나다순으로 정렬한다', () => {
    const tree = buildPageTree([row('b', '나', null), row('a', '가', null)])
    expect(tree.map((node) => node.title)).toEqual(['가', '나'])
  })

  it('자기 자신을 부모로 참조하는 순환도 루트로 처리한다', () => {
    const tree = buildPageTree([row('self', '순환', 'self')])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.children).toHaveLength(0)
  })

  it('트리 노드가 원격 삭제 표시를 보존한다', () => {
    const tree = buildPageTree([
      { ...row('p1', '삭제됨', null), remoteDeleted: true },
    ]) as PageTreeNode[]
    expect(tree[0]?.remoteDeleted).toBe(true)
  })
})

describe('다중 노드 parentId 순환(P3)', () => {
  it('2-순환(A↔B) 페이지가 트리에서 사라지지 않는다', () => {
    const tree = buildPageTree([row('a', 'A', 'b'), row('b', 'B', 'a')])
    const visible = new Set(tree.flatMap(collectIds))
    expect(visible.has('a')).toBe(true)
    expect(visible.has('b')).toBe(true)
  })

  it('3-순환(A→B→C→A)도 유실 없이 표시된다', () => {
    const tree = buildPageTree([row('a', 'A', 'c'), row('b', 'B', 'a'), row('c', 'C', 'b')])
    const visible = new Set(tree.flatMap(collectIds))
    expect(visible.has('a')).toBe(true)
    expect(visible.has('b')).toBe(true)
    expect(visible.has('c')).toBe(true)
  })
})

function collectIds(node: PageTreeNode): string[] {
  return [node.pageId, ...node.children.flatMap(collectIds)]
}
