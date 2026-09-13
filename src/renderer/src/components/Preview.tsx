import { ko } from '../../../core/i18n/ko'
import type { SelectedPage } from '../state/appStore'
import { useAppStore } from '../state/appStore'
import { ExternalIcon } from './icons'

export function Preview({ page }: { page: SelectedPage }): React.ReactElement {
  const openExternal = useAppStore((s) => s.openExternal)
  const pageLoading = useAppStore((s) => s.pageLoading)
  return (
    <section className="preview-pane" aria-label={ko.aria.pagePreview}>
      <header className="preview-pane__header">
        {pageLoading ? <span className="spinner" aria-hidden="true" /> : null}
        <h1 className="preview-pane__title">{page.title}</h1>
        <span className="badge badge--neutral">v{page.version}</span>
        <button
          type="button"
          className="btn btn--default"
          onClick={() => void openExternal(page.url)}
        >
          <ExternalIcon />
          {ko.preview.webLink}
        </button>
      </header>
      {/* rehype-sanitize를 통과한 HTML만 주입된다(core/preview/render) */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 렌더링 전 rehype-sanitize 파이프라인으로 살균된 HTML이다 */}
      <div className="preview-body" dangerouslySetInnerHTML={{ __html: page.html }} />
    </section>
  )
}
