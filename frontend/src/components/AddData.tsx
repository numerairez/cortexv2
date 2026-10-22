import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, qs, uploadFile } from '../api'
import { useDatasets } from '../datasets'
import type { Selection, SheetPreview, SheetProfile, Source, TemplateSuggestion } from '../types'
import { fmt } from './DataTable'
import { FileBrowser } from './FileBrowser'
import { FileIcon } from './Icons'
import { TemplateOffer, suggestTemplate } from './Templates'
import { ErrorBox, Loading, Modal, Spinner, useToast } from './ui'

export interface UploadResult { path: string; source: Source | null; existing: boolean }

const extOf = (name?: string) => (name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '')

/** A drop target that uploads files. Renders children; highlights while dragging. */
export function DropZone({ onFiles, children, className = '', accept }: {
  onFiles: (files: File[]) => void; children: ReactNode; className?: string; accept?: string
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`dropzone ${className}${over ? ' over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]) }}
      onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return; input.current?.click() }}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click() }}
    >
      <input ref={input} type="file" hidden accept={accept} multiple onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = '' }} />
      {children}
    </div>
  )
}

/** Choose a sheet and its header row for a spreadsheet source, then save it as a selection. */
export function SheetSetup({ source, presetSheet, onDone, onBack }: {
  source: Source; presetSheet?: string; onDone: (s: Selection) => void; onBack?: () => void
}) {
  const sheets = source.metadata.sheets ?? []
  const [sheet, setSheet] = useState(presetSheet && sheets.includes(presetSheet) ? presetSheet : sheets[0])
  const [header, setHeader] = useState<number | null>(null)
  const [preview, setPreview] = useState<SheetPreview | null>(null)
  const [profile, setProfile] = useState<SheetProfile | null>(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setPreview(null); setHeader(null); setProfile(null)
    api.get<SheetPreview>(`/api/sources/${source.id}/preview?${qs({ sheet, rows: 25 })}`)
      .then((p) => { setPreview(p); setHeader(p.suggested_header_row ?? 1) })
      .catch((e: Error) => setError(e.message))
  }, [source.id, sheet])
  useEffect(() => {
    if (!header) return
    const t = setTimeout(() => {
      api.post<SheetProfile>(`/api/sources/${source.id}/profile`, { sheet, header_row: header }).then(setProfile).catch(() => setProfile(null))
    }, 200)
    return () => clearTimeout(t)
  }, [source.id, sheet, header])

  const save = async () => {
    setSaving(true)
    try {
      const name = label.trim() || (sheet === '(csv)' ? source.name.replace(/\.[^.]+$/, '') : `${source.name.replace(/\.[^.]+$/, '')} – ${sheet}`)
      // Reuse an identical selection (same sheet + header row) instead of creating duplicates.
      const existing = (await api.get<Selection[]>(`/api/selections?${qs({ source_id: source.id })}`))
        .find((x) => x.config.sheet === sheet && x.config.header_row === header && !x.config.columns)
      const s = existing
        ? (label.trim() && label.trim() !== existing.label ? await api.put<Selection>(`/api/selections/${existing.id}`, { label: label.trim() }) : existing)
        : await api.post<Selection>('/api/selections', { source_id: source.id, label: name, sheet, header_row: header })
      onDone({ ...s, source_name: source.name, source_kind: source.kind })
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <FileIcon kind={source.kind} ext={extOf(source.name)} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b className="ellipsis">{source.name}</b>
          <div className="faint small">Pick the sheet, then click the row that holds the column headers.</div>
        </div>
        {onBack && <button className="sm" onClick={onBack}>← Back</button>}
      </div>
      {sheets.length > 1 && (
        <div className="chips">
          {sheets.map((s) => (
            <button key={s} className={`sm${s === sheet ? ' primary' : ''}`} onClick={() => setSheet(s)}>{s}</button>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
      {!preview ? <Loading /> : (
        <div className="table-wrap card flush" style={{ maxHeight: 300 }}>
          <table className="sheet">
            <thead><tr><th className="rowhead"></th>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.row} className={r.row === header ? 'header-row' : header && r.row < header ? 'above-header' : ''}>
                  <td className="rowhead" onClick={() => setHeader(r.row)} title={`Headers are on row ${r.row}`}>{r.row}</td>
                  {r.cells.map((c, i) => <td key={i} onClick={() => setHeader(r.row)}>{fmt(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <span className="small">Headers on row</span>
        <input type="number" min={1} className="inline-input" style={{ width: 80 }} value={header ?? ''} onChange={(e) => setHeader(Math.max(1, Number(e.target.value) || 1))} aria-label="Header row" />
        {preview?.suggested_header_row && preview.suggested_header_row === header && <span className="badge ok">suggested</span>}
        <span className="spacer" />
        {profile && <span className="muted small">{profile.row_count.toLocaleString()} rows · {profile.columns.length} columns: {profile.columns.slice(0, 5).map((c) => c.name).join(', ')}{profile.columns.length > 5 ? '…' : ''}</span>}
      </div>
      {profile?.warnings.length ? <div className="alert warn small"><ul>{profile.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input placeholder="Name for this data (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="primary" disabled={!profile || saving} onClick={save}>{saving ? 'Saving…' : 'Use this data'}</button>
      </div>
    </div>
  )
}

/**
 * The single "add data" experience: pick something you already have, or drop / browse a file,
 * then confirm sheet + header row. Calls onPick with a ready-to-use sheet selection.
 */
export function AddDataModal({ onClose, onPick, title = 'Add data', hint, presetSource, presetSheet, exclude = [] }: {
  onClose: () => void; onPick: (s: Selection) => void; title?: string; hint?: string
  presetSource?: Source; presetSheet?: string; exclude?: string[]
}) {
  const [tab, setTab] = useState<'mine' | 'file'>(presetSource || hint ? 'file' : 'mine')
  const { datasets: selections } = useDatasets()
  const [source, setSource] = useState<Source | null>(presetSource ?? null)
  const [offer, setOffer] = useState<{ sel: Selection; suggestion: TemplateSuggestion & { folder: string; formats: string[] } } | null>(null)
  const [checking, setChecking] = useState(false)
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const mine = useMemo(() => (selections ?? []).filter((s) => !exclude.includes(s.id))
    .filter((s) => !filter || `${s.label} ${s.source_name}`.toLowerCase().includes(filter.toLowerCase())), [selections, filter, exclude])

  // After a sheet is set up: if its file is one of a dated series, offer to make a data template.
  const sheetReady = async (sel: Selection) => {
    if (!source) { onPick(sel); return }
    setChecking(true)
    const suggestion = await suggestTemplate(source.location)
    setChecking(false)
    if (suggestion) setOffer({ sel, suggestion })
    else onPick(sel)
  }

  const gotSource = (s: Source) => {
    if (s.kind === 'document' || s.kind === 'confluence') { setError('Workflows need tables: choose an Excel or CSV file.'); return }
    setSource(s)
  }
  const onFiles = async (files: File[]) => {
    setBusy(true); setError(null)
    try {
      const r = await uploadFile<UploadResult>(files[0])
      if (!r.source) throw new Error('This file type cannot be used as data. Choose .xlsx, .xlsm or .csv.')
      if (r.existing) toast('You already added this file; reusing it')
      gotSource(r.source)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const addPath = async (p: string) => {
    setBusy(true); setError(null)
    try {
      gotSource(await api.post<Source>('/api/sources', { path: p }))
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('already registered')) {
        const all = await api.get<Source[]>('/api/sources')
        const norm = p.trim().replace(/^"|"$/g, '')
        const found = all.find((s) => s.location === norm || s.location.toLowerCase() === norm.toLowerCase())
        if (found) { gotSource(found); return }
      }
      setError(msg)
    } finally { setBusy(false) }
  }

  return (
    <Modal title={title} wide onClose={onClose}>
      {hint && <div className="alert info small" style={{ marginBottom: 12 }}>Looking for <b>{hint}</b>. Find it on your PC or shared drive.</div>}
      {offer ? (
        <TemplateOffer selection={offer.sel} suggestion={offer.suggestion} onDone={(ds) => onPick(ds ?? offer.sel)} />
      ) : checking ? <Loading text="Checking for similar files…" /> : source ? (
        <SheetSetup source={source} presetSheet={presetSheet} onDone={sheetReady} onBack={presetSource ? undefined : () => setSource(null)} />
      ) : (
        <>
          <div className="tabs">
            <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>Data you already added</button>
            <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>Add a file</button>
          </div>
          <ErrorBox error={error} />
          {tab === 'mine' ? (
            <div className="stack">
              <input placeholder="Search your data…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
              {!selections ? <Loading /> : mine.length === 0 ? (
                <div className="empty small">Nothing here yet. <a href="#" onClick={(e) => { e.preventDefault(); setTab('file') }}>Add a file</a>.</div>
              ) : (
                <div className="card flush" style={{ maxHeight: 380, overflow: 'auto' }}>
                  {mine.map((s) => (
                    <div key={s.id} className="list-item clickable-row" onClick={() => onPick(s)}>
                      {s.template
                        ? <span className="tpl-icon"><FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={26} /><span>📅</span></span>
                        : <FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={26} />}
                      <div className="grow">
                        <div className="ellipsis" style={{ fontWeight: 600 }}>{s.label} {s.template && <span className="badge info">template</span>}</div>
                        <div className="faint small ellipsis">
                          {s.template
                            ? `${s.template.pattern} · ${s.template.matches.length} file(s)${s.template.matches[0] ? ` · newest ${s.template.matches[0].label}` : ''}`
                            : `${s.source_name} · ${s.config.sheet === '(csv)' ? 'CSV' : `sheet ${s.config.sheet}`} · headers on row ${s.config.header_row} · ${s.schema?.length ?? 0} columns`}
                        </div>
                      </div>
                      <span className="btn sm">Use</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="stack">
              <DropZone onFiles={onFiles} accept=".xlsx,.xlsm,.csv,.tsv">
                {busy ? <><Spinner /> Adding…</> : <>
                  <div className="row" style={{ justifyContent: 'center', gap: 6 }}><FileIcon kind="excel" size={30} /><FileIcon kind="csv" size={30} /></div>
                  <b>Drop an Excel or CSV file here</b>
                  <span className="muted small">or click to choose one · a copy is kept in your Flowbook folder</span>
                </>}
              </DropZone>
              <details>
                <summary className="muted" style={{ cursor: 'pointer' }}>Or use the file where it is (shared drive, OneDrive…) — best for files that arrive every month</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input placeholder="Paste a full path, e.g. S:\Finance\Sales Jan.xlsx" value={path} onChange={(e) => setPath(e.target.value)} />
                    <button className="primary" disabled={!path.trim() || busy} onClick={() => addPath(path)}>Add</button>
                  </div>
                  <FileBrowser onPick={(p) => { setPath(p); addPath(p) }} selected={[path]} />
                </div>
              </details>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
