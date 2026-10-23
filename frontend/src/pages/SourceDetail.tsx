import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TemplateOffer, suggestTemplate } from '../components/Templates'
import { api, qs } from '../api'
import { DataTable, fmt } from '../components/DataTable'
import { FileBrowser } from '../components/FileBrowser'
import { ErrorBox, Field, KindIcon, Loading, Modal, Spinner, StatusBadge, fmtBytes, fmtDate, sourceModified, useLoad, useToast } from '../components/ui'
import type { Selection, SelectionCheck, SheetPreview, SheetProfile, Source } from '../types'

export default function SourceDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  return (
    <>
      <div className="crumbs"><Link to="/sources">Sources</Link> /</div>
      <SourceDetailView id={id!} onRemoved={() => nav('/sources')} />
    </>
  )
}

/** A source's details, selections and sheet configurator; used by its own page and the My data pop-up. */
export function SourceDetailView({ id, onRemoved, onChanged, startRelink }: { id: string; onRemoved: () => void; onChanged?: () => void; startRelink?: boolean }) {
  const toast = useToast()
  const { data: src, error, reload, setData } = useLoad(() => api.get<Source>(`/api/sources/${id}`), [id])
  const [busy, setBusy] = useState(false)
  const [relocating, setRelocating] = useState(!!startRelink)
  const [editing, setEditing] = useState<Selection | null>(null)

  if (error) return <ErrorBox error={error} />
  if (!src) return <Loading />

  const refresh = async () => {
    setBusy(true)
    try {
      const s = await api.post<Source>(`/api/sources/${src.id}/refresh`)
      setData({ ...src, ...s })
      onChanged?.()
      toast(s.status === 'ok' ? 'No changes detected' : s.status_detail ?? s.status)
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!confirm(`Remove "${src.name}" and its selections from Flowbook? The file itself is not touched.`)) return
    await api.del(`/api/sources/${src.id}`)
    toast('Source removed')
    onRemoved()
  }
  const tabular = src.kind === 'excel' || src.kind === 'csv'

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <KindIcon kind={src.kind} ext={src.metadata.extension} />
          <div style={{ minWidth: 0 }}>
            <h1>{src.name}</h1>
            <div className="mono small muted break">{src.location}</div>
          </div>
        </div>
        <div className="row">
          <button onClick={refresh} disabled={busy}>{busy ? <Spinner /> : '↻'} Check for changes</button>
          {src.kind !== 'confluence' && src.kind !== 'feed' && <button onClick={() => setRelocating(true)}>{src.is_copy ? 'Re-link to original…' : 'Point to a new file…'}</button>}
          <button className="danger" onClick={remove}>Remove</button>
        </div>
      </div>

      {src.is_copy && (
        <div className="alert warn small row" style={{ marginBottom: 12, flexWrap: 'nowrap' }}>
          <span style={{ flex: 1 }}>
            <b>Not linked to the original file.</b> This is a copy kept in Flowbook because it was dropped in, so edits to the original won’t show up. Point it at the real path to stay in sync; selections are kept.
          </span>
          <button className="sm primary" onClick={() => setRelocating(true)}>Re-link to original…</button>
        </div>
      )}
      <div className="card">
        <dl className="kv">
          <dt>Status</dt><dd><StatusBadge status={src.status} /> {src.status_detail && <span className="muted small">{src.status_detail}</span>}</dd>
          {src.metadata.size !== undefined && <><dt>Size</dt><dd>{fmtBytes(src.metadata.size)}</dd></>}
          {src.metadata.sheets && <><dt>Sheets</dt><dd>{src.metadata.sheets.join(', ')}</dd></>}
          {src.metadata.segments !== undefined && <><dt>Passages</dt><dd>{src.metadata.segments} ({src.metadata.characters?.toLocaleString()} characters)</dd></>}
          {src.metadata.version !== undefined && <><dt>Page version</dt><dd>{src.metadata.version} {src.metadata.space && `· space ${src.metadata.space}`}</dd></>}
          <dt>Fingerprint</dt><dd className="mono small">{src.fingerprint?.slice(0, 24)}</dd>
          {src.metadata.rows !== undefined && <><dt>Rows</dt><dd>{src.metadata.rows.toLocaleString()}</dd></>}
          {sourceModified(src) && <><dt>{src.kind === 'confluence' ? 'Page edited' : src.kind === 'feed' ? 'Last fetched' : 'File modified'}</dt><dd>{fmtDate(sourceModified(src)!.toISOString())}</dd></>}
          <dt>Last checked</dt><dd>{fmtDate(src.updated_at)}</dd>
          <dt>Added</dt><dd>{fmtDate(src.created_at)}</dd>
        </dl>
      </div>

      {tabular && (
        <SheetConfigurator
          key={editing?.id ?? 'new'}
          source={src}
          editing={editing}
          onSaved={() => { setEditing(null); reload(); onChanged?.() }}
          onCancelEdit={() => setEditing(null)}
        />
      )}

      <div className="card">
        <div className="card-head">
          <h2>Saved selections</h2>
          <span className="muted small">Selections are what you add to Context Collections.</span>
        </div>
        {(src.selections ?? []).length === 0 && <p className="faint">None yet{tabular ? ' — configure a sheet above and save it.' : '.'}</p>}
        {(src.selections ?? []).map((s) => (
          <SelectionRow key={s.id} sel={s} source={src} onEdit={tabular ? () => { setEditing(s); document.getElementById('sheet-config')?.scrollIntoView({ behavior: 'smooth' }) } : undefined} onChanged={() => { reload(); onChanged?.() }} />
        ))}
      </div>

      {relocating && (
        <RelocateModal source={src} onClose={() => setRelocating(false)} onDone={(s) => { setRelocating(false); setData({ ...src, ...s }); reload(); onChanged?.() }} />
      )}
    </>
  )
}

function SelectionRow({ sel, source, onEdit, onChanged }: { sel: Selection; source: Source; onEdit?: () => void; onChanged: () => void }) {
  const [check, setCheck] = useState<SelectionCheck | null>(null)
  const [offer, setOffer] = useState<Awaited<ReturnType<typeof suggestTemplate>>>(null)
  const nav = useNavigate()
  const makeTemplate = async () => {
    const sug = await suggestTemplate(source.location)
    if (sug) setOffer(sug)
    else toast('No other files with a date-based name were found next to this file', true)
  }
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const runCheck = async () => {
    setBusy(true)
    try { setCheck(await api.get<SelectionCheck>(`/api/selections/${sel.id}/check`)) } finally { setBusy(false) }
  }
  const accept = async () => {
    await api.put(`/api/selections/${sel.id}`, { accept_schema: true })
    toast('Saved the new column layout')
    setCheck(null)
    onChanged()
  }
  const remove = async () => {
    if (!confirm(`Delete selection "${sel.label}"? Collections using it will report it as removed.`)) return
    await api.del(`/api/selections/${sel.id}`)
    onChanged()
  }
  return (
    <div className="list-item" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{sel.label}</div>
        <div className="muted small">
          {sel.kind === 'sheet'
            ? <>Sheet <b>{sel.config.sheet === '(csv)' ? 'CSV' : sel.config.sheet}</b> · header on row <b>{sel.config.header_row}</b> · {sel.config.columns?.length ?? sel.schema?.length ?? 0} columns</>
            : sel.kind === 'page' ? 'Whole Confluence page' : 'Whole document'}
        </div>
        {check && (
          <div style={{ marginTop: 6 }}>
            <StatusBadge status={check.status} /> <span className="small muted">{check.detail}</span>
            {check.drift && (
              <div className="alert warn small" style={{ marginTop: 6 }}>
                {check.drift.missing.length > 0 && <div>Missing columns: {check.drift.missing.join(', ')}</div>}
                {check.drift.added.length > 0 && <div>New columns: {check.drift.added.join(', ')}</div>}
                {check.drift.type_changes.map((t) => <div key={t.name}>“{t.name}” was {t.was}, now {t.now}</div>)}
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="sm" onClick={accept}>Accept new layout</button>
                  {onEdit && <button className="sm" onClick={onEdit}>Change header row…</button>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {sel.kind === 'sheet' && <button className="sm" onClick={makeTemplate} title="Use this file as a template for its monthly/daily siblings">📅 Make template</button>}
      {sel.kind === 'sheet' && <button className="sm" onClick={runCheck} disabled={busy}>{busy ? <Spinner /> : 'Check'}</button>}
      {offer && (
        <Modal title="Data template" wide onClose={() => setOffer(null)}>
          <TemplateOffer selection={{ ...sel, source_kind: source.kind }} suggestion={offer}
            onDone={(ds) => { setOffer(null); if (ds) { toast(`Template “${ds.label}” created`); onChanged(); nav('/sources') } }} />
        </Modal>
      )}
      {onEdit && <button className="sm" onClick={onEdit}>Edit</button>}
      <button className="sm danger" onClick={remove}>Delete</button>
    </div>
  )
}

function SheetConfigurator({ source, editing, onSaved, onCancelEdit }: {
  source: Source; editing: Selection | null; onSaved: () => void; onCancelEdit: () => void
}) {
  const sheets = source.metadata.sheets ?? []
  const [sheet, setSheet] = useState(editing?.config.sheet ?? sheets[0])
  const [rows, setRows] = useState(40)
  const [header, setHeader] = useState<number | null>(editing?.config.header_row ?? null)
  const [preview, setPreview] = useState<SheetPreview | null>(null)
  const [profile, setProfile] = useState<SheetProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [cols, setCols] = useState<string[] | null>(editing?.config.columns ?? null)
  const [label, setLabel] = useState(editing?.label ?? '')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (!sheet) return
    setError(null)
    api.get<SheetPreview>(`/api/sources/${source.id}/preview?${qs({ sheet, rows })}`)
      .then((p) => {
        setPreview(p)
        setHeader((h) => h ?? p.suggested_header_row ?? 1)
      })
      .catch((e: Error) => setError(e.message))
  }, [source.id, sheet, rows])

  useEffect(() => {
    if (!sheet || !header) return
    setProfileError(null)
    const t = setTimeout(() => {
      api.post<SheetProfile>(`/api/sources/${source.id}/profile`, { sheet, header_row: header })
        .then(setProfile)
        .catch((e: Error) => { setProfile(null); setProfileError(e.message) })
    }, 250)
    return () => clearTimeout(t)
  }, [source.id, sheet, header])

  const allCols = useMemo(() => profile?.columns.map((c) => c.name) ?? [], [profile])
  const chosen = cols ?? allCols

  const toggleCol = (c: string) => {
    const base = cols ?? allCols
    setCols(base.includes(c) ? base.filter((x) => x !== c) : allCols.filter((x) => x === c || base.includes(x)))
  }

  const save = async () => {
    if (!sheet || !header) return
    setSaving(true)
    const columns = cols && cols.length !== allCols.length ? cols : null
    const sheetName = sheet === '(csv)' ? source.name : sheet
    const body = { label: label.trim() || `${source.name} – ${sheetName}`, sheet, header_row: header, columns }
    try {
      if (editing) await api.put(`/api/selections/${editing.id}`, { ...body, columns: columns ?? [] })
      else await api.post('/api/selections', { ...body, source_id: source.id })
      toast(editing ? 'Selection updated' : 'Selection saved')
      onSaved()
    } catch (e) {
      toast((e as Error).message, true)
    } finally { setSaving(false) }
  }

  return (
    <div className="card" id="sheet-config">
      <div className="card-head">
        <h2>{editing ? `Edit selection: ${editing.label}` : 'Configure a sheet'}</h2>
        {editing && <button className="sm" onClick={onCancelEdit}>Cancel edit</button>}
      </div>
      {sheets.length > 1 && (
        <div className="tabs">
          {sheets.map((s) => (
            <button key={s} className={s === sheet ? 'active' : ''} onClick={() => { setSheet(s); setHeader(null); setCols(null); setPreview(null); setProfile(null) }}>{s}</button>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="grid sidebar-right">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="muted small">Click a row number to mark it as the <b>header row</b>. Rows above it are ignored.</span>
            <span className="spacer" />
            <select className="inline-input" value={rows} onChange={(e) => setRows(Number(e.target.value))} aria-label="Rows to preview">
              {[20, 40, 100, 200].map((n) => <option key={n} value={n}>First {n} rows</option>)}
            </select>
          </div>
          {!preview ? <Loading /> : (
            <div className="table-wrap card flush" style={{ maxHeight: 460 }}>
              <table className="sheet">
                <thead>
                  <tr><th className="rowhead"></th>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className={r.row === header ? 'header-row' : header && r.row < header ? 'above-header' : ''}>
                      <td className="rowhead" onClick={() => { setHeader(r.row); setCols(null) }} title={`Use row ${r.row} as header`}>{r.row}</td>
                      {r.cells.map((c, i) => <td key={i} title={c === null ? '' : String(c)}>{fmt(c)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="stack">
          <Field label="Header row (Excel row number)" help={preview?.suggested_header_row ? <>Suggested: row {preview.suggested_header_row}{preview.suggested_header_row !== header && <> · <a href="#" onClick={(e) => { e.preventDefault(); setHeader(preview.suggested_header_row); setCols(null) }}>use it</a></>}</> : undefined}>
            <input type="number" min={1} value={header ?? ''} onChange={(e) => { setHeader(Math.max(1, Number(e.target.value) || 1)); setCols(null) }} />
          </Field>
          <Field label="Selection name">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${source.name} – ${sheet === '(csv)' ? 'data' : sheet}`} />
          </Field>
          <ErrorBox error={profileError} />
          {profile && (
            <>
              <div className="muted small">{profile.row_count.toLocaleString()} data rows · {profile.columns.length} columns · {chosen.length} selected</div>
              {profile.warnings.length > 0 && <div className="alert warn small"><ul>{profile.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
              <button className="primary" onClick={save} disabled={saving || chosen.length === 0}>{saving ? 'Saving…' : editing ? 'Update selection' : 'Save selection'}</button>
            </>
          )}
        </div>
      </div>
      {profile && (
        <>
          <hr />
          <h3>Detected columns</h3>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table>
              <thead><tr><th style={{ width: 40 }}>Use</th><th>Column</th><th>Type</th><th>Filled</th><th>Blank</th><th>Distinct</th><th>Examples</th></tr></thead>
              <tbody>
                {profile.columns.map((c) => (
                  <tr key={c.name}>
                    <td><input type="checkbox" checked={chosen.includes(c.name)} onChange={() => toggleCol(c.name)} aria-label={`Use ${c.name}`} /></td>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td><span className="badge">{c.type}</span></td>
                    <td>{c.non_null.toLocaleString()}</td>
                    <td className={c.nulls ? '' : 'faint'}>{c.nulls.toLocaleString()}</td>
                    <td>{c.distinct.toLocaleString()}</td>
                    <td className="small muted ellipsis" style={{ maxWidth: 280 }}>{c.samples.map(String).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 style={{ marginTop: 16 }}>First rows as they will be read</h3>
          <DataTable columns={profile.sample.columns} rows={profile.sample.rows} firstRowNumber={profile.header_row + 1} maxHeight={260} />
        </>
      )}
    </div>
  )
}

function RelocateModal({ source, onClose, onDone }: { source: Source; onClose: () => void; onDone: (s: Source) => void }) {
  const relink = !!source.is_copy
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const copyName = source.location.split(/[\\/]/).pop() ?? source.name
  const picked = path.trim().replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? ''
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const s = await api.post<Source>(`/api/sources/${source.id}/relocate`, { path })
      toast(relink ? 'Linked to the original file. Changes to it will now show up here.' : 'Source now points to the new file. Check saved selections for column changes.')
      onDone(s)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title={relink ? 'Re-link to the original file' : 'Point to a new file'} onClose={onClose} wide footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!path || busy} onClick={submit}>{relink ? 'Link this file' : 'Use this file'}</button>
    </>}>
      {relink
        ? <p className="muted">Flowbook is reading a copy of <b>{copyName}</b> that was dropped in. Find the real file on your PC or shared drive so Flowbook reads it from there and sees future edits. Selections, collections and workflows keep working if the columns still match.</p>
        : <p className="muted">Use this for recurring files, e.g. next month’s workbook. Selections, collections, and recipes keep working if the columns still match.</p>}
      <ErrorBox error={error} />
      <div className="stack">
        <Field label={relink ? 'Original file path' : 'New file path'} help={relink ? 'Paste a full path (Shift + right-click the file in Explorer → “Copy as path”), or browse below.' : undefined}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={relink ? `e.g. S:\\Finance\\${copyName}` : undefined} autoFocus={relink} />
        </Field>
        {relink && picked && picked.toLowerCase() !== copyName.toLowerCase() && (
          <div className="alert warn small">The chosen file is called <b>{picked}</b>, not <b>{copyName}</b>. That’s fine if it was renamed; just make sure it’s the same data.</div>
        )}
        <FileBrowser onPick={setPath} selected={[path]} />
      </div>
    </Modal>
  )
}
