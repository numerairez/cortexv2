import { useEffect, useRef, useState } from 'react'
import type { Row, Sel } from '../../dashboard'
import { DATA_NAME, SEL, readSelection, vegaConfig, type SelectInfo } from './vegaSpec'

// Vega is large, so it loads the first time a chart is shown rather than with the app.
let embedModule: Promise<typeof import('vega-embed')> | null = null
const loadEmbed = () => (embedModule ??= import('vega-embed'))

type View = Awaited<ReturnType<typeof import('vega-embed')['default']>>['view']

/** Charts only ever see rows pushed in from the dashboard: no URLs, no remote images or links. */
const offlineLoader = {
  load: () => Promise.reject(new Error('Charts cannot load files or web addresses')),
  sanitize: () => Promise.reject(new Error('Charts cannot open links')),
  http: () => Promise.reject(new Error('Charts cannot load web addresses')),
  file: () => Promise.reject(new Error('Charts cannot load files')),
}

/** Plain copies of the rows. Vega tags every row object with a hidden tuple id; rows shared between charts,
 *  or spread from tagged rows, would carry ids another dataflow already knows, and updates would be ignored. */
const untagged = (rows: Row[]) => rows.map((r) => Object.fromEntries(Object.entries(r)))

/** Re-render charts when the OS switches between light and dark. */
function useColorScheme() {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

export function VegaChart({ spec, specKey, rows, note, select, active, onSelect }: {
  spec: Record<string, unknown>
  /** Changes whenever the spec does; the chart is rebuilt only then (data updates are pushed in place). */
  specKey: string
  rows: Row[]
  /** A small note in the chart's corner, e.g. that it shows a sample. */
  note?: string
  select: SelectInfo | null
  /** Whether the dashboard still holds this chart's selection; when it drops it, the chart clears too. */
  active: boolean
  onSelect?: (sel: Sel | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<View | null>(null)
  const latest = useRef({ rows, onSelect, select })
  latest.current = { rows, onSelect, select }
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const dark = useColorScheme()

  useEffect(() => {
    const el = host.current
    if (!el) return
    let cancelled = false
    let finalize: (() => void) | undefined
    let observer: ResizeObserver | undefined
    setError(null)
    setReady(false)
    loadEmbed().then(async ({ default: embed }) => {
      if (cancelled) return
      const size = () => ({ width: Math.max(40, el.clientWidth), height: Math.max(40, el.clientHeight) })
      try {
        // The first rows go in with the spec; later ones are pushed into the named dataset.
        const data = { name: DATA_NAME, values: untagged(latest.current.rows) }
        const res = await embed(el, { ...spec, data, ...size(), autosize: { type: 'fit', contains: 'padding' } } as never, {
          actions: false, renderer: 'svg', config: vegaConfig() as never, loader: offlineLoader as never, logLevel: 1,
          tooltip: { theme: 'custom', offsetX: 12, offsetY: 12 },
        })
        if (cancelled) { res.finalize(); return }
        finalize = () => res.finalize()
        view.current = res.view
        if (latest.current.select && hasSignal(res.view, SEL)) {
          res.view.addSignalListener(SEL, (_name, value) => {
            const info = latest.current.select
            latest.current.onSelect?.(info ? readSelection(value, info) : null)
          })
        }
        let frame = 0
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(() => { const s = size(); res.view.width(s.width).height(s.height).runAsync() })
        })
        observer.observe(el)
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })
    return () => {
      cancelled = true
      observer?.disconnect()
      finalize?.()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, dark])

  // New data (another object's selection changed): push it in, keeping this chart's own selection.
  useEffect(() => {
    const v = view.current
    if (v) v.data(DATA_NAME, untagged(rows) as never).runAsync().catch(() => undefined)
  }, [rows])

  // The dashboard cleared this chart's selection (e.g. "Clear all"): clear the chart's own state to match.
  useEffect(() => {
    const v = view.current
    if (active || !v || !hasData(v, `${SEL}_store`)) return
    if ((v.data(`${SEL}_store`) as unknown[]).length === 0) return
    for (const ch of ['x', 'y']) if (hasSignal(v, `${SEL}_${ch}`)) v.signal(`${SEL}_${ch}`, [])
    v.data(`${SEL}_store`, []).runAsync().catch(() => undefined)
  }, [active])

  return (
    <div className="vega-host">
      <div ref={host} className={`vega-canvas${ready ? ' ready' : ''}`} />
      {note && !error && <div className="vega-note">{note}</div>}
      {error && <div className="vega-error"><b>This chart can’t be drawn.</b><span>{error}</span></div>}
    </div>
  )
}

function hasSignal(v: View, name: string) {
  try { v.signal(name); return true } catch { return false }
}
function hasData(v: View, name: string) {
  try { v.data(name); return true } catch { return false }
}
