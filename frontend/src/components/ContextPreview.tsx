import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ContextPreview as Preview, Redaction } from '../types'
import { ErrorBox, Loading } from './ui'

/** Shows exactly what would leave the PC, with per-passage exclusion and find/replace redaction. */
export function ContextPreview({ collectionId, excluded, setExcluded, redactions, setRedactions, onSummary }: {
  collectionId: string
  excluded: string[]
  setExcluded: (v: string[]) => void
  redactions: Redaction[]
  setRedactions: (v: Redaction[]) => void
  onSummary?: (p: Preview) => void
}) {
  const [data, setData] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const t = setTimeout(() => {
      api.post<Preview>('/api/context/preview', {
        collection_id: collectionId, exclude_anchors: excluded, redactions: redactions.filter((r) => r.find.trim()),
      })
        .then((d) => { setData(d); setError(null); onSummary?.(d) })
        .catch((e: Error) => setError(e.message))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, excluded, redactions])

  if (error) return <ErrorBox error={error} />
  if (!data) return <Loading text="Reading sources…" />

  const toggle = (a: string) => setExcluded(excluded.includes(a) ? excluded.filter((x) => x !== a) : [...excluded, a])
  const setItem = (anchors: string[], include: boolean) =>
    setExcluded(include ? excluded.filter((x) => !anchors.includes(x)) : [...new Set([...excluded, ...anchors])])
  const pct = Math.min(100, Math.round((data.estimated_tokens / data.token_budget) * 100))

  return (
    <div className="stack">
      <div className={`alert ${data.over_budget ? 'bad' : 'info'}`}>
        <div className="row between">
          <b>About {data.estimated_tokens.toLocaleString()} tokens</b>
          <span className="small">{data.characters.toLocaleString()} characters · budget {data.token_budget.toLocaleString()}</span>
        </div>
        <div style={{ height: 6, background: 'var(--line)', borderRadius: 4, marginTop: 6 }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: data.over_budget ? 'var(--bad)' : 'var(--accent)' }} />
        </div>
        {data.over_budget && <div className="small" style={{ marginTop: 6 }}>This is likely too large to paste into a chatbot. Exclude passages below or remove items from the collection.</div>}
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Redactions ({redactions.filter((r) => r.find.trim()).length})</summary>
        <p className="muted small" style={{ marginTop: 6 }}>Replace names, account numbers, or other text before it is copied. Matching ignores upper/lower case.</p>
        {redactions.map((r, i) => (
          <div className="row" key={i} style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
            <input placeholder="Find text" value={r.find} onChange={(e) => setRedactions(redactions.map((x, j) => (j === i ? { ...x, find: e.target.value } : x)))} />
            <input placeholder="[REDACTED]" value={r.replace} onChange={(e) => setRedactions(redactions.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))} />
            <button className="ghost icon" onClick={() => setRedactions(redactions.filter((_, j) => j !== i))} aria-label="Remove redaction">✕</button>
          </div>
        ))}
        <button className="sm" onClick={() => setRedactions([...redactions, { find: '', replace: '[REDACTED]' }])}>+ Add redaction</button>
      </details>

      {data.items.map((it) => {
        const anchors = it.segments.map((s) => s.anchor)
        const included = it.segments.filter((s) => s.included).length
        return (
          <div key={it.ref} className="card" style={{ padding: 12 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <span className="badge info mono">{it.ref}</span>
              <div className="grow" style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }} className="ellipsis">{it.label}</div>
                <div className="faint small">{it.kind} · {included}/{it.segments.length} passages · {it.version}</div>
              </div>
              <button className="sm" onClick={() => setItem(anchors, included < anchors.length)}>{included < anchors.length ? 'Include all' : 'Exclude all'}</button>
              <button className="sm" onClick={() => setOpen({ ...open, [it.ref]: !open[it.ref] })}>{open[it.ref] ? 'Hide' : 'Show'} passages</button>
            </div>
            {it.error && <div className="alert bad small" style={{ marginTop: 8 }}>{it.error}</div>}
            {it.warnings.map((w) => <div key={w} className="alert warn small" style={{ marginTop: 8 }}>{w}</div>)}
            {open[it.ref] && it.segments.map((s) => (
              <div key={s.anchor} className={`segment${s.included ? '' : ' excluded'}`}>
                <label className="check small">
                  <input type="checkbox" checked={s.included} onChange={() => toggle(s.anchor)} />
                  <span className="mono">{s.anchor}</span> <span className="muted">{s.locator}</span> <span className="faint">· {s.chars.toLocaleString()} chars</span>
                </label>
                <div className="text">{s.text}{s.truncated && '…'}</div>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
