import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { FileBrowser } from '../components/FileBrowser'
import { Empty, ErrorBox, Field, Loading, Modal, Spinner, fmtBytes, fmtDate, sourceModified, useLoad, useToast } from '../components/ui'
import type { DataTemplate, Source } from '../types'
import { FileIcon, fileTypeFor } from '../components/Icons'
import { SourceDetailView } from './SourceDetail'

// ---------- canvas layout: every source sits in a grid cell; positions are remembered per browser

const CELL_W = 136
const CELL_H = 156
const PAD = 12
const POS_KEY = 'flowbook.sourcePositions'

type Cell = { c: number; r: number }
type Layout = Record<string, Cell>

function loadPositions(): Layout {
  try { return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') } catch { return {} }
}
function savePositions(l: Layout) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(l)) } catch { /* ignore */ }
}
const cellKey = ({ c, r }: Cell) => `${c},${r}`

/** Saved cells first (a clash sends the later one back to unplaced), then unplaced sources fill free cells row by row. */
function layOut(list: Source[], saved: Layout, cols: number): Layout {
  const out: Layout = {}
  const taken = new Set<string>()
  const unplaced: Source[] = []
  for (const s of list) {
    const p = saved[s.id]
    if (p && !taken.has(cellKey(p))) { out[s.id] = p; taken.add(cellKey(p)) } else unplaced.push(s)
  }
  let n = 0
  for (const s of unplaced) {
    let cell: Cell
    do { cell = { c: n % cols, r: Math.floor(n / cols) }; n++ } while (taken.has(cellKey(cell)))
    out[s.id] = cell; taken.add(cellKey(cell))
  }
  return out
}

/** Pack sources row by row in the given order, closing gaps. */
function packed(ids: string[], cols: number): Layout {
  return Object.fromEntries(ids.map((id, n) => [id, { c: n % cols, r: Math.floor(n / cols) }]))
}

const TIDY_BY: Record<string, (a: Source, b: Source) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  type: (a, b) => fileTypeFor(a.kind, a.metadata.extension).localeCompare(fileTypeFor(b.kind, b.metadata.extension)) || a.name.localeCompare(b.name),
  updated: (a, b) => (sourceModified(b)?.getTime() ?? 0) - (sourceModified(a)?.getTime() ?? 0),
}

/** Grid glyph + "used/total" sheets; the tooltip spells it out. */
function SheetsUsed({ used, total, selections }: { used: number; total: number; selections: number }) {
  const sheets = (n: number) => `${n} sheet${n === 1 ? '' : 's'}`
  const tip = used === 0
    ? `${sheets(total)}, none used yet. Open it to choose a sheet and save a selection.`
    : `${used} of ${sheets(total)} used — ${selections} saved selection${selections === 1 ? '' : 's'} (which sheet, header row and columns to read).`
  return (
    <span className={`sheets-used${used === 0 ? ' none' : ''}`} title={tip} aria-label={tip}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M9.5 9.5V20" />
      </svg>
      {used}/{total}
    </span>
  )
}

/** "Today 14:20", "3 Oct 14:20" this year, "3 Oct 2025 14:20" otherwise — short enough for a tile. */
function fmtShort(d: Date) {
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today ${time}`
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
  return `${day} ${time}`
}

export default function Sources() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<Source[]>('/api/sources'), [])
  const templates = useLoad(() => api.get<DataTemplate[]>('/api/templates'), [])
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const [params, setParams] = useSearchParams()
  const openId = params.get('open')
  const open = (id: string | null) => setParams(id ? { open: id } : {})
  const opened = data?.find((s) => s.id === openId)
  const [openTpl, setOpenTpl] = useState<DataTemplate | null>(null)

  /** Template that produces each source's file, by path. */
  const producedBy = useMemo(() => {
    const m = new Map<string, DataTemplate>()
    for (const t of templates.data ?? []) for (const f of t.matches) m.set(f.path, t)
    return m
  }, [templates.data])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My data</h1>
          <p className="sub">Files and pages Flowbook reads from. Content stays where it is — we keep a reference and a fingerprint.</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>+ Add source</button>
      </div>
      <ErrorBox error={error} />
      <div className="data-layout">
        {loading && !data ? <Loading /> : data && data.length === 0 ? (
          <div className="card">
            <Empty title="No sources yet">
              <p>Add an Excel workbook, CSV, PDF, Word, text/Markdown file, or a Confluence page.</p>
              <button className="primary" onClick={() => setAdding(true)}>+ Add your first source</button>
            </Empty>
          </div>
        ) : (
          <SourceCanvas sources={data ?? []} filter={filter} setFilter={setFilter} producedBy={producedBy} onOpen={open}
            onUpdated={(s) => setData((list) => list?.map((x) => (x.id === s.id ? { ...x, ...s } : x)) ?? list)} />
        )}
        <TemplatesRail templates={templates.data} reload={templates.reload} onOpen={setOpenTpl} />
      </div>
      {openId && (
        <Modal title={opened?.name ?? 'Source'} wide onClose={() => open(null)}>
          <SourceDetailView key={openId} id={openId} onRemoved={() => { open(null); reload() }} onChanged={() => { reload(); templates.reload() }} />
        </Modal>
      )}
      {openTpl && <TemplateModal template={openTpl} onClose={() => setOpenTpl(null)} onDeleted={() => { setOpenTpl(null); templates.reload() }} />}
      {adding && <AddSourceModal onClose={() => setAdding(false)} onAdded={(s) => { setAdding(false); reload(); open(s.id) }} />}
    </>
  )
}

function SourceCanvas({ sources, filter, setFilter, producedBy, onOpen, onUpdated }: {
  sources: Source[]; filter: string; setFilter: (f: string) => void; producedBy: Map<string, DataTemplate>
  onOpen: (id: string) => void; onUpdated: (s: Source) => void
}) {
  const toast = useToast()
  const canvasRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(6)
  const [saved, setSaved] = useState(loadPositions)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const justDragged = useRef(false)
  const [checking, setChecking] = useState<Set<string>>(new Set())

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCols(Math.max(1, Math.floor((el.clientWidth - PAD * 2) / CELL_W))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(() => layOut(sources, saved, cols), [sources, saved, cols])
  const commit = (l: Layout) => { setSaved(l); savePositions(l) }
  const q = filter.toLowerCase()
  const matches = (s: Source) => !q || (s.name + s.location).toLowerCase().includes(q)

  const cellAt = (x: number, y: number): Cell => ({
    c: Math.min(cols - 1, Math.max(0, Math.round((x - PAD) / CELL_W))),
    r: Math.max(0, Math.round((y - PAD) / CELL_H)),
  })
  /** Put `id` in `to`; whoever was there takes its old cell. */
  const moveTo = (id: string, to: Cell) => {
    const from = layout[id]
    const other = Object.keys(layout).find((k) => k !== id && cellKey(layout[k]) === cellKey(to))
    commit({ ...layout, [id]: to, ...(other && { [other]: from }) })
  }
  const target = drag && cellAt(PAD + layout[drag.id].c * CELL_W + drag.dx, PAD + layout[drag.id].r * CELL_H + drag.dy)

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as Element).closest('.file-tile-refresh')) return
    const x0 = e.clientX, y0 = e.clientY
    let moved = false, last = { dx: 0, dy: 0 }
    const move = (ev: PointerEvent) => {
      last = { dx: ev.clientX - x0, dy: ev.clientY - y0 }
      if (!moved && Math.hypot(last.dx, last.dy) < 5) return
      moved = true
      setDrag({ id, ...last })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moved) return
      justDragged.current = true
      setTimeout(() => { justDragged.current = false })
      const p = layout[id]
      moveTo(id, cellAt(PAD + p.c * CELL_W + last.dx, PAD + p.r * CELL_H + last.dy))
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const tidy = (by: string) => {
    const ids = by === 'keep'
      ? Object.keys(layout).sort((a, b) => layout[a].r - layout[b].r || layout[a].c - layout[b].c)
      : [...sources].sort(TIDY_BY[by]).map((s) => s.id)
    commit(packed(ids, cols))
  }

  /** Re-read the file (or Confluence page) to pick up its latest modified time and content. */
  const check = async (src: Source) => {
    setChecking((c) => new Set(c).add(src.id))
    try {
      const s = await api.post<Source>(`/api/sources/${src.id}/refresh`)
      onUpdated(s)
      toast(s.status === 'ok' ? `${s.name}: no changes` : `${s.name}: ${s.status_detail ?? s.status}`, s.status === 'missing' || s.status === 'error')
    } catch (e) { toast((e as Error).message, true) } finally {
      setChecking((c) => { const n = new Set(c); n.delete(src.id); return n })
    }
  }

  const cells = Object.values(layout)
  const rows = Math.max(0, ...cells.map((p) => p.r)) + 2  // a spare row to drop into
  const width = Math.max(...cells.map((p) => p.c), cols - 1) + 1

  return (
    <div className="card flush data-canvas-card">
      <div className="canvas-toolbar">
        <input placeholder="Find a source…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a source" />
        <select className="inline-input" value="" onChange={(e) => e.target.value && tidy(e.target.value)} aria-label="Tidy up">
          <option value="">Tidy up…</option>
          <option value="keep">Close gaps</option>
          <option value="name">By name</option>
          <option value="type">By file type</option>
          <option value="updated">By last modified</option>
        </select>
        <span className="spacer" />
        <span className="faint small hide-narrow">Drag to arrange · Alt + arrows to nudge</span>
      </div>
      <div className="data-canvas" ref={canvasRef}>
        <div className="data-canvas-inner" role="list" aria-label="Sources" style={{ height: PAD * 2 + rows * CELL_H, width: PAD * 2 + width * CELL_W }}>
          {target && <div className="drop-ghost" style={{ left: PAD + target.c * CELL_W, top: PAD + target.r * CELL_H, width: CELL_W - 8, height: CELL_H - 8 }} />}
          {sources.map((s) => {
            const p = layout[s.id]
            const modified = sourceModified(s)
            const tpl = producedBy.get(s.location)
            const dragging = drag?.id === s.id
            return (
              <div
                key={s.id}
                role="listitem"
                className={`file-tile${dragging ? ' dragging' : ''}${matches(s) ? '' : ' dimmed'}`}
                style={{ left: PAD + p.c * CELL_W, top: PAD + p.r * CELL_H, width: CELL_W - 8, transform: dragging ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}
                onPointerDown={(e) => startDrag(e, s.id)}
              >
                <button
                  className="file-tile-open"
                  title={`${s.name}\n${s.location}`}
                  onClick={() => { if (!justDragged.current) onOpen(s.id) }}
                  onKeyDown={(e) => {
                    if (!e.altKey) return
                    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
                    if (!d) return
                    e.preventDefault()
                    moveTo(s.id, { c: Math.min(cols - 1, Math.max(0, p.c + d[0])), r: Math.max(0, p.r + d[1]) })
                  }}
                >
                  <span className="file-tile-icon">
                    <FileIcon kind={s.kind} ext={s.metadata.extension} size={46} />
                    {s.status !== 'ok' && <span className={`file-tile-dot ${s.status}`} title={s.status_detail ?? s.status} />}
                    {tpl && <span className="file-tile-tpl" title={`One of the files the recurring template “${tpl.name}” picks from`}>📅</span>}
                  </span>
                  <span className="file-tile-name">{s.name}</span>
                  {s.metadata.sheets
                    ? <SheetsUsed used={s.sheets_used ?? 0} total={s.metadata.sheets.length} selections={s.selection_count ?? 0} />
                    : <span className="faint small">{fileTypeFor(s.kind, s.metadata.extension)}</span>}
                </button>
                <span className="file-tile-time" title={`${s.kind === 'confluence' ? 'Page edited' : 'File modified'}: ${modified ? fmtDate(modified.toISOString()) : 'unknown'}\nLast checked: ${fmtDate(s.updated_at)}`}>
                  {modified ? fmtShort(modified) : '—'}
                </span>
                <button className={`ghost icon file-tile-refresh${checking.has(s.id) ? ' busy' : ''}`} onClick={() => check(s)} disabled={checking.has(s.id)} aria-label={`Check ${s.name} for changes`} title="Check for changes">
                  {checking.has(s.id) ? <Spinner /> : '↻'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AddSourceModal({ onClose, onAdded }: { onClose: () => void; onAdded: (s: Source) => void }) {
  const [tab, setTab] = useState<'file' | 'confluence'>('file')
  const [path, setPath] = useState('')
  const [page, setPage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const s = tab === 'file'
        ? await api.post<Source>('/api/sources', { path })
        : await api.post<Source>('/api/sources/confluence', { page })
      toast(`Added ${s.name}`)
      onAdded(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Add a source" onClose={onClose} wide footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || (tab === 'file' ? !path.trim() : !page.trim())} onClick={submit}>
        {busy ? 'Adding…' : 'Add source'}
      </button>
    </>}>
      <div className="tabs">
        <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>File on this PC / network drive</button>
        <button className={tab === 'confluence' ? 'active' : ''} onClick={() => setTab('confluence')}>Confluence page</button>
      </div>
      <ErrorBox error={error} />
      {tab === 'file' ? (
        <div className="stack">
          <Field label="File path" help="Paste a full path (Shift + right-click a file in Explorer → “Copy as path”), or browse below.">
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Documents\Sales Q1.xlsx" autoFocus />
          </Field>
          <FileBrowser onPick={setPath} selected={[path]} />
          <p className="faint small">Supported: .xlsx, .xlsm, .csv, .tsv, .pdf, .docx, .txt, .md. Password-protected files and legacy .xls are not supported.</p>
        </div>
      ) : (
        <div className="stack">
          <Field label="Page URL or ID" help="Use a link containing pageId=… or /pages/<id>/. Set the Confluence address and your token in Settings first.">
            <input value={page} onChange={(e) => setPage(e.target.value)} placeholder="https://confluence.example.com/pages/viewpage.action?pageId=12345" />
          </Field>
        </div>
      )}
    </Modal>
  )
}

// ---------- recurring-file templates: producers of files, kept beside the canvas rather than on it

function TemplatesRail({ templates, reload, onOpen }: { templates: DataTemplate[] | null; reload: () => void; onOpen: (t: DataTemplate) => void }) {
  return (
    <aside className="card flush templates-rail" aria-label="Recurring files">
      <div className="rail-head">
        <h2>Recurring files</h2>
        <button className="ghost icon" onClick={reload} title="Look for new files" aria-label="Look for new files">↻</button>
      </div>
      {!templates ? <div style={{ padding: 12 }}><Loading /></div> : templates.length === 0 ? (
        <p className="faint small" style={{ padding: '4px 14px 14px', margin: 0 }}>
          For files that arrive every day or month with the same columns. Open a spreadsheet, then use <b>📅 Make template</b> on a saved selection; workflows will pick the newest file for you.
        </p>
      ) : (
        <div className="rail-list">
          {templates.map((t) => (
            <button key={t.id} className="rail-item" onClick={() => onOpen(t)}>
              <span className="tpl-icon"><FileIcon ext={t.pattern.match(/\.[a-z0-9]+$/i)?.[0]} kind="excel" size={24} /><span>📅</span></span>
              <span className="rail-item-text">
                <span className="rail-item-name">{t.name}</span>
                <span className="mono faint small ellipsis">{t.pattern}</span>
                <span className="small muted">
                  {t.error ? <span className="badge bad" title={t.error}>folder unreachable</span>
                    : <>{t.matches.length} file{t.matches.length === 1 ? '' : 's'}{t.matches[0] && <> · newest {t.matches[0].label}</>}</>}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

function TemplateModal({ template: t, onClose, onDeleted }: { template: DataTemplate; onClose: () => void; onDeleted: () => void }) {
  const toast = useToast()
  const remove = async () => {
    if (!confirm(`Delete data template "${t.name}"? The files themselves are not touched. Workflows using it will ask for data again.`)) return
    await api.del(`/api/templates/${t.id}`)
    toast('Template deleted')
    onDeleted()
  }
  return (
    <Modal title={t.name} wide onClose={onClose} footer={<>
      <button className="danger" onClick={remove}>Delete template</button>
      <span className="spacer" />
      <button onClick={onClose}>Close</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>Workflows using this template read the newest matching file, or one you pick when running.</p>
      <dl className="kv">
        <dt>Folder</dt><dd className="mono small break">{t.folder}</dd>
        <dt>Name pattern</dt><dd className="mono small">{t.pattern} <span className="faint">({t.format})</span></dd>
        <dt>Reads</dt><dd>sheet {t.sheet === '(csv)' ? 'CSV' : <b>{t.sheet}</b>} · headers on row <b>{t.header_row}</b> · {t.schema?.length ?? 0} columns</dd>
      </dl>
      <ErrorBox error={t.error} />
      {t.matches.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 340, marginTop: 12 }}>
          <table>
            <thead><tr><th>File</th><th>For</th><th>Modified</th><th>Size</th></tr></thead>
            <tbody>
              {t.matches.map((m, i) => (
                <tr key={m.path}>
                  <td><span className="mono small">{m.filename}</span> {i === 0 && <span className="badge info">newest</span>}</td>
                  <td className="nowrap">{m.label}</td>
                  <td className="nowrap small muted">{fmtDate(new Date(m.modified * 1000).toISOString())}</td>
                  <td className="nowrap small muted">{fmtBytes(m.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
