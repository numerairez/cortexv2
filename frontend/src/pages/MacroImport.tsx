import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, uploadFile } from '../api'
import { AddDataModal, DropZone, type UploadResult } from '../components/AddData'
import { FileBrowser } from '../components/FileBrowser'
import { FileIcon } from '../components/Icons'
import { ErrorBox, Field, Loading, Spinner, useToast } from '../components/ui'
import { useDatasets } from '../datasets'
import type { Run, Selection, Source } from '../types'
import { roleFrom } from './Studio'

interface Proc { name: string; kind: string; start: number; end: number }
interface Module { name: string; kind: string; code: string; procedures: Proc[] }
interface Dep {
  kind: 'sheet' | 'external_file' | 'dynamic_file' | 'user_picks_file' | 'folder' | 'database' | 'web'
  reference: string; lines: string[]; filename?: string; sheets?: string[]; in_workbook?: boolean; created_by_macro?: boolean; written_by_macro?: boolean
}
interface Analysis {
  workbook: { path: string | null; name: string | null; sheets: string[]; source_id?: string | null }
  modules: Module[]; dependencies: Dep[]; actions: { action: string; lines: string[] }[]
  /** Python: code pulled in from other files, which is not read (one file per workflow). */
  local_imports?: { module: string; lines: string[]; certainly_local: boolean }[]
}
interface DepState { role: string; selectionId?: string; ignored: boolean }

export type CodeLanguage = 'vba' | 'python'

// Everything on this page that differs between an Excel macro and a Python script.
const LANG = {
  vba: {
    noun: 'macro', Noun: 'Macro', badge: 'VBA', service: 'macro_to_workflow', accept: '.xlsm,.xlsb,.xls,.xltm,.xlam,.bas,.cls',
    title: 'Turn an Excel macro into a workflow', fileTab: 'Macro workbook', drop: 'Drop the macro-enabled workbook here',
    dropHint: '.xlsm, .xlsb, .xls — or an exported .bas module · click to choose', pathHint: 'S:\\Finance\\Monthly Report.xlsm',
    pasteHelp: <>In Excel press <b>Alt+F11</b>, open the module, select all (Ctrl+A), copy, and paste it here. Useful when the workbook is protected or the macro lives in your Personal workbook.</>,
    placeholder: 'Sub MonthlyReport()\n    ...\nEnd Sub', unit: 'module', entryLabel: 'Main macro (the one you run)', entryKind: 'sub',
    limit: null,
  },
  python: {
    noun: 'script', Noun: 'Script', badge: 'PY', service: 'python_to_workflow', accept: '.py,.ipynb',
    title: 'Turn a Python script into a workflow', fileTab: 'Script or notebook', drop: 'Drop one Python script or notebook here',
    dropHint: 'One .py or .ipynb file per workflow · click to choose', pathHint: 'S:\\Finance\\monthly_report.py',
    pasteHelp: <>Paste the Python code that prepares the data (pandas, openpyxl, csv…). Only the parts that read and reshape data become workflow steps. <b>Code split across several files?</b> Paste them one after another, the main script last.</>,
    placeholder: 'import pandas as pd\n\ndf = pd.read_excel("sales.xlsx")\n...', unit: 'file', entryLabel: 'Main function (optional)', entryKind: 'function',
    limit: <><b>One file per workflow.</b> Flowbook reads a single script or notebook. Code it imports from your other files
      (like <span className="mono">from helpers import …</span>) is not read. If your code is split across files, choose <b>Paste the code</b> and
      paste them one after another, the main script last.</>,
  },
} as const

const kindText = (noun: string): Record<Dep['kind'], { label: string; help: string }> => ({
  sheet: { label: 'Sheet in this workbook', help: `The ${noun} reads or writes this sheet.` },
  external_file: { label: 'Another file', help: `The ${noun} opens this file by name.` },
  dynamic_file: { label: 'File chosen in code', help: `The file name is built while the ${noun} runs. Pick the file it normally uses.` },
  user_picks_file: { label: 'File the user picks', help: `The ${noun} asks the user to choose a file. Pick the one you normally choose.` },
  folder: { label: 'Folder of files', help: `The ${noun} loops over files in a folder. Add a representative file, or combine them with Append.` },
  database: { label: 'Database', help: 'Databases can’t be read directly yet. Export the data to Excel/CSV and add that file.' },
  web: { label: 'Web address', help: 'Web data can’t be read directly. Save it as Excel/CSV and add that file.' },
})
const depKey = (d: Dep) => `${d.kind}:${d.reference}`

export default function MacroImport({ language = 'vba' }: { language?: CodeLanguage }) {
  const L = LANG[language]
  const KIND_TEXT = kindText(L.noun)
  const location = useLocation()
  const nav = useNavigate()
  const toast = useToast()
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [workbookSource, setWorkbookSource] = useState<Source | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'file' | 'paste'>('file')
  const [path, setPath] = useState('')
  const [pasted, setPasted] = useState('')
  const [included, setIncluded] = useState<Record<string, boolean>>({})
  const [viewing, setViewing] = useState<string | null>(null)
  const [entry, setEntry] = useState('')
  const [deps, setDeps] = useState<Record<string, DepState>>({})
  const [extras, setExtras] = useState<{ role: string; selectionId: string }[]>([])
  const [adding, setAdding] = useState<{ key?: string; hint?: string; presetSource?: Source; presetSheet?: string } | null>(null)
  const [instructions, setInstructions] = useState('')
  const [samples, setSamples] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const { datasets: selections, byId, add: addKnownDataset } = useDatasets()
  const sheetSels = useMemo(() => selections ?? [], [selections])

  // ---------- step 1: get the macro
  const analyse = async (body: { path?: string; code?: string; name?: string }, src: Source | null = null) => {
    setBusy(true); setError(null)
    try {
      const a = await api.post<Analysis>('/api/macros/analyse', { ...body, language })
      setAnalysis(a)
      let wb = src
      if (!wb && a.workbook.source_id) wb = await api.get<Source>(`/api/sources/${a.workbook.source_id}`)
      setWorkbookSource(wb)
      setIncluded(Object.fromEntries(a.modules.map((m) => [m.name, true])))
      setViewing(a.modules[0]?.name ?? null)
      const subs = a.modules.flatMap((m) => m.procedures.filter((p) => p.kind === 'sub' && m.kind === 'standard'))
      // Python scripts often run top to bottom; only preselect a function called main.
      setEntry(language === 'python' ? (a.modules.flatMap((m) => m.procedures).find((p) => p.name === 'main')?.name ?? '') : subs[0]?.name ?? '')
      setStep(2)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const onFiles = async (files: File[]) => {
    if (files.length > 1) {
      setError(`Drop one ${L.noun} at a time: Flowbook reads one file per workflow, and you dropped ${files.length}.`
        + (language === 'python' ? ' If they belong together, choose “Paste the code” and paste them one after another, the main script last.' : ''))
      return
    }
    setBusy(true); setError(null)
    try {
      const r = await uploadFile<UploadResult>(files[0])
      await analyse({ path: r.path }, r.source)
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  useEffect(() => {
    const f = (location.state as { file?: File } | null)?.file
    if (f) onFiles([f])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- step 3: auto-match dependencies to data you already have
  const autoMatch = (a: Analysis, wb: Source | null, sels: Selection[], current: Record<string, DepState>) => {
    const taken: string[] = []
    const out: Record<string, DepState> = {}
    for (const d of a.dependencies) {
      const key = depKey(d)
      const prev = current[key]
      let match: Selection | undefined
      if (d.kind === 'sheet' && wb) match = sels.find((s) => s.source_id === wb.id && s.config.sheet === d.reference)
      if (d.kind === 'external_file' && d.filename) {
        const fname = d.filename.toLowerCase()
        // A data template whose folder holds this exact file name is the better match: next month it moves on.
        match = sels.find((s) => s.template?.matches.some((m) => m.filename.toLowerCase() === fname))
          ?? sels.find((s) => !s.template && s.source_name?.toLowerCase() === fname)
      }
      const role = prev?.role ?? roleFrom(d.kind === 'sheet' ? d.reference : d.filename ?? d.reference, taken)
      taken.push(role)
      const ignoredByDefault = (d.kind === 'sheet' && (d.created_by_macro || d.written_by_macro || d.in_workbook === false))
        || (d.kind === 'external_file' && d.written_by_macro)
      out[key] = { role, selectionId: prev?.selectionId ?? match?.id, ignored: prev?.ignored ?? (ignoredByDefault && !match) }
    }
    return out
  }
  useEffect(() => {
    if (analysis && selections) setDeps((cur) => autoMatch(analysis, workbookSource, sheetSels, cur))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, workbookSource, selections])

  const ensureWorkbookSource = async (): Promise<Source | null> => {
    if (workbookSource) return workbookSource
    if (!analysis?.workbook.path) return null
    try {
      const s = await api.post<Source>('/api/sources', { path: analysis.workbook.path })
      setWorkbookSource(s)
      return s
    } catch (e) {
      toast((e as Error).message, true)
      return null
    }
  }
  const openAdd = async (d: Dep) => {
    if (d.kind === 'sheet' && d.in_workbook) {
      const wb = await ensureWorkbookSource()
      if (wb) { setAdding({ key: depKey(d), presetSource: wb, presetSheet: d.reference }); return }
    }
    setAdding({ key: depKey(d), hint: d.filename ?? (d.kind === 'external_file' ? d.reference : undefined), presetSheet: d.sheets?.[0] })
  }
  const picked = (s: Selection) => {
    addKnownDataset(s)
    if (adding?.key) setDeps({ ...deps, [adding.key]: { ...deps[adding.key], selectionId: s.id, ignored: false } })
    else setExtras([...extras, { role: roleFrom(s.label, [...Object.values(deps).map((d) => d.role), ...extras.map((x) => x.role)]), selectionId: s.id }])
    setAdding(null)
  }

  const modules = analysis?.modules.filter((m) => included[m.name]) ?? []
  const codeChars = modules.reduce((n, m) => n + m.code.length, 0)
  const unresolved = analysis?.dependencies.filter((d) => !deps[depKey(d)]?.ignored && !deps[depKey(d)]?.selectionId) ?? []
  const bindings: Record<string, string> = {
    ...Object.fromEntries((analysis?.dependencies ?? []).map((d) => deps[depKey(d)]).filter((s) => s && !s.ignored && s.selectionId).map((s) => [s!.role, s!.selectionId!])),
    ...Object.fromEntries(extras.map((x) => [x.role, x.selectionId])),
  }

  const generate = async () => {
    setBusy(true); setError(null)
    try {
      const depList = (analysis?.dependencies ?? []).map((d) => {
        const s = deps[depKey(d)]
        return { ...d, role: !s?.ignored && s?.selectionId ? s.role : undefined, ignored: !!s?.ignored }
      })
      const run = await api.post<Run>('/api/runs', {
        service_id: L.service, bindings,
        title: `${L.Noun} → workflow: ${analysis?.workbook.name ?? (entry || 'pasted code')}`,
        options: { macro_name: entry || analysis?.workbook.name || L.Noun, entry, instructions, include_samples: samples,
                   sample_rows: 5, modules: modules.map((m) => ({ name: m.name, code: m.code })), dependencies: depList,
                   actions: analysis?.actions ?? [] },
      })
      nav(`/runs/${run.id}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const stepNames = [`Choose the ${L.noun}`, 'Review the code', 'Connect its data', 'Translate with AI']
  return (
    <>
      <div className="crumbs"><Link to="/">Workflows</Link> /</div>
      <div className="page-head">
        <div>
          <h1>{L.title}</h1>
          <p className="sub">The {L.noun} is only read, never run. Your AI chatbot proposes the steps; the app checks them against your real data.</p>
        </div>
      </div>
      <div className="steps-indicator">
        {stepNames.map((n, i) => (
          <span key={n} style={{ display: 'contents' }}>
            {i > 0 && <span className="sep">›</span>}
            <div className={`s ${step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''}`} style={{ cursor: step > i + 1 ? 'pointer' : undefined }}
              onClick={() => step > i + 1 && setStep((i + 1) as 1 | 2 | 3 | 4)}>
              <span className="n">{step > i + 1 ? '✓' : i + 1}</span> {n}
            </div>
          </span>
        ))}
      </div>
      <ErrorBox error={error} />

      {step === 1 && (
        <div className="card stack">
          {L.limit && <div className="alert info small">{L.limit}</div>}
          <div className="tabs">
            <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>{L.fileTab}</button>
            <button className={tab === 'paste' ? 'active' : ''} onClick={() => setTab('paste')}>Paste the code</button>
          </div>
          {tab === 'file' ? (
            <>
              <DropZone onFiles={onFiles} accept={L.accept}>
                {busy ? <><Spinner /> Reading the {L.noun}…</> : <>
                  <CodeBadge language={language} size={36} />
                  <b>{L.drop}</b>
                  <span className="muted small">{L.dropHint}</span>
                </>}
              </DropZone>
              <details>
                <summary className="muted" style={{ cursor: 'pointer' }}>Or open it from where it is (shared drive…)</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input placeholder={`Full path, e.g. ${L.pathHint}`} value={path} onChange={(e) => setPath(e.target.value)} />
                    <button className="primary" disabled={!path.trim() || busy} onClick={() => analyse({ path: path.trim().replace(/^"|"$/g, '') })}>Read {L.noun}</button>
                  </div>
                  <FileBrowser onPick={(p) => { setPath(p); analyse({ path: p }) }} selected={[path]} />
                </div>
              </details>
            </>
          ) : (
            <>
              <p className="muted small">{L.pasteHelp}</p>
              <textarea className="code" rows={14} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={L.placeholder} />
              <div><button className="primary" disabled={!pasted.trim() || busy} onClick={() => analyse({ code: pasted, name: 'Pasted code' })}>Read {L.noun}</button></div>
            </>
          )}
        </div>
      )}

      {step === 2 && analysis && (
        <div className="stack">
          <div className="grid sidebar-left">
            <div className="card stack">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <CodeBadge language={language} size={26} small />
                <div style={{ minWidth: 0 }}>
                  <b className="ellipsis">{analysis.workbook.name ?? 'Pasted code'}</b>
                  <div className="faint small">{analysis.modules.length} {L.unit}(s) with code</div>
                </div>
              </div>
              <h3 style={{ marginBottom: 0 }}>{L.unit === 'file' ? 'Code to translate' : 'Modules to translate'}</h3>
              {analysis.modules.map((m) => (
                <div key={m.name} className={`module-row${viewing === m.name ? ' active' : ''}`} onClick={() => setViewing(m.name)}>
                  <input type="checkbox" checked={!!included[m.name]} onClick={(e) => e.stopPropagation()} onChange={(e) => setIncluded({ ...included, [m.name]: e.target.checked })} aria-label={`Include ${m.name}`} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="mono small" style={{ fontWeight: 600 }}>{m.name}{m.kind !== 'standard' && <span className="faint"> · sheet/class</span>}</div>
                    <div className="faint small ellipsis">{m.procedures.map((p) => p.name).join(', ')}</div>
                  </div>
                </div>
              ))}
              <Field label={L.entryLabel} help={language === 'python' ? 'Leave empty if the script runs top to bottom.' : 'The AI follows the procedures it calls.'}>
                <select value={entry} onChange={(e) => setEntry(e.target.value)}>
                  <option value="">{language === 'python' ? 'Whole script' : 'Let the AI decide'}</option>
                  {analysis.modules.filter((m) => included[m.name]).flatMap((m) => m.procedures.filter((p) => p.kind === L.entryKind).map((p) => (
                    <option key={`${m.name}.${p.name}`} value={p.name}>{p.name} ({m.name})</option>
                  )))}
                </select>
              </Field>
              {!!analysis.local_imports?.length && (
                <div className="alert warn small">
                  <b>This {L.noun} uses code from other files, which Flowbook doesn’t read:</b>
                  <ul>{analysis.local_imports.map((d) => (
                    <li key={d.module}><span className="mono">{d.module}</span> <span className="faint mono">({d.lines.slice(0, 3).join(', ')})</span>
                      {!d.certainly_local && <span className="faint"> · unless it’s a library</span>}</li>
                  ))}</ul>
                  Steps inside those files won’t be translated. Only one file is read per workflow, so paste the other files in together with this one.
                  <div style={{ marginTop: 6 }}>
                    <button className="sm" onClick={() => {
                      // A slot for each other file above the main script, which stays last.
                      const file = (m: string) => (m.startsWith('.') || m.endsWith('.ipynb') ? m : `${m.replace(/\./g, '/')}.py`)
                      const slots = analysis.local_imports!.map((d) => `# --- paste ${file(d.module)} here\n`).join('\n')
                      setPasted(`${slots}\n# --- ${analysis.workbook.name ?? 'main script'}\n${analysis.modules.map((m) => m.code).join('\n\n')}`)
                      setTab('paste'); setStep(1)
                    }}>
                      Paste them together…
                    </button>
                  </div>
                </div>
              )}
              {analysis.actions.length > 0 && (
                <div className="alert warn small">
                  <b>The {L.noun} also does things a workflow won’t:</b>
                  <ul>{analysis.actions.map((a) => <li key={a.action}>{a.action} <span className="faint mono">({a.lines.slice(0, 3).join(', ')})</span></li>)}</ul>
                  These are listed for the AI and in the result, so nothing is silently dropped.
                </div>
              )}
            </div>
            <div className="card flush" style={{ minWidth: 0 }}>
              {viewing && (() => {
                const m = analysis.modules.find((x) => x.name === viewing)!
                const flagged = new Set(analysis.dependencies.flatMap((d) => d.lines).filter((l) => l.startsWith(`${m.name}:`)).map((l) => Number(l.split(':')[1])))
                return (
                  <>
                    <div className="row between" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                      <b className="mono">{m.name}</b>
                      <span className="faint small">{m.code.split('\n').length} lines · highlighted lines use data</span>
                    </div>
                    <pre className="code-view">{m.code.split('\n').map((ln, i) => (
                      <div key={i} className={flagged.has(i + 1) ? 'hl' : ''}><span className="ln">{i + 1}</span>{ln || ' '}</div>
                    ))}</pre>
                  </>
                )
              })()}
            </div>
          </div>
          <div className="row">
            <button onClick={() => setStep(1)}>← Back</button>
            <span className="spacer" />
            <span className="faint small">{codeChars.toLocaleString()} characters of code selected</span>
            <button className="primary" disabled={modules.length === 0} onClick={() => setStep(3)}>Next: connect its data →</button>
          </div>
        </div>
      )}

      {step === 3 && analysis && (
        <div className="stack">
          <div className="alert info">
            We found <b>{analysis.dependencies.length}</b> data reference(s) in the {L.noun}. Connect each one to a table so the workflow can run without the {L.noun}.
            Anything marked <b>Missing</b> must be added as a source first.
          </div>
          <div className="card flush">
            {analysis.dependencies.length === 0 && <div className="empty small">No file or sheet names were found in the code. Add the data the {L.noun} works on below.</div>}
            {analysis.dependencies.map((d) => {
              const key = depKey(d)
              const st = deps[key]
              if (!st) return null
              const sel = st.selectionId ? byId[st.selectionId] : undefined
              const unsupported = d.kind === 'database' || d.kind === 'web'
              return (
                <div key={key} className={`dep-row${st.ignored ? ' ignored' : ''}`}>
                  <div className="dep-icon">{d.kind === 'sheet' ? <FileIcon kind="excel" size={24} /> : d.kind === 'database' ? '🗄️' : d.kind === 'web' ? '🌐' : d.kind === 'folder' ? '📁' : <FileIcon ext={d.filename ? `.${d.filename.split('.').pop()}` : undefined} kind={d.filename?.match(/\.csv$/i) ? 'csv' : 'excel'} size={24} />}</div>
                  <div className="dep-main">
                    <div><span className="badge">{KIND_TEXT[d.kind].label}</span> <b className="break">{d.reference}</b></div>
                    <div className="faint small">{KIND_TEXT[d.kind].help} Used at <span className="mono">{d.lines.slice(0, 4).join(', ')}{d.lines.length > 4 ? '…' : ''}</span>
                      {d.created_by_macro && ` · the ${L.noun} appears to create this sheet itself`}
                      {d.written_by_macro && (d.kind === 'sheet'
                        ? ` · the ${L.noun} clears this sheet and writes its results here (that is what the workflow will produce)`
                        : ` · the ${L.noun} writes this file itself (likely its output)`)}
                      {d.sheets?.length ? ` · reads sheet${d.sheets.length > 1 ? 's' : ''} ${d.sheets.join(', ')}` : ''}
                      {d.kind === 'sheet' && d.in_workbook === false && !d.created_by_macro && ' · not found in this workbook'}
                    </div>
                  </div>
                  <div className="dep-status">
                    {st.ignored ? <span className="badge">Not needed</span>
                      : sel ? <span className="badge ok" title={sel.source_name}>✓ {sel.label}</span>
                        : <span className="badge bad">Missing</span>}
                  </div>
                  <div className="dep-actions">
                    {!st.ignored && (
                      <>
                        <button className={sel ? 'sm' : 'sm primary'} onClick={() => openAdd(d)}>{sel ? 'Change…' : unsupported ? 'Add exported file…' : d.kind === 'sheet' && d.in_workbook ? 'Set up sheet…' : 'Add this data…'}</button>
                        {sheetSels.length > 0 && (
                          <select className="inline-input sm-select" value={st.selectionId ?? ''} onChange={(e) => setDeps({ ...deps, [key]: { ...st, selectionId: e.target.value || undefined } })} aria-label="Use existing data">
                            <option value="">or pick existing…</option>
                            {sheetSels.map((s) => <option key={s.id} value={s.id}>{s.template ? `📅 ${s.label} (template)` : s.label}</option>)}
                          </select>
                        )}
                      </>
                    )}
                    <button className="sm ghost" onClick={() => setDeps({ ...deps, [key]: { ...st, ignored: !st.ignored } })}>{st.ignored ? 'Needed after all' : 'Not needed'}</button>
                  </div>
                </div>
              )
            })}
            {extras.map((x) => (
              <div key={x.role} className="dep-row">
                <div className="dep-icon"><FileIcon kind={byId[x.selectionId]?.source_kind ?? 'excel'} size={24} /></div>
                <div className="dep-main"><span className="badge">Extra data</span> <b>{byId[x.selectionId]?.label ?? x.role}</b></div>
                <div className="dep-status"><span className="badge ok">✓ added</span></div>
                <div className="dep-actions"><button className="sm ghost" onClick={() => setExtras(extras.filter((e) => e !== x))}>Remove</button></div>
              </div>
            ))}
          </div>
          <div className="row">
            <button onClick={() => setStep(2)}>← Back</button>
            <button onClick={() => setAdding({})}>+ Add other data the {L.noun} uses</button>
            <span className="spacer" />
            {unresolved.length > 0 && <span className="small" style={{ color: 'var(--bad)' }}>{unresolved.length} item(s) still missing</span>}
            <button className="primary" disabled={unresolved.length > 0 || Object.keys(bindings).length === 0} onClick={() => setStep(4)}>Next: translate →</button>
          </div>
        </div>
      )}

      {step === 4 && analysis && (
        <div className="grid two">
          <div className="card stack">
            <h2>What the AI will receive</h2>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>The code of {modules.length} {L.unit}(s) ({codeChars.toLocaleString()} characters){entry && <>, starting from <b className="mono">{entry}</b></>}</li>
              <li>For each connected table: column names, Excel column letters, types and counts{samples ? ', plus 5 sample rows' : ' (no values)'}</li>
              {Object.entries(bindings).map(([r, id]) => <li key={r} className="faint"><span className="mono">{r}</span> → {byId[id]?.label}</li>)}
              <li>The list of workflow operations it may use</li>
            </ul>
            <label className="check"><input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} /> Include a few sample rows (helps the AI, only if policy allows)</label>
            <Field label="Anything the AI should know? (optional)" help="e.g. “Ignore the archive step” or “The result should be one row per branch”.">
              <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </Field>
          </div>
          <div className="card stack">
            <h2>Next</h2>
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>We build a prompt; you copy it into your approved AI chatbot.</li>
              <li>Paste the reply back. The app checks every step against your data.</li>
              <li>Open the result in the Workflow Studio, review each step (they link back to {L.noun} lines), save and run.</li>
            </ol>
            <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm this {L.noun} code and data description may be shared with the approved chatbot.</label>
            <div className="row">
              <button onClick={() => setStep(3)}>← Back</button>
              <span className="spacer" />
              <button className="primary" disabled={!confirmed || busy} onClick={generate}>{busy ? 'Building prompt…' : 'Generate prompt →'}</button>
            </div>
          </div>
        </div>
      )}

      {busy && step !== 1 && step !== 4 && <Loading />}
      {adding && (
        <AddDataModal
          title={adding.key ? `Connect: ${adding.key.split(':').slice(1).join(':')}` : `Add data the ${L.noun} uses`}
          hint={adding.hint} presetSource={adding.presetSource} presetSheet={adding.presetSheet}
          onClose={() => setAdding(null)} onPick={picked}
        />
      )}
    </>
  )
}

/** The file icon with a small language tag, used on the macro and script import tiles. */
export function CodeBadge({ language, size, small }: { language: CodeLanguage; size: number; small?: boolean }) {
  return (
    <div className={`macro-badge${small ? ' sm' : ''}${language === 'python' ? ' python' : ''}`}>
      <FileIcon kind={language === 'python' ? 'code' : 'excel'} ext={language === 'python' ? '.py' : undefined} size={size} />
      <span>{LANG[language].badge}</span>
    </div>
  )
}
