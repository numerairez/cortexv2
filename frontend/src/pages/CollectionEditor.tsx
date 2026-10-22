import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { ContextPreview } from '../components/ContextPreview'
import { ErrorBox, Field, KindIcon, Loading, Modal, Spinner, StatusBadge, useLoad, useToast } from '../components/ui'
import type { Collection, Redaction, Selection, SelectionCheck, ServiceDef } from '../types'

interface Item { selection_id: string; included: boolean }

export default function CollectionEditor() {
  const { id } = useParams()
  const isNew = !id
  const nav = useNavigate()
  const toast = useToast()
  const { data: selections } = useLoad(() => api.get<Selection[]>('/api/selections'), [])
  const { data: services } = useLoad(() => api.get<ServiceDef[]>('/api/services'), [])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [removedInfo, setRemovedInfo] = useState<Record<string, string>>({})
  const [loaded, setLoaded] = useState(isNew)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checks, setChecks] = useState<Record<string, SelectionCheck>>({})
  const [checking, setChecking] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [redactions, setRedactions] = useState<Redaction[]>([])

  useEffect(() => {
    if (isNew) return
    api.get<Collection>(`/api/collections/${id}`)
      .then((c) => {
        setName(c.name); setDescription(c.description)
        setItems((c.items ?? []).map((i) => ({ selection_id: i.selection_id, included: i.included })))
        setRemovedInfo(Object.fromEntries((c.items ?? []).filter((i) => i.removed).map((i) => [i.selection_id, i.label])))
        setLoaded(true)
      })
      .catch((e: Error) => setError(e.message))
  }, [id, isNew])

  const byId = useMemo(() => Object.fromEntries((selections ?? []).map((s) => [s.id, s])), [selections])
  const available = (selections ?? []).filter((s) => !items.some((i) => i.selection_id === s.id))
    .filter((s) => !filter || `${s.label} ${s.source_name}`.toLowerCase().includes(filter.toLowerCase()))

  const update = (next: Item[]) => { setItems(next); setDirty(true) }
  const move = (i: number, d: number) => {
    const next = [...items]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    update(next)
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const body = { name, description, items }
      const c = isNew ? await api.post<Collection>('/api/collections', body) : await api.put<Collection>(`/api/collections/${id}`, body)
      setDirty(false)
      toast('Collection saved')
      if (isNew) nav(`/contexts/${c.id}`, { replace: true })
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  const check = async () => {
    setChecking(true)
    try {
      const r = await api.post<{ items: SelectionCheck[]; ok: boolean }>(`/api/collections/${id}/check`)
      setChecks(Object.fromEntries(r.items.map((x) => [x.selection_id, x])))
      toast(r.ok ? 'All sources are readable' : 'Some sources need attention', !r.ok)
    } catch (e) { toast((e as Error).message, true) } finally { setChecking(false) }
  }

  const remove = async () => {
    if (!confirm(`Delete collection "${name}"? Sources and selections are kept.`)) return
    await api.del(`/api/collections/${id}`)
    nav('/contexts')
  }

  if (error && !loaded) return <ErrorBox error={error} />
  if (!loaded || !selections) return <Loading />

  const collectionServices = (services ?? []).filter((s) => s.input_kind === 'collection')

  return (
    <>
      <div className="crumbs"><Link to="/contexts">My Contexts</Link> /</div>
      <div className="page-head">
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1>{isNew ? 'New collection' : name || 'Collection'}</h1>
          <p className="sub">Add selections from your sources, put them in a sensible order, and save.</p>
        </div>
        <div className="row">
          {!isNew && <button onClick={check} disabled={checking || dirty}>{checking ? <Spinner /> : '↻'} Check sources</button>}
          {!isNew && <button onClick={() => setPreviewOpen(true)} disabled={dirty}>Preview export</button>}
          {!isNew && <button className="danger" onClick={remove}>Delete</button>}
          <button className="primary" onClick={save} disabled={saving || !name.trim() || (!dirty && !isNew)}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <div className="grid two">
          <Field label="Name"><input value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} placeholder="e.g. Q1 sales pack" /></Field>
          <Field label="Description (optional)"><input value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true) }} /></Field>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card flush">
          <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
            <h2 style={{ marginBottom: 8 }}>Available selections</h2>
            <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search selections" />
          </div>
          <div style={{ maxHeight: 480, overflow: 'auto' }}>
            {available.length === 0 && (
              <div className="empty small">
                {(selections ?? []).length === 0 ? <>No selections yet. <Link to="/sources">Add a source</Link> and configure a sheet first.</> : 'Everything is already in this collection.'}
              </div>
            )}
            {available.map((s) => (
              <div key={s.id} className="list-item">
                <KindIcon kind={s.source_kind!} ext={s.source_name?.match(/\.[a-z0-9]+$/i)?.[0]} />
                <div className="grow">
                  <div className="ellipsis" style={{ fontWeight: 600 }}>{s.label}</div>
                  <div className="faint small ellipsis">{s.kind === 'sheet' ? `Sheet ${s.config.sheet} · header row ${s.config.header_row}` : s.kind} · {s.source_name}</div>
                </div>
                <button className="sm" onClick={() => update([...items, { selection_id: s.id, included: true }])}>Add →</button>
              </div>
            ))}
          </div>
        </div>
        <div className="card flush">
          <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }} className="row between">
            <h2 style={{ margin: 0 }}>In this collection ({items.length})</h2>
            {dirty && !isNew && <span className="badge warn">Unsaved changes</span>}
          </div>
          {items.length === 0 && <div className="empty small">Add selections from the left.</div>}
          {items.map((it, i) => {
            const s = byId[it.selection_id]
            const c = checks[it.selection_id]
            return (
              <div key={it.selection_id} className="list-item" style={{ opacity: it.included ? 1 : 0.55 }}>
                <span className="badge mono">S{items.slice(0, i + 1).filter((x) => x.included).length}</span>
                <input type="checkbox" checked={it.included} title="Include in exports" aria-label="Include"
                  onChange={() => update(items.map((x, j) => (j === i ? { ...x, included: !x.included } : x)))} />
                <div className="grow">
                  <div className="ellipsis" style={{ fontWeight: 600 }}>{s?.label ?? removedInfo[it.selection_id] ?? 'Removed selection'}</div>
                  <div className="faint small ellipsis">{s ? (s.kind === 'sheet' ? `Sheet ${s.config.sheet} · header row ${s.config.header_row} · ${s.source_name}` : s.source_name) : 'This selection was deleted'}</div>
                  {c && c.status !== 'ok' && <div className="small"><StatusBadge status={c.status} /> <span className="muted">{c.detail}</span></div>}
                </div>
                {c?.status === 'ok' && <StatusBadge status="ok" />}
                <button className="ghost icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="ghost icon" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="ghost icon" onClick={() => update(items.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
              </div>
            )
          })}
        </div>
      </div>

      {!isNew && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Use this collection</h2>
          <div className="row">
            {collectionServices.map((s) => (
              <Link key={s.id} className="btn" to={`/services/${s.id}?collection=${id}`}>{s.name} →</Link>
            ))}
            <Link className="btn" to={`/workflows/new?collection=${id}`}>Build a workflow →</Link>
          </div>
        </div>
      )}

      {previewOpen && id && (
        <Modal title="What would be exported" wide onClose={() => setPreviewOpen(false)} footer={<button onClick={() => setPreviewOpen(false)}>Close</button>}>
          <p className="muted">This is a preview only. Exclusions and redactions made here are for exploring; you choose them again when you run a service.</p>
          <ContextPreview collectionId={id} excluded={excluded} setExcluded={setExcluded} redactions={redactions} setRedactions={setRedactions} />
        </Modal>
      )}
    </>
  )
}
