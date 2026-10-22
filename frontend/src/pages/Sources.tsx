import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { FileBrowser } from '../components/FileBrowser'
import { Empty, ErrorBox, Field, KindIcon, Loading, Modal, StatusBadge, fmtDate, useLoad, useToast } from '../components/ui'
import type { DataTemplate, Source } from '../types'
import { FileIcon } from '../components/Icons'

export default function Sources() {
  const { data, error, loading, reload } = useLoad(() => api.get<Source[]>('/api/sources'), [])
  const templates = useLoad(() => api.get<DataTemplate[]>('/api/templates'), [])
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const nav = useNavigate()
  const shown = (data ?? []).filter((s) => !filter || (s.name + s.location).toLowerCase().includes(filter.toLowerCase()))

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
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <input placeholder="Filter sources…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter sources" />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Status</th><th>Selections</th><th>Location</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => nav(`/sources/${s.id}`)}>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <KindIcon kind={s.kind} ext={s.metadata.extension} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{s.name}</div>
                          {s.metadata.sheets && <div className="faint small">{s.metadata.sheets.length} sheet(s)</div>}
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={s.status} /></td>
                    <td>{s.selection_count}</td>
                    <td className="mono small break" style={{ maxWidth: 380 }}>{s.location}</td>
                    <td className="nowrap small muted">{fmtDate(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <TemplatesCard templates={templates.data} reload={templates.reload} />
      {adding && <AddSourceModal onClose={() => setAdding(false)} onAdded={(s) => { setAdding(false); reload(); nav(`/sources/${s.id}`) }} />}
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
