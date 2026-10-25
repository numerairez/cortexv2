import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, qs } from '../api'
import { TemplatePicker, TemplateThumb } from '../components/dashboard/TemplatePicker'
import { WidgetIcon } from '../components/dashboard/Widgets'
import { TEMPLATES, buildFromTemplate } from '../dashboardTemplates'
import { FileIcon } from '../components/Icons'
import { Empty, ErrorBox, Loading, Modal, Spinner, fmtDate, useLoad, useToast } from '../components/ui'
import { GRID_COLS, toRows, type Dashboard, type DashData, type DashboardSpec } from '../dashboard'
import { useDatasets } from '../datasets'
import type { Selection } from '../types'

const extOf = (name?: string) => name?.match(/\.[a-z0-9]+$/i)?.[0] ?? ''

/** A miniature of the dashboard's layout: each object as a block in its grid position. */
function LayoutThumb({ spec }: { spec: DashboardSpec }) {
  const rows = Math.max(12, ...spec.widgets.map((w) => w.box.y + w.box.h))
  if (!spec.widgets.length) return <div className="thumb empty">Empty</div>
  return (
    <div className="thumb" style={{ aspectRatio: `${GRID_COLS * 2} / ${Math.min(rows, 30)}` }}>
      {spec.widgets.map((w) => (
        <span key={w.id} className={`thumb-box t-${w.type}`} style={{
          left: `${(w.box.x / GRID_COLS) * 100}%`, width: `${(w.box.w / GRID_COLS) * 100}%`,
          top: `${(w.box.y / rows) * 100}%`, height: `${(w.box.h / rows) * 100}%`,
        }}><WidgetIcon w={w} size={14} /></span>
      ))}
    </div>
  )
}

export default function Dashboards() {
  const { data, error, loading, reload } = useLoad(() => api.get<Dashboard[]>('/api/dashboards'), [])
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(params.has('dataset'))
  const [filter, setFilter] = useState('')

  const remove = async (d: Dashboard) => {
    if (!confirm(`Delete dashboard "${d.name}"? The data it uses is not touched.`)) return
    await api.del(`/api/dashboards/${d.id}`)
    reload()
  }
  const shown = (data ?? []).filter((d) => !filter || `${d.name} ${d.description} ${d.dataset_label}`.toLowerCase().includes(filter.toLowerCase()))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p className="sub">Headlines, charts and tables built on your data — static by default, with click-to-filter when you want it.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>+ New dashboard</button>
      </div>
      <ErrorBox error={error} />
      {(data?.length ?? 0) > 6 && <input style={{ maxWidth: 280, marginBottom: 12 }} placeholder="Search dashboards…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {loading && !data ? <Loading /> : !data?.length ? (
        <div className="card dash-hero">
          <div className="dash-hero-art" aria-hidden>
            <span className="t-headline" /><span className="t-headline" /><span className="t-headline" />
            <span className="t-chart wide" /><span className="t-chart" /><span className="t-table full" />
          </div>
          <div>
            <h2>Turn a dataset into a dashboard</h2>
            <p className="muted">Pick any table from your library. Flowbook suggests headlines, charts and a table from its columns, and you rearrange from there. Numbers are recalculated from the file every time it opens.</p>
            <button className="primary" onClick={() => setCreating(true)}>Create your first dashboard</button>
          </div>
        </div>
      ) : shown.length === 0 ? <div className="card"><Empty title="No matches" /></div> : (
        <div className="wf-grid">
          {shown.map((d) => (
            <div key={d.id} className="card wf-card dash-card">
              <Link to={`/dashboards/${d.id}`} aria-label={`Open ${d.name}`}><LayoutThumb spec={d.spec} /></Link>
              <div>
                <Link to={`/dashboards/${d.id}`} className="wf-title">{d.name}</Link>
                {d.description && <p className="muted small" style={{ margin: '2px 0 0' }}>{d.description}</p>}
              </div>
              <div className="faint small row" style={{ gap: 6 }}>
                <FileIcon kind={d.dataset_kind ?? 'excel'} size={14} />
                {d.dataset_label ?? <span className="badge bad">Dataset missing</span>}
                <span>· {d.spec.widgets.length} object{d.spec.widgets.length === 1 ? '' : 's'}</span>
                {d.spec.links.length ? <span className="badge info">Interactive</span> : <span className="badge">Static</span>}
              </div>
              <div className="row">
                <Link className="btn primary sm" to={`/dashboards/${d.id}`}>Open</Link>
                <Link className="btn sm" to={`/dashboards/${d.id}?mode=edit`}>Edit</Link>
                <span className="spacer" />
                <span className="faint small">{fmtDate(d.updated_at)}</span>
                <button className="sm ghost danger" onClick={() => remove(d)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <NewDashboard initial={params.get('dataset')} onClose={() => { setCreating(false); if (params.has('dataset')) setParams({}, { replace: true }) }} />}
    </>
  )
}

function NewDashboard({ initial, onClose }: { initial: string | null; onClose: () => void }) {
  const { datasets } = useDatasets()
  const [picked, setPicked] = useState<string | null>(initial)
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('summary')
  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0]
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const toast = useToast()
  const ds = datasets?.find((d) => d.id === picked)
  const list = useMemo(() => (datasets ?? []).filter((d) => !filter || `${d.label} ${d.source_name}`.toLowerCase().includes(filter.toLowerCase())), [datasets, filter])

  const create = async () => {
    if (!ds) return
    setBusy(true)
    try {
      let spec: DashboardSpec = { widgets: [], links: [] }
      if (template.id !== 'blank') {
        const data = await api.get<DashData>(`/api/dashboards/data?${qs({ dataset: ds.id })}`)
        spec = buildFromTemplate(template, data.columns, toRows(data))
      }
      const d = await api.post<Dashboard>('/api/dashboards', { name: name.trim() || `${ds.label} dashboard`, dataset: ds.id, spec })
      nav(`/dashboards/${d.id}?mode=${template.id === 'blank' ? 'edit' : 'view'}`)
    } catch (e) { toast((e as Error).message, true); setBusy(false) }
  }
  const meta = (s: Selection) => s.produced_by ? `From workflow ${s.produced_by.workflow}`
    : s.template ? `${s.template.matches.length} dated file(s), newest used` : `${s.config.sheet === '(csv)' ? 'CSV' : s.config.sheet} · ${s.schema?.length ?? 0} columns`

  return (
    <Modal title="New dashboard" wide onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" onClick={create} disabled={!ds || busy}>{busy ? <><Spinner /> Building…</> : 'Create dashboard'}</button>
    </>}>
      <div className="new-dash">
        <div>
          <div className="label-sm">1 · Choose the data</div>
          <input placeholder="Search your library…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 8 }} />
          <div className="ds-list" role="listbox" aria-label="Datasets">
            {!datasets ? <Loading /> : list.length === 0 ? (
              <div className="empty small">{filter ? 'No matches.' : <>Your library is empty. <Link to="/sources">Add a file</Link> first.</>}</div>
            ) : list.map((s) => (
              <button key={s.id} role="option" aria-selected={picked === s.id} className={`ds-item${picked === s.id ? ' on' : ''}`} onClick={() => setPicked(s.id)} onDoubleClick={() => { setPicked(s.id); create() }}>
                <FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={26} />
                <span className="grow"><b className="ellipsis">{s.label}</b><span className="faint small ellipsis">{meta(s)}</span></span>
                {picked === s.id && <span className="ds-check" aria-hidden>✓</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="stack">
          <div>
            <div className="label-sm">2 · Name it</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={ds ? `${ds.label} dashboard` : 'Dashboard name'} />
          </div>
          <div className="tpl-chosen">
            <TemplateThumb t={template} />
            <div><b>{template.name}</b><p className="faint small" style={{ margin: 0 }}>{template.description}</p></div>
          </div>
          <p className="faint small">{template.interactive
            ? <>Comes with clicks already connected; change them any time under <b>Interactions</b>.</>
            : <>Starts static: nothing reacts to clicks until you connect objects under <b>Interactions</b>.</>}</p>
        </div>
      </div>
      <div className="label-sm" style={{ marginTop: 16 }}>3 · Start from a layout</div>
      <TemplatePicker value={templateId} onChange={setTemplateId} columns={ds?.schema ?? undefined} />
    </Modal>
  )
}
