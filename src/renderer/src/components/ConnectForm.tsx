import { useState } from 'react'
import { ko } from '../../../core/i18n/ko'
import { useAppStore } from '../state/appStore'

export function ConnectForm(): React.ReactElement {
  const connect = useAppStore((s) => s.connect)
  const busy = useAppStore((s) => s.busy)
  const error = useAppStore((s) => s.error)
  const [siteUrl, setSiteUrl] = useState('')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')

  return (
    <form
      aria-label="confluence-connect"
      onSubmit={(event) => {
        event.preventDefault()
        void connect(siteUrl, email, apiToken)
      }}
    >
      <h2>{ko.auth.connect} — Confluence Cloud</h2>
      <label>
        {ko.auth.siteUrl}
        <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://xxx.atlassian.net" />
      </label>
      <label>
        {ko.auth.email}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        {ko.auth.apiToken}
        <input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        {ko.auth.connect}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}
