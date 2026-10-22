import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SourceKind } from '../types'
import { FileIcon } from './Icons'

// ---------- toasts

type Toast = { id: number; text: string; bad?: boolean }
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, bad }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), bad ? 7000 : 3500)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>{t.text}</div>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
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
