import { ko } from '../../../core/i18n/ko'
import type { PageTreeNode } from '../../../core/store/tree'

function TreeItem({ node, onOpen }: { node: PageTreeNode; onOpen: (path: string) => void }): React.ReactElement {
  return (
    <li>
      <button type="button" onClick={() => onOpen(node.path)}>
        {node.remoteDeleted ? `${node.title} (${ko.sync.remoteDeleted})` : node.title}
      </button>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <TreeItem key={child.pageId} node={child} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function DocTree({ tree, onOpen }: { tree: PageTreeNode[]; onOpen: (path: string) => void }): React.ReactElement {
  if (tree.length === 0) return <p>{ko.tree.empty}</p>
  return (
    <nav aria-label="document-tree">
      <ul>
        {tree.map((node) => (
          <TreeItem key={node.pageId} node={node} onOpen={onOpen} />
        ))}
      </ul>
    </nav>
  )
}
