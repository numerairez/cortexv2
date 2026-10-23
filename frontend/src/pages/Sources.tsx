import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { FileBrowser } from '../components/FileBrowser'
import { Empty, ErrorBox, Field, Loading, Modal, useLoad, useToast } from '../components/ui'
import type { DataTemplate, Source } from '../types'
import { FileIcon, fileTypeFor } from '../components/Icons'
import { SourceDetailView } from './SourceDetail'

const ORDER_KEY = 'flowbook.sourceOrder'

function loadOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') } catch { return [] }
}
function saveOrder(ids: string[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

/** Sources in the user's saved order; ones not placed yet keep the server's order, after the rest. */
function arrange(list: Source[], order: string[]) {
  const rank = new Map(order.map((id, i) => [id, i]))
  return list.map((s, i) => ({ s, r: rank.get(s.id) ?? order.length + i })).sort((a, b) => a.r - b.r).map((x) => x.s)
}

const ARRANGE_BY: Record<string, (a: Source, b: Source) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  type: (a, b) => fileTypeFor(a.kind, a.metadata.extension).localeCompare(fileTypeFor(b.kind, b.metadata.extension)) || a.name.localeCompare(b.name),
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
}

export default function Sources() {
  const { data, error, loading, reload } = useLoad(() => api.get<Source[]>('/api/sources'), [])
  const templates = useLoad(() => api.get<DataTemplate[]>('/api/templates'), [])
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState(loadOrder)
  const [dragId, setDragId] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const openId = params.get('open')
  const open = (id: string | null) => setParams(id ? { open: id } : {})

  const all = useMemo(() => arrange(data ?? [], order), [data, order])
  const shown = all.filter((s) => !filter || (s.name + s.location).toLowerCase().includes(filter.toLowerCase()))
  const opened = all.find((s) => s.id === openId)

  /** Ids with `id` moved to where `targetId` sits now. */
  const reordered = (id: string, targetId: string) => {
    const ids = all.map((s) => s.id).filter((x) => x !== id)
    ids.splice(all.findIndex((s) => s.id === targetId), 0, id)
    return ids
  }
  // Dragging reorders live; the order is saved on drop.
  const dragOnto = (targetId: string) => { if (dragId && dragId !== targetId) setOrder(reordered(dragId, targetId)) }
  const moveBy = (id: string, delta: number) => {
    const target = shown[shown.findIndex((s) => s.id === id) + delta]
    if (target) { const ids = reordered(id, target.id); setOrder(ids); saveOrder(ids) }
  }
  const arrangeBy = (key: string) => {
    const ids = [...all].sort(ARRANGE_BY[key]).map((s) => s.id)
    setOrder(ids); saveOrder(ids)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My data</h1>
          <p className="sub">Files, recurring file templates and pages Flowbook knows about. Content stays where it is; we keep a reference and a fingerprint.</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>+ Add source</button>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && data.length === 0 ? (
        <div className="card">
          <Empty title="No sources yet">
            <p>Add an Excel workbook, CSV, PDF, Word, text/Markdown file, or a Confluence page.</p>
            <button className="primary" onClick={() => setAdding(true)}>+ Add your first source</button>
          </Empty>
        </div>
      ) : (
        <div className="card flush">
          <div className="row" style={{ padding: 10, borderBottom: '1px solid var(--line)', flexWrap: 'nowrap' }}>
            <input placeholder="Filter sources…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter sources" />
            <select className="inline-input" value="" onChange={(e) => e.target.value && arrangeBy(e.target.value)} aria-label="Arrange sources" style={{ width: 'auto' }}>
              <option value="">Arrange by…</option>
              <option value="name">Name</option>
              <option value="type">File type</option>
              <option value="updated">Last updated</option>
            </select>
          </div>
          <div className="file-grid" role="list" aria-label="Sources — drag to rearrange">
            {shown.map((s) => (
              <button
                key={s.id}
                role="listitem"
                className={`file-tile${dragId === s.id ? ' dragging' : ''}`}
                title={`${s.name}\n${s.location}\nDrag to rearrange · Alt + arrow keys to move`}
                draggable
                onClick={() => open(s.id)}
                onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id) }}
                onDragEnter={() => dragOnto(s.id)}
                onDragOver={(e) => { if (dragId) e.preventDefault() }}
                onDrop={(e) => e.preventDefault()}
                onDragEnd={() => { setDragId(null); saveOrder(order) }}
                onKeyDown={(e) => {
                  if (!e.altKey) return
                  const delta = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
                  if (delta) { e.preventDefault(); moveBy(s.id, delta) }
                }}
              >
                <span className="file-tile-icon">
                  <FileIcon kind={s.kind} ext={s.metadata.extension} size={46} />
                  {s.status !== 'ok' && <span className={`file-tile-dot ${s.status}`} title={s.status_detail ?? s.status} />}
                </span>
                <span className="file-tile-name">{s.name}</span>
                <span className="faint small">
                  {s.metadata.sheets ? `${s.metadata.sheets.length} sheet${s.metadata.sheets.length === 1 ? '' : 's'}` : fileTypeFor(s.kind, s.metadata.extension)}
                  {!!s.selection_count && ` · ${s.selection_count} sel.`}
                </span>
              </button>
            ))}
            {shown.length === 0 && <p className="faint" style={{ gridColumn: '1 / -1' }}>Nothing matches “{filter}”.</p>}
          </div>
        </div>
      )}
      <TemplatesCard templates={templates.data} reload={templates.reload} />
      {openId && (
        <Modal title={opened?.name ?? 'Source'} wide onClose={() => open(null)}>
          <SourceDetailView key={openId} id={openId} onRemoved={() => { open(null); reload() }} onChanged={() => { reload(); templates.reload() }} />
        </Modal>
      )}
      {adding && <AddSourceModal onClose={() => setAdding(false)} onAdded={(s) => { setAdding(false); reload(); open(s.id) }} />}
    </>
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

function TemplatesCard({ templates, reload }: { templates: DataTemplate[] | null; reload: () => void }) {
  const toast = useToast()
  if (!templates || templates.length === 0) return null
  const remove = async (t: DataTemplate) => {
    if (!confirm(`Delete data template "${t.name}"? The files themselves are not touched. Workflows using it will ask for data again.`)) return
    await api.del(`/api/templates/${t.id}`)
    toast('Template deleted')
    reload()
  }
  return (
    <div className="card flush" style={{ marginTop: 16 }}>
      <div className="row between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <div>
          <h2 style={{ margin: 0 }}>Data templates</h2>
          <span className="muted small">Recurring files with the same columns and a date in the name. Workflows pick which file to use.</span>
        </div>
        <button className="sm" onClick={reload} title="Look for new files">↻ Refresh</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Template</th><th>Folder · pattern</th><th>Files</th><th>Newest</th><th></th></tr></thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <span className="tpl-icon"><FileIcon ext={t.pattern.match(/\.[a-z0-9]+$/i)?.[0]} kind="excel" size={26} /><span>📅</span></span>
                    <div style={{ marginLeft: 6 }}>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div className="faint small">sheet {t.sheet === '(csv)' ? 'CSV' : t.sheet} · headers on row {t.header_row} · {t.schema?.length ?? 0} columns</div>
                    </div>
                  </div>
                </td>
                <td className="small"><div className="mono break">{t.folder}</div><div className="mono">{t.pattern} <span className="faint">({t.format})</span></div></td>
                <td>{t.error ? <span className="badge bad" title={t.error}>unreachable</span> : t.matches.length}</td>
                <td className="nowrap">{t.matches[0]?.label ?? '—'}</td>
                <td><button className="sm danger" onClick={() => remove(t)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
