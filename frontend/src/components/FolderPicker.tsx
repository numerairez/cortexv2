import { useEffect, useState } from 'react'
import { api, qs } from '../api'
import { ErrorBox, Loading, Modal } from './ui'

interface Entry { name: string; path: string; type: 'dir' | 'file' }
interface Listing { path: string | null; parent: string | null; roots: { name: string; path: string }[]; entries: Entry[] }

/** Browse folders on this PC / mapped drives and choose one. */
export function FolderPicker({ start, title = 'Choose the output folder', onPick, onClose }: { start?: string | null; title?: string; onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState<string | null>(start || null)
  const [data, setData] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<Listing>(`/api/fs/browse?${qs({ path })}`)
      .then((d) => { setData(d); setError(null) })
      .catch((e: Error) => { setError(e.message); if (path) setPath(null) })
  }, [path])

  const dirs = (data?.entries ?? []).filter((e) => e.type === 'dir')
  return (
    <Modal title={title} wide onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!data?.path} onClick={() => data?.path && onPick(data.path)}>Use this folder</button>
    </>}>
      <div className="card flush">
        <div className="row" style={{ padding: 8, borderBottom: '1px solid var(--line)', gap: 6 }}>
          {data?.roots.map((r) => <button key={r.path} className="sm" onClick={() => setPath(r.path)}>{r.name}</button>)}
        </div>
        <div className="row" style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
          <button className="sm" disabled={!data?.parent} onClick={() => setPath(data?.parent ?? null)}>↑ Up</button>
          <span className="mono small ellipsis" style={{ flex: 1 }} title={data?.path ?? ''}>{data?.path ?? 'Choose a starting place above'}</span>
        </div>
        <ErrorBox error={error} />
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          {!data ? <Loading /> : data.path && dirs.length === 0 ? <div className="empty small">No sub-folders here. Use this folder, or go up.</div>
            : dirs.map((e) => (
              <div key={e.path} className="list-item clickable-row" style={{ padding: '6px 12px' }} onClick={() => setPath(e.path)}>
                <span aria-hidden>📁</span><span className="grow ellipsis">{e.name}</span>
              </div>
            ))}
        </div>
      </div>
    </Modal>
  )
}
