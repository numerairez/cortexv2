import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Source, SourceKind } from '../types'
import { FileIcon } from './Icons'

// ---------- toasts
// A toast raised by a button click appears just below that button; anything else (shortcuts, drops,
// background work, or a button that has since gone away) shows in the bottom-right corner.

type Toast = { id: number; text: string; bad?: boolean; anchor?: HTMLElement }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {})

const CLICKABLE = 'button, a, [role="button"], summary, label.check'
/** How long after a click its toast still belongs to the button (covers slow saves, checks, uploads). */
const ANCHOR_MS = 20000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const lastClick = useRef<{ el: HTMLElement; at: number } | null>(null)
  const els = useRef(new Map<number, HTMLDivElement>())

  // Remember the button behind the latest click; any other interaction forgets it.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(CLICKABLE)
      lastClick.current = el ? { el, at: Date.now() } : null
    }
    const onKey = (e: KeyboardEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(CLICKABLE)
      lastClick.current = el && (e.key === 'Enter' || e.key === ' ') ? { el, at: Date.now() } : null
    }
    const forget = () => { lastClick.current = null }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('drop', forget, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('drop', forget, true)
    }
  }, [])

  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random()
    const c = lastClick.current
    const anchor = c && Date.now() - c.at < ANCHOR_MS && c.el.isConnected && c.el.getClientRects().length ? c.el : undefined
    // One message per button: a new one replaces the last.
    setToasts((t) => [...t.filter((x) => !anchor || x.anchor !== anchor), { id, text, bad, anchor }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3500)
  }, [])

  // Keep anchored toasts under their buttons while things scroll or resize; if the button goes
  // away (a dialog closed, the page changed) the toast moves to the corner.
  const anchored = toasts.some((t) => t.anchor)
  useEffect(() => {
    if (!anchored) return
    let frame = 0
    const place = () => {
      const gone: number[] = []
      for (const t of toasts) {
        const box = t.anchor && els.current.get(t.id)
        if (!t.anchor || !box) continue
        if (!t.anchor.isConnected || !t.anchor.getClientRects().length) { gone.push(t.id); continue }
        const r = t.anchor.getBoundingClientRect()
        const w = box.offsetWidth
        const h = box.offsetHeight
        const below = r.bottom + 8 + h <= window.innerHeight - 8
        const center = r.left + r.width / 2
        const left = Math.max(8, Math.min(center - w / 2, window.innerWidth - w - 8))
        box.style.left = `${left}px`
        box.style.top = `${below ? r.bottom + 8 : r.top - 8 - h}px`
        box.style.setProperty('--arrow-x', `${Math.max(12, Math.min(center - left, w - 12))}px`)
        box.classList.toggle('above', !below)
        box.classList.add('placed')
      }
      if (gone.length) setToasts((ts) => ts.map((x) => (gone.includes(x.id) ? { ...x, anchor: undefined } : x)))
      else frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [anchored, toasts])

  const ref = (id: number) => (el: HTMLDivElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id) }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.filter((t) => !t.anchor).map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>{t.text}</div>
        ))}
      </div>
      <div role="status" aria-live="polite">
        {toasts.filter((t) => t.anchor).map((t) => (
          <div key={t.id} ref={ref(t.id)} className={`toast anchored${t.bad ? ' bad' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

// ---------- data loading hook

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    setLoading(true)
    fn()
      .then((d) => { if (n === seq.current) { setData(d); setError(null) } })
      .catch((e: Error) => { if (n === seq.current) setError(e.message) })
      .finally(() => { if (n === seq.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload, setData }
}

// ---------- small components

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading"><Spinner /> {text}</div>
}

/** What reading a whole dataset says while it runs, by seconds waited. The first read of a large
 *  file takes a while; after that it comes from the table cache in about a second. */
export const READING_DATA: [number, string][] = [
  [0, 'Reading the data…'],
  [4, 'Still reading. Large files take longer the first time.'],
  [10, 'Working out which columns hold numbers, dates and text…'],
  [20, 'Nearly there. Next time this file opens much faster.'],
  [45, 'Still working. Very large files can take a minute or two.'],
]

/** A wait that may run long: the message moves on as time passes, with the seconds so far,
 *  so a slow first read never looks stuck. Each step is [seconds after which it shows, text]. */
export function WaitMessages({ steps = READING_DATA, compact }: { steps?: [number, string][]; compact?: boolean }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(t)
  }, [])
  const text = steps.filter(([at]) => secs >= at).pop()?.[1] ?? steps[0][1]
  return (
    <div className={`loading wait${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <Spinner /> <span key={text} className="wait-text">{text}</span>
      {secs >= 3 && <span className="faint small nowrap">{secs}s</span>}
    </div>
  )
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="alert bad">{error}</div>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  const back = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // With modals stacked (e.g. a dialog opened from a pop-up), Escape closes only the top one.
    const onKey = (e: KeyboardEvent) => {
      const all = document.querySelectorAll('.modal-back')
      if (e.key === 'Escape' && all[all.length - 1] === back.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" ref={back} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  )
}

const STATUS_TONE: Record<string, string> = {
  ok: 'ok', completed: 'ok', changed: 'warn', drift: 'warn', awaiting_response: 'info', invalid_response: 'bad',
  missing: 'bad', error: 'bad', failed: 'bad', removed: 'bad', running: 'info', draft: '',
}
const STATUS_TEXT: Record<string, string> = {
  ok: 'OK', completed: 'Completed', changed: 'Changed', drift: 'Columns changed', awaiting_response: 'Waiting for AI reply',
  invalid_response: 'Reply needs fixing', missing: 'Missing', error: 'Unreadable', failed: 'Failed', removed: 'Removed',
  running: 'Running', draft: 'Draft',
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{STATUS_TEXT[status] ?? status}</span>
}

export function KindIcon({ kind, ext, size = 28 }: { kind: SourceKind; ext?: string; size?: number }) {
  return <FileIcon kind={kind} ext={ext} size={size} />
}

export function ModeBadge({ mode }: { mode: string }) {
  const map: Record<string, [string, string]> = {
    deterministic: ['ok', 'Runs locally'],
    ai_assisted: ['info', 'AI-assisted'],
    ai_dependent: ['warn', 'Uses AI chatbot'],
  }
  const [tone, text] = map[mode] ?? ['', mode]
  return <span className={`badge ${tone}`}>{text}</span>
}

export function CopyButton({ text, label = 'Copy', primary }: { text: string; label?: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false)
  const toast = useToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for browsers that block the async clipboard API on http://127.0.0.1
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if (!ok) { toast('Could not copy automatically; select the text and press Ctrl+C', true); return }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return <button className={primary ? 'primary' : ''} onClick={copy}>{copied ? '✓ Copied' : label}</button>
}

/** When the underlying file (mtime) or Confluence page was last modified, as recorded at the last check. */
export function sourceModified(s: Source): Date | null {
  if (s.metadata.mtime) return new Date(s.metadata.mtime * 1000)
  return s.metadata.modified ? new Date(s.metadata.modified) : null
}

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtBytes(n: number | undefined) {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtNum(n: number | undefined | null) {
  return n === undefined || n === null ? '' : n.toLocaleString()
}
