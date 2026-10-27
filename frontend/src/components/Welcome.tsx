import { useState } from 'react'
import { api } from '../api'
import type { Settings } from '../types'
import { FolderPicker } from './FolderPicker'

/** First launch: say hello and ask where results should be saved. */
export function Welcome({ settings, onDone }: { settings: Settings; onDone: (s: Settings) => void }) {
  const [folder, setFolder] = useState(settings.save_folder || settings.suggested_save_folder)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const finish = async (save_folder: string | null) => {
    setBusy(true)
    setError(null)
    try {
      onDone(await api.put<Settings>('/api/settings', { ...(save_folder ? { save_folder } : {}), welcomed: true }))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <img src="/logo.svg" alt="" width="44" height="44" />
        <h1>Welcome to Flowbook</h1>
        <p className="muted">Where should your files be saved?</p>
        <button className="welcome-folder" onClick={() => setPicking(true)} title="Choose another folder">
          <span aria-hidden>📁</span>
          <span className="mono ellipsis">{folder}</span>
          <span className="welcome-change">Change</span>
        </button>
        {error && <div className="bad-text small">{error}</div>}
        <button className="primary welcome-go" disabled={busy || !folder} onClick={() => finish(folder)}>Continue</button>
        <button className="link faint small" disabled={busy} onClick={() => finish(null)}>Skip for now</button>
        <p className="faint small" style={{ margin: 0 }}>You can change this anytime in Settings.</p>
      </div>
      {picking && <FolderPicker title="Save files to…" start={folder} onClose={() => setPicking(false)}
        onPick={(p) => { setFolder(p); setPicking(false); setError(null) }} />}
    </div>
  )
}
