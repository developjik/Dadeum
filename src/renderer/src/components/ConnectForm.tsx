import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'
import { AlertIcon, BrandMark } from './icons'

export function ConnectForm(): React.ReactElement {
  const connect = useAppStore((s) => s.connect)
  const openExternal = useAppStore((s) => s.openExternal)
  const busy = useAppStore((s) => s.busy)
  const error = useAppStore((s) => s.error)
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  // 세 필드가 모두 채워졌을 때만 연결 시도 — 빈 값 제출로 서버 오류를 대신 낸다
  const canSubmit =
    siteUrl.trim().length > 0 && email.trim().length > 0 && apiToken.trim().length > 0

  return (
    <form
      className="connect-card"
      aria-label={ko.aria.connect}
      onSubmit={(event) => {
        event.preventDefault()
        void connect(siteUrl, email, apiToken)
      }}
    >
      <div className="connect-card__head">
        <BrandMark size={34} />
        <h1 className="connect-card__title">{ko.app.title}</h1>
        <p className="connect-card__tagline">{ko.app.tagline}</p>
      </div>
      <div className="connect-card__fields">
        <label className="field">
          <span className="field__label">{ko.auth.siteUrl}</span>
          <input
            className="text-input"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://xxx.atlassian.net"
            inputMode="url"
            autoComplete="url"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field__label">{ko.auth.email}</span>
          <input
            className="text-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={ko.auth.emailPlaceholder}
            autoComplete="email"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field__label">{ko.auth.apiToken}</span>
          <input
            className="text-input"
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <span className="field__hint">{ko.auth.tokenHint}</span>
          <button
            type="button"
            className="btn btn--subtle field__link"
            onClick={() =>
              void openExternal('https://id.atlassian.com/manage-profile/security/api-tokens')
            }
          >
            {ko.auth.tokenLink}
          </button>
        </label>
        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !canSubmit}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {ko.auth.connect}
        </button>
      </div>
      {error ? (
        <div className="form-alert" role="alert">
          <AlertIcon size={14} />
          <span>{error}</span>
        </div>
      ) : null}
    </form>
  )
}
