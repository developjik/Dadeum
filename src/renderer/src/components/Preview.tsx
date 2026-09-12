import { ko } from '../../../core/i18n/ko'
import type { SelectedPage } from '../state/appStore'
import { useAppStore } from '../state/appStore'

export function Preview({ page }: { page: SelectedPage }): React.ReactElement {
  const openExternal = useAppStore((s) => s.openExternal)
  return (
    <section aria-label="page-preview">
      <header>
        <h1>{page.title}</h1>
        <span>v{page.version}</span>
        <button type="button" onClick={() => void openExternal(page.url)}>
          {ko.preview.webLink}
        </button>
      </header>
      {/* rehype-sanitize를 통과한 HTML만 주입된다(core/preview/render) */}
      <div className="preview" dangerouslySetInnerHTML={{ __html: page.html }} />
    </section>
  )
}
