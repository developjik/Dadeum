import type { PageRecord } from './syncState'

export interface PageTreeNode {
  pageId: string
  title: string
  path: string
  version: number
  parentId: string | null
  remoteDeleted: boolean
  children: PageTreeNode[]
}

/**
 * 플랫 페이지 레코드를 parentId 기준 트리로 조립한다(§7 — 계층 = Confluence 페이지 트리).
 * 부모가 없는 페이지·순환은 루트로 강등해 유실 없이 표시한다.
 */
export function buildPageTree(pages: Array<Pick<PageRecord, 'pageId' | 'title' | 'path' | 'version' | 'parentId' | 'remoteDeleted'>>): PageTreeNode[] {
  type Work = PageTreeNode & { parentId: string | null }
  const nodes = new Map<string, Work>()
  for (const page of pages) {
    nodes.set(page.pageId, {
      pageId: page.pageId,
      title: page.title,
      path: page.path,
      version: page.version,
      parentId: page.parentId,
      remoteDeleted: page.remoteDeleted,
      children: []
    })
  }

  const roots: Work[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId !== null ? nodes.get(node.parentId) : undefined
    if (parent && parent.pageId !== node.pageId) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // 부모가 나중에 등장한 경우: 자식으로 흡수되지 않은 노드 중 부모를 찾으면 이동
  for (const node of [...nodes.values()]) {
    if (node.parentId === null) continue
    const parent = nodes.get(node.parentId)
    if (!parent || parent.pageId === node.pageId) continue
    if (parent.children.includes(node)) continue
    if (roots.includes(node)) {
      roots.splice(roots.indexOf(node), 1)
      parent.children.push(node)
    }
  }

  const sortTree = (list: Work[]): void => {
    list.sort((a, b) => a.title.localeCompare(b.title, 'ko'))
    for (const node of list) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}
