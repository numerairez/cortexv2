import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { ContextPreview } from '../components/ContextPreview'
import { ErrorBox, Field, Loading, ModeBadge, useLoad } from '../components/ui'
import type { Collection, ContextPreview as Preview, OptionField, Redaction, Run, ServiceDef, Settings } from '../types'

export function OptionsForm({ fields, values, onChange }: {
  fields: OptionField[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void
}) {
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v })
  return (
    <div className="stack">
      {fields.map((f) => {
        const v = values[f.key]
        if (f.type === 'boolean') {
          return (
            <div key={f.key}>
              <label className="check"><input type="checkbox" checked={Boolean(v)} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</label>
              {f.help && <div className="muted small" style={{ marginLeft: 24 }}>{f.help}</div>}
            </div>
          )
        }
        return (
          <Field key={f.key} label={f.label} help={f.help}>
            {f.type === 'select' ? (
              <select value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                {f.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} rows={3} />
            ) : f.type === 'number' ? (
              <input type="number" value={Number(v ?? 0)} onChange={(e) => set(f.key, Number(e.target.value))} />
            ) : (
              <input value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        )
      })}
    </div>
  )
}

export default function ServiceLaunch() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const { data: service, error } = useLoad(() => api.get<ServiceDef>(`/api/services/${id}`), [id])
  const { data: collections } = useLoad(() => api.get<Collection[]>('/api/collections'), [])
  const { data: settings } = useLoad(() => api.get<Settings>('/api/settings'), [])
  const [collectionId, setCollectionId] = useState(params.get('collection') ?? '')
  const [options, setOptions] = useState<Record<string, unknown>>({})
  const [title, setTitle] = useState('')
  const [step, setStep] = useState<1 | 2>(1)
  const [excluded, setExcluded] = useState<string[]>([])
  const [redactions, setRedactions] = useState<Redaction[]>([])
  const [summary, setSummary] = useState<Preview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    if (service) setOptions(Object.fromEntries(service.options.map((o) => [o.key, o.default])))
  }, [service])
  useEffect(() => { setExcluded([]); setConfirmed(false) }, [collectionId])

  if (error) return <ErrorBox error={error} />
  if (!service) return <Loading />
  if (service.builder_route) return <Navigate to={service.builder_route} replace />

  const collection = collections?.find((c) => c.id === collectionId)
  const start = async () => {
    setBusy(true); setStartError(null)
    try {
      const run = await api.post<Run>('/api/runs', {
        service_id: service.id, collection_id: collectionId, options, exclude_anchors: excluded,
        redactions: redactions.filter((r) => r.find.trim()), title: title || `${service.name} – ${collection?.name ?? ''}`,
      })
      nav(`/runs/${run.id}`)
    } catch (e) { setStartError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="crumbs"><Link to="/services">Services</Link> /</div>
      <div className="page-head">
        <div>
          <h1>{service.name}</h1>
          <p className="sub">{service.description}</p>
        </div>
        <ModeBadge mode={service.mode} />
      </div>
      <div className="steps-indicator">
        <div className={`s ${step === 1 ? 'current' : 'done'}`}><span className="n">{step > 1 ? '✓' : 1}</span> Choose & configure</div>
        <span className="sep">›</span>
        <div className={`s ${step === 2 ? 'current' : ''}`}><span className="n">2</span> Review what leaves this PC</div>
        <span className="sep">›</span>
        <div className="s"><span className="n">3</span> Copy prompt & paste reply</div>
      </div>

      {step === 1 && (
        <div className="grid two">
          <div className="card stack">
            <h2>Context collection</h2>
            {collections && collections.length === 0 ? (
              <p className="muted">You have no collections yet. <Link to="/contexts/new">Create one</Link> first.</p>
            ) : (
              <Field label="Use sources from">
                <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                  <option value="">Choose a collection…</option>
                  {collections?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.item_count} items)</option>)}
                </select>
              </Field>
            )}
            <Field label="Run title (optional)"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${service.name} – ${collection?.name ?? '…'}`} /></Field>
          </div>
          <div className="card">
            <h2>Options</h2>
            <OptionsForm fields={service.options} values={options} onChange={setOptions} />
          </div>
          <div style={{ gridColumn: '1 / -1' }} className="row">
            <span className="spacer" />
            <button className="primary" disabled={!collectionId} onClick={() => setStep(2)}>Next: review export →</button>
          </div>
        </div>
      )}

      {step === 2 && collectionId && (
        <div className="stack">
          <div className="alert info">
            Below is <b>everything</b> that will be placed in the prompt for <b>{settings?.chatbot_name ?? 'your approved chatbot'}</b>. Untick passages you should not share, and add redactions for sensitive names or numbers.
          </div>
          <ContextPreview collectionId={collectionId} excluded={excluded} setExcluded={setExcluded} redactions={redactions} setRedactions={setRedactions} onSummary={setSummary} />
          <div className="card">
            <label className="check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I confirm this information may be shared with {settings?.chatbot_name ?? 'the approved company AI chatbot'} under our data policy.
            </label>
            <ErrorBox error={startError} />
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => setStep(1)}>← Back</button>
              <span className="spacer" />
              <button className="primary" disabled={!confirmed || busy || !summary || summary.characters === 0} onClick={start}>
                {busy ? 'Building prompt…' : 'Generate prompt →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
