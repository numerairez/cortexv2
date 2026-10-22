import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, uploadFile } from '../api'
import { DropZone, type UploadResult } from '../components/AddData'
import { FileIcon, OP_COLOR, OpIcon } from '../components/Icons'
import { OP_LABEL } from '../components/StepEditor'
import { Empty, ErrorBox, Loading, Spinner, StatusBadge, fmtDate, useLoad, useToast } from '../components/ui'

interface WorkflowSummary {
  id: string; name: string; description: string; updated_at: string; latest_version: number; origin: string
  inputs: string[]; ops: string[]
  last_run: { id: string; status: string; at: string; rows?: number } | null
}

export default function Workflows() {
  const { data, error, loading, reload } = useLoad(() => api.get<WorkflowSummary[]>('/api/recipes'), [])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const toast = useToast()

  // Dropping a file here starts a new workflow with that file already added.
  const startWithFiles = async (files: File[]) => {
    const f = files[0]
    if (/\.(xlsb|xls|bas|cls)$/i.test(f.name)) { nav('/workflows/from-macro', { state: { file: f } }); return }
    setBusy(true)
    try {
      const r = await uploadFile<UploadResult>(f)
      if (!r.source || !['excel', 'csv'].includes(r.source.kind)) throw new Error('Workflows start from Excel or CSV files.')
      nav(`/workflows/new?source=${r.source.id}`)
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  const remove = async (w: WorkflowSummary) => {
    if (!confirm(`Delete workflow "${w.name}"? Past runs and output files are kept.`)) return
    await api.del(`/api/recipes/${w.id}`)
    reload()
  }

  const shown = (data ?? []).filter((w) => !filter || `${w.name} ${w.description}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflows</h1>
          <p className="sub">Repeatable recipes that turn your spreadsheets into clean, combined, summarised tables — built visually, run on this PC.</p>
        </div>
      </div>

      <div className="start-grid">
        <DropZone onFiles={startWithFiles} className="start-tile primary-tile" accept=".xlsx,.xlsm,.csv,.tsv">
          {busy ? <><Spinner /> Opening…</> : <>
            <div className="row" style={{ gap: 6 }}><FileIcon kind="excel" size={34} /><FileIcon kind="csv" size={34} /></div>
            <h2>Start a new workflow</h2>
            <p>Drop an Excel or CSV file here, or click to choose one.</p>
            <Link className="btn primary" to="/workflows/new" onClick={(e) => e.stopPropagation()}>Start with a blank workflow</Link>
          </>}
        </DropZone>
        <Link to="/workflows/from-macro" className="start-tile">
          <div className="macro-badge"><FileIcon kind="excel" size={34} /><span>VBA</span></div>
          <h2>Turn an Excel macro into a workflow</h2>
          <p>We read the macro (never run it), find every file and sheet it uses, and your AI chatbot translates it into steps you can see and check.</p>
          <span className="btn">Import a macro →</span>
        </Link>
      </div>

      <div className="row between" style={{ margin: '28px 0 12px' }}>
        <h2 style={{ margin: 0 }}>Your workflows</h2>
        {(data?.length ?? 0) > 4 && <input style={{ maxWidth: 280 }} placeholder="Search workflows…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : shown.length === 0 ? (
        <div className="card"><Empty title={data?.length ? 'No matches' : 'No saved workflows yet'}>
          {!data?.length && <p>Build one above and press <b>Save</b> — next month, just connect the new files and run it again.</p>}
        </Empty></div>
      ) : (
        <div className="wf-grid">
          {shown.map((w) => (
            <div key={w.id} className="card wf-card">
              <Link to={`/workflows/${w.id}`} className="wf-flow" aria-label={`Open ${w.name}`}>
                {w.inputs.map((r) => <span key={r} className="wf-input" title={r}><FileIcon kind="excel" size={18} /></span>)}
                <span className="wf-line" />
                {w.ops.slice(0, 8).map((op, i) => (
                  <span key={i} className="wf-dot" style={{ background: OP_COLOR[op] }} title={OP_LABEL[op]}><OpIcon op={op} size={12} color="#fff" /></span>
                ))}
                {w.ops.length > 8 && <span className="faint small">+{w.ops.length - 8}</span>}
                <span className="wf-dot" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={12} color="#fff" /></span>
              </Link>
              <div>
                <Link to={`/workflows/${w.id}`} className="wf-title">{w.name}</Link>
                {w.origin === 'ai' && <span className="badge info" style={{ marginLeft: 6 }}>from AI</span>}
                {w.description && <p className="muted small" style={{ margin: '2px 0 0' }}>{w.description}</p>}
              </div>
              <div className="faint small">
                {w.inputs.length} input{w.inputs.length === 1 ? '' : 's'} · {w.ops.length} step{w.ops.length === 1 ? '' : 's'} · v{w.latest_version}
                {w.last_run ? <> · last run {fmtDate(w.last_run.at)} <StatusBadge status={w.last_run.status} /></> : ' · never run'}
              </div>
              <div className="row">
                <Link className="btn primary sm" to={`/workflows/${w.id}`}>Open</Link>
                {w.last_run && <Link className="btn sm" to={`/runs/${w.last_run.id}`}>Last result</Link>}
                <span className="spacer" />
                <button className="sm ghost danger" onClick={() => remove(w)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 28 }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>Other tools</h3>
            <p className="muted small" style={{ margin: 0 }}>Build cited knowledge bases from documents and Confluence pages with your approved AI chatbot.</p>
          </div>
          <div className="row">
            <Link className="btn sm" to="/contexts">Context collections</Link>
            <Link className="btn sm" to="/services/knowledge_base">Knowledge base</Link>
          </div>
        </div>
      </div>
    </>
  )
}
