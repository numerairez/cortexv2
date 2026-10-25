import { useEffect, useMemo, useState } from 'react'
import type { Selection, Source } from '../types'
import { FileIcon } from './Icons'
import { Loading } from './ui'

/** Drag payload type for a dataset dragged from the library onto the canvas. */
export const DATASET_MIME = 'application/x-flowbook-dataset'
/** Prefix on the drag payload for a file that still needs its sheet chosen (a source id, not a dataset id). */
export const FILE_PREFIX = 'src:'

const extOf = (name?: string) => (name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '')
const COLLAPSED_KEY = 'cw.studio.library.collapsed'

/** The studio's left-hand library: data you already added, dragged onto the canvas to use it. */
export function LibraryPanel({ datasets, files = [], used, onAdd, onSetUp, onAddFile, nudge = 0 }: {
  datasets: Selection[] | null | undefined; used: string[]; onAdd: (s: Selection) => void; onAddFile: () => void
  /** Files added without a sheet chosen yet; adding one asks for the sheet first. */
  files?: Source[]; onSetUp: (s: Source) => void
  /** Changes when the user asks to choose data: opens the panel and briefly highlights it. */
  nudge?: number
}) {
  const [collapsed, setCollapsedState] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false } })
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v)
    try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0') } catch { /* per-viewer convenience only */ }
  }
  const [filter, setFilter] = useState('')
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!nudge) return
    setCollapsedState(false)
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1400)
    return () => clearTimeout(t)
  }, [nudge])
  const match = (text: string) => !filter || text.toLowerCase().includes(filter.toLowerCase())
  const shown = useMemo(() => (datasets ?? []).filter((s) => match(`${s.label} ${s.source_name}`)), [datasets, filter])
  const newFiles = useMemo(() => files.filter((f) => match(f.name)), [files, filter])

  if (collapsed) {
    return (
      <aside className="library collapsed">
        <button className="ghost library-tab" onClick={() => setCollapsed(false)} title="Show your data library">
          <span aria-hidden>»</span><span className="library-tab-label">Library</span>
        </button>
      </aside>
    )
  }
  return (
    <aside className={`library${flash ? ' flash' : ''}`}>
      <div className="library-head">
        <b>Library</b>
        <span className="spacer" />
        <button className="ghost icon" onClick={() => setCollapsed(true)} title="Hide the library">«</button>
      </div>
      <div className="library-search">
        <input placeholder="Search your data…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="faint small">Drag tables onto the canvas</div>
      </div>
      <div className="library-list">
        {newFiles.length > 0 && <div className="library-group warn">Needs setup · {newFiles.length}</div>}
        {newFiles.map((f) => {
          const sheets = f.metadata.sheets?.length ?? 0
          const todo = sheets > 1 ? `Choose 1 of ${sheets} sheets` : 'Confirm the header row'
          return (
            <div key={f.id} className="library-item needs-setup" draggable
              onDragStart={(e) => { e.dataTransfer.setData(DATASET_MIME, FILE_PREFIX + f.id); e.dataTransfer.effectAllowed = 'copy' }}
              onDoubleClick={() => onSetUp(f)}
              title={`${f.name}\nFlowbook needs to know which sheet and header row to read before you can use it`}>
              <span className="setup-icon">
                <FileIcon kind={f.kind} ext={extOf(f.name)} size={24} />
                <span className="setup-dot" aria-hidden>!</span>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis library-item-name">{f.name.replace(/\.[^.]+$/, '')}</div>
                <div className="small ellipsis setup-todo">{todo}</div>
              </div>
              <button className="sm setup-btn" onClick={() => onSetUp(f)}>Set up</button>
            </div>
          )
        })}
        {newFiles.length > 0 && shown.length > 0 && <div className="library-group">Ready to use</div>}
        {!datasets ? <Loading /> : shown.length === 0 && newFiles.length === 0 ? (
          <div className="empty small">{filter ? 'No matches.' : 'Nothing here yet. Add a file below.'}</div>
        ) : shown.map((s) => (
          <div key={s.id} className="library-item" draggable
            onDragStart={(e) => { e.dataTransfer.setData(DATASET_MIME, s.id); e.dataTransfer.effectAllowed = 'copy' }}
            onDoubleClick={() => onAdd(s)}
            title={`${s.label}\n${s.source_name}\nDrag onto the canvas, or double-click to add`}>
            {s.template
              ? <span className="tpl-icon"><FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={24} /><span>📅</span></span>
              : <FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={24} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis library-item-name">{s.label}</div>
              {s.produced_by ? (
                <div className="small ellipsis lineage" title={`Made by the workflow “${s.produced_by.workflow}”\nLast run ${new Date(s.produced_by.run_at).toLocaleString()} · ${s.produced_by.rows.toLocaleString()} rows`}>
                  <span aria-hidden>⚙</span> From {s.produced_by.workflow}{used.includes(s.id) && ' · in use'}
                </div>
              ) : (
                <div className="faint small ellipsis">
                  {s.template ? `${s.template.matches.length} file(s)` : `${s.config.sheet === '(csv)' ? 'CSV' : s.config.sheet} · ${s.schema?.length ?? 0} columns`}
                  {used.includes(s.id) && ' · in use'}
                </div>
              )}
            </div>
            <span className="library-grip" aria-hidden>⋮⋮</span>
          </div>
        ))}
      </div>
      <div className="library-foot">
        <button className="sm" onClick={onAddFile}>+ Add a file…</button>
      </div>
    </aside>
  )
}
