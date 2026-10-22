import { useEffect, useState } from 'react'
import { api, qs } from '../api'
import { FileIcon } from './Icons'
import { ErrorBox, Loading, fmtBytes } from './ui'

interface Entry { name: string; path: string; type: 'dir' | 'file'; size?: number }
interface Listing { path: string | null; parent: string | null; roots: { name: string; path: string }[]; entries: Entry[] }

const LAST_DIR_KEY = 'cw.lastDir'

function lastDir(): string | null {
  try { return localStorage.getItem(LAST_DIR_KEY) } catch { return null }
}

/** Server-side folder browser: browsers cannot reveal real file paths from a file picker. */
export function FileBrowser({ onPick, selected }: { onPick: (path: string) => void; selected?: string[] }) {
  const [path, setPath] = useState<string | null>(lastDir())
  const [data, setData] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.get<Listing>(`/api/fs/browse?${qs({ path })}`)
      .then((d) => {
        setData(d); setError(null)
        if (d.path) { try { localStorage.setItem(LAST_DIR_KEY, d.path) } catch { /* ignore */ } }
      })
      .catch((e: Error) => {
        setError(e.message)
        if (path) setPath(null)
      })
      .finally(() => setLoading(false))
  }, [path])

  return (
    <div className="card flush">
      <div className="row" style={{ padding: 8, borderBottom: '1px solid var(--line)', gap: 6 }}>
        {data?.roots.map((r) => (
          <button key={r.path} className="sm" onClick={() => setPath(r.path)}>{r.name}</button>
        ))}
      </div>
      <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)' }}>
        <button className="sm" disabled={!data?.parent} onClick={() => setPath(data?.parent ?? null)}>↑ Up</button>
        <span className="mono small ellipsis" style={{ flex: 1 }} title={data?.path ?? ''}>{data?.path ?? 'Choose a starting folder'}</span>
      </div>
      <ErrorBox error={error} />
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        {loading && <Loading />}
        {!loading && data?.path && data.entries.length === 0 && <div className="empty small">No folders or supported files here.</div>}
        {!loading && data?.entries.map((e) => (
          <div
            key={e.path}
            className="list-item"
            style={{ cursor: 'pointer', padding: '6px 12px', background: selected?.includes(e.path) ? 'var(--accent-soft)' : undefined }}
            onClick={() => (e.type === 'dir' ? setPath(e.path) : onPick(e.path))}
          >
            {e.type === 'dir' ? <span aria-hidden style={{ width: 20, textAlign: 'center' }}>📁</span> : <FileIcon ext={e.name.match(/\.[a-z0-9]+$/i)?.[0]} size={18} />}
            <span className="grow ellipsis">{e.name}</span>
            {e.type === 'file' && <span className="faint small">{fmtBytes(e.size)}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
