import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { Settings } from '../types'
import { FolderPicker } from './FolderPicker'
import { FileIcon, OP_COLOR, OpIcon } from './Icons'

const TOUR_EVENT = 'flowbook:tour'
/** Open the welcome tour again (from About); it then ends without the save-folder question. */
export const showTour = () => window.dispatchEvent(new Event(TOUR_EVENT))

/** Listens for showTour(); the first launch opens the tour on its own. */
export function useTourRequests(open: () => void) {
  useEffect(() => {
    window.addEventListener(TOUR_EVENT, open)
    return () => window.removeEventListener(TOUR_EVENT, open)
  }, [open])
}

// ---------------------------------------------------------------- scenes
// Small looping animations, one per slide. Every element's resting style is its finished state and
// the keyframes animate towards it, so with reduced motion each scene simply shows the end result.

const Chip = ({ ext, label, className = '' }: { ext: string; label: string; className?: string }) => (
  <span className={`tour-chip ${className}`}><FileIcon ext={`.${ext}`} size={18} /><span>{label}</span></span>
)
const Node = ({ op, className = '' }: { op: string; className?: string }) => (
  <span className={`op-dot ${className}`} style={{ background: OP_COLOR[op] }}><OpIcon op={op} size={15} color="#fff" /></span>
)
const MiniTable = ({ rows = 4, className = '' }: { rows?: number; className?: string }) => (
  <span className={`tour-table ${className}`}>{Array.from({ length: rows }, (_, i) => <span key={i} />)}</span>
)

function HelloScene() {
  return (
    <div className="tour-scene tour-hello">
      <div className="tour-col">
        <Chip ext="xlsx" label="risks.xlsx" className="t-in d1" />
        <Chip ext="csv" label="positions.csv" className="t-in d2" />
        <Chip ext="xlsx" label="market_value.xlsx" className="t-in d3" />
      </div>
      <span className="tour-wire" />
      <img src="/logo.svg" alt="" width="40" height="40" className="tour-logo" />
      <span className="tour-wire d2" />
      <span className="tour-result"><MiniTable /><span className="tour-check">✓</span></span>
    </div>
  )
}

function DataScene() {
  return (
    <div className="tour-scene tour-data">
      <Chip ext="xlsx" label="risks.xlsx" className="t-drop" />
      <div className="tour-sheet">
        {['title', 'blank', 'header', 'row', 'row', 'row'].map((k, i) => (
          <div key={i} className={`tour-row r-${k}`}><b>{i + 1}</b><span /><span /><span /></div>
        ))}
      </div>
      <span className="tour-tag">Headers on row 3</span>
    </div>
  )
}

function StepsScene() {
  const steps: [string, string][] = [['filter_rows', 'Filter'], ['join', 'Join'], ['derive_column', 'Calculate'], ['group_aggregate', 'Summarise']]
  return (
    <div className="tour-scene tour-steps">
      {steps.map(([op, label], i) => (
        <span key={op} className="tour-step" style={{ ['--i' as string]: i }}>
          {i > 0 && <span className="tour-link" />}
          <span className="tour-node"><Node op={op} /><span className="faint">{label}</span></span>
        </span>
      ))}
      <MiniTable rows={3} className="tour-preview" />
    </div>
  )
}

function RerunScene() {
  return (
    <div className="tour-scene tour-rerun">
      <span className="tour-swap">
        <Chip ext="xlsx" label="positions_2026_01.xlsx" className="s-old" />
        <Chip ext="xlsx" label="positions_2026_02.xlsx" className="s-new" />
      </span>
      <span className="tour-run">▶ Run</span>
      <span className="tour-result"><MiniTable /><span className="tour-check">✓</span></span>
    </div>
  )
}

function MacroScene() {
  return (
    <div className="tour-scene tour-macro">
      <pre className="tour-code">
        <span>Sub RiskReport()</span>
        <span>  Range("A5").Select</span>
        <span>  For Each p In Positions</span>
        <span>End Sub</span>
      </pre>
      <span className="tour-arrow">→</span>
      <span className="tour-blocks">
        <span style={{ background: OP_COLOR.filter_rows }}>Filter rows</span>
        <span style={{ background: OP_COLOR.join }}>Join</span>
        <span style={{ background: OP_COLOR.group_aggregate }}>Summarise</span>
      </span>
    </div>
  )
}

function DashboardScene() {
  return (
    <div className="tour-scene tour-dash">
      <span className="tour-kpi"><span className="faint">Market value</span><b>4.8M</b></span>
      <span className="tour-bars">
        {[55, 80, 40, 95, 65].map((h, i) => <span key={i} className={i === 3 ? 'picked' : ''} style={{ height: `${h}%`, ['--i' as string]: i }} />)}
        <span className="tour-tap" />
      </span>
    </div>
  )
}

const FolderGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="var(--warn)" opacity=".85" /></svg>
)

function FolderScene() {
  // [depth, kind, name]: the save folder as it looks after a few saves and a run.
  const rows: [number, 'folder' | string, string][] = [
    [0, 'folder', 'Flowbook'],
    [1, 'folder', 'Workflows'],
    [2, '.json', 'Risk summary.json'],
    [1, 'folder', 'Dashboards'],
    [2, '.json', 'Positions overview.json'],
    [1, '.xlsx', 'Market value 2026-10-27.xlsx'],
  ]
  return (
    <div className="tour-scene tour-folder">
      {rows.map(([depth, kind, name], i) => (
        <span key={name} className={`tour-tree-row${kind === '.json' ? ' copy' : ''}`} style={{ ['--i' as string]: i, paddingLeft: depth * 18 }}>
          {kind === 'folder' ? <FolderGlyph /> : <FileIcon ext={kind} size={15} />}
          <span>{name}</span>
        </span>
      ))}
    </div>
  )
}

const SLIDES: { title: string; text: string; scene: ReactNode }[] = [
  { title: 'Welcome to Flowbook', text: 'Repeatable spreadsheet work, without macros. Here is how it works, in six quick steps.', scene: <HelloScene /> },
  { title: 'Add your data', text: 'Drop in Excel or CSV files. Show Flowbook the header row once and it remembers.', scene: <DataScene /> },
  { title: 'Build it step by step', text: 'Filter, join, calculate and summarise, and see the data after every step.', scene: <StepsScene /> },
  { title: 'Rerun next month', text: 'When the new file arrives, run the same steps on it with one click.', scene: <RerunScene /> },
  { title: 'Bring your macros', text: 'Import an Excel macro. Flowbook reads it, never runs it, and your approved AI chatbot turns it into steps you can check.', scene: <MacroScene /> },
  { title: 'See it on a dashboard', text: 'Charts and headlines from any dataset. Click one to filter the others.', scene: <DashboardScene /> },
  { title: 'Everything in one folder', text: 'Results go to a folder you choose, with a readable copy of each workflow and dashboard to open and check.', scene: <FolderScene /> },
]

// ---------------------------------------------------------------- tour

/** The welcome tour. On first launch (``settings`` given) it ends by asking where results are saved;
 *  opened again from About, it just closes. */
export function Welcome({ settings, onDone }: { settings?: Settings; onDone: () => void }) {
  const [i, setI] = useState(0)
  const [folder, setFolder] = useState(settings ? settings.save_folder || settings.suggested_save_folder : '')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count = SLIDES.length + (settings ? 1 : 0)
  const onFolder = !!settings && i === SLIDES.length

  const finish = useCallback(async (save_folder: string | null) => {
    if (!settings) return onDone()
    setBusy(true)
    setError(null)
    try {
      await api.put<Settings>('/api/settings', { ...(save_folder ? { save_folder } : {}), welcomed: true })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }, [settings, onDone])
  const go = useCallback((n: number) => setI(Math.max(0, Math.min(count - 1, n))), [count])
  const next = useCallback(() => (i === count - 1 ? (settings ? undefined : onDone()) : go(i + 1)), [i, count, settings, onDone, go])
  const skip = useCallback(() => (settings ? go(SLIDES.length) : onDone()), [settings, go, onDone])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (picking || (e.target as HTMLElement).closest?.('input, textarea')) return
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') go(i - 1)
      else if (e.key === 'Escape') skip()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [i, next, go, skip, picking])

  const slide = SLIDES[i]
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-label="Welcome to Flowbook">
      {!onFolder && <button className="link faint small tour-skip" onClick={skip}>{settings ? 'Skip tour' : 'Close'}</button>}
      <div className="welcome-card tour-card">
        {onFolder ? (
          <div key="folder" className="tour-slide">
            <img src="/logo.svg" alt="" width="44" height="44" />
            <h1>One last thing</h1>
            <p className="muted">Where should your files be saved?</p>
            <button className="welcome-folder" onClick={() => setPicking(true)} title="Choose another folder">
              <span aria-hidden>📁</span>
              <span className="mono ellipsis">{folder}</span>
              <span className="welcome-change">Change</span>
            </button>
            {error && <div className="bad-text small">{error}</div>}
            <button className="primary welcome-go" disabled={busy || !folder} onClick={() => finish(folder)}>Start using Flowbook</button>
            <button className="link faint small" disabled={busy} onClick={() => finish(null)}>Skip for now</button>
            <p className="faint small" style={{ margin: 0 }}>Everything stays on this PC. You can change the folder anytime in Settings.</p>
          </div>
        ) : (
          <div key={i} className="tour-slide">
            <div className="tour-stage" aria-hidden>{slide.scene}</div>
            <h1>{slide.title}</h1>
            <p className="muted tour-text">{slide.text}</p>
          </div>
        )}
        <div className="tour-nav">
          <button className="ghost" onClick={() => go(i - 1)} disabled={i === 0} style={{ visibility: i === 0 ? 'hidden' : undefined }}>Back</button>
          <div className="tour-dots" role="tablist" aria-label="Tour steps">
            {Array.from({ length: count }, (_, n) => (
              <button key={n} role="tab" aria-selected={n === i} aria-label={`Step ${n + 1} of ${count}`}
                className={n === i ? 'on' : ''} onClick={() => go(n)} />
            ))}
          </div>
          {onFolder ? <span className="tour-nav-spacer" /> : (
            <button className="primary" onClick={next} autoFocus>{i === count - 1 ? 'Done' : 'Next'}</button>
          )}
        </div>
      </div>
      {picking && <FolderPicker title="Save files to…" start={folder} onClose={() => setPicking(false)}
        onPick={(p) => { setFolder(p); setPicking(false); setError(null) }} />}
    </div>
  )
}
