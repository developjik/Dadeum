import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import type { PageTreeNode } from '../../../core/store/tree'
import { ChevronIcon } from './icons'

type TreeItemProps = {
  node: PageTreeNode
  depth: number
  selectedPath?: string
  collapsed: Set<string>
  onToggle: (pageId: string) => void
  onOpen: (path: string) => void
}

function TreeItem({
  node,
  depth,
  selectedPath,
  collapsed,
  onToggle,
  onOpen,
}: TreeItemProps): React.ReactElement {
  const hasChildren = node.children.length > 0
  const isCollapsed = collapsed.has(node.pageId)
  return (
    <li>
      <div className="tree-item" style={{ paddingLeft: depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            className={`tree-toggle${isCollapsed ? '' : ' tree-toggle--open'}`}
            aria-expanded={!isCollapsed}
            aria-label={node.title}
            onClick={() => onToggle(node.pageId)}
          >
            <ChevronIcon size={12} />
          </button>
        ) : (
          <span className="tree-toggle tree-toggle--spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`tree-row${selectedPath === node.path ? ' tree-row--selected' : ''}`}
          onClick={() => onOpen(node.path)}
        >
          <span
            className={`tree-row__title${node.remoteDeleted ? ' tree-row__title--deleted' : ''}`}
          >
            {node.title}
          </span>
          {node.remoteDeleted ? (
            <span className="badge badge--danger">{ko.sync.remoteDeleted}</span>
          ) : null}
        </button>
      </div>
      {hasChildren && !isCollapsed ? (
        <ul>
          {node.children.map((child) => (
            <TreeItem
              key={child.pageId}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function DocTree({
  tree,
  selectedPath,
  onOpen,
}: {
  tree: PageTreeNode[]
  selectedPath?: string
  onOpen: (path: string) => void
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (pageId: string): void => {
    const next = new Set(collapsed)
    if (next.has(pageId)) next.delete(pageId)
    else next.add(pageId)
    setCollapsed(next)
  }

  if (tree.length === 0) return <p className="tree__empty">{ko.tree.empty}</p>
  return (
    <nav className="tree" aria-label="document-tree">
      <ul>
        {tree.map((node) => (
          <TreeItem
            key={node.pageId}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            collapsed={collapsed}
            onToggle={toggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </nav>
  )
}
