import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useBlocker, useParams, useSearchParams } from 'react-router-dom'
import { api, qs } from '../api'
import { AiComposer, BlankChartChoice } from '../components/dashboard/AiComposer'
import { TemplatePicker } from '../components/dashboard/TemplatePicker'
import { TEMPLATES, buildFromTemplate } from '../dashboardTemplates'
import { DashCanvas, FIELD_MIME, WIDGET_MIME, type Mode } from '../components/dashboard/Canvas'
import { Inspector } from '../components/dashboard/Inspector'
import type { LinkProposal } from '../components/dashboard/AiLinks'
import { InteractionsPanel } from '../components/dashboard/Interactions'
import { PivotBody } from '../components/dashboard/Pivot'
import { ChartBody, HeadlineBody, TableBody, TYPE_LABEL, WidgetIcon } from '../components/dashboard/Widgets'
import { FileIcon, TypeGlyph } from '../components/Icons'
import { describeCondition } from '../components/StepEditor'
import { ErrorBox, Loading, Modal, Spinner, WaitMessages, fmtDate, useToast } from '../components/ui'
import {
  activeConditions, applyFilter, defaultMeasure, canDrive, canHighlight, vegaLiteFilters, defaultSelectBy, describeSel, freeSpot, isCategory, isNumeric, matches, measureLabel, measureOf, newId, newWidget, selIsEmpty, settle, timeUnitFor, toRows,
  type Box, type ColType, type Dashboard, type DashboardSpec, type DashData, type Row, type Sel, type Widget, type WidgetType,
} from '../dashboard'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'view', label: 'View', hint: 'See the dashboard as viewers do' },
  { id: 'edit', label: 'Edit layout', hint: 'Add, arrange and set up objects' },
  { id: 'wire', label: 'Interactions', hint: 'Connect objects so clicking one filters or highlights others' },
]
const PALETTE: { type: WidgetType; title: string; text: string }[] = [
  { type: 'headline', title: 'Headline', text: 'One big number' },
  { type: 'chart', title: 'Chart', text: 'Build it, or ask AI' },
  { type: 'table', title: 'Table', text: 'Rows or a summary' },
]

/** A chart with nothing set up yet: its wireframe holds the describe-it composer while editing. */
const isBlank = (w: Widget) => w.type === 'chart' && !w.vegaLite && !w.x
/** Too small to hold the describe box inside it (headlines, narrow objects): it floats below instead. */
const isSmall = (w: Widget) => w.box.h < 6 || w.box.w < 4

interface WidgetData {
  rows: Row[]
  /** Rows left after the object's own filter, before any interaction narrows them. */
  ownCount: number
  /** Live picks in other objects that filter this one, described for its caption. */
  liveFilters: { from: string; text: string }[]
  /** Highlighted rows, when another object highlights this one. */
  highlighted: Row[] | null
  highlightFn: ((r: Row) => boolean) | null
  filteredBy: string[]
}

export default function DashboardEditor() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<DashData | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedLink, setSelectedLink] = useState<string | null>(null)
  const [sels, setSels] = useState<Record<string, Sel>>({})
  const [fieldFilter, setFieldFilter] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const [templating, setTemplating] = useState<string | null>(null)
  /** Objects whose wireframe shows the describe-a-change composer (blank charts always do). */
  const [composing, setComposing] = useState<Set<string>>(new Set())
  /** Links a chatbot reply would set, drawn on the wireframe until applied or discarded. */
  const [proposal, setProposal] = useState<LinkProposal | null>(null)
  // Only one small object's floating describe box is open at a time; opening another closes it.
  const compose = (wid: string, on: boolean) => setComposing((s) => {
    const small = (id: string) => { const w = spec.widgets.find((x) => x.id === id); return !!w && isSmall(w) }
    const n = new Set(on && small(wid) ? [...s].filter((id) => !small(id)) : s)
    if (on) n.add(wid); else n.delete(wid)
    return n
  })
  const history = useRef<{ past: DashboardSpec[]; future: DashboardSpec[]; lastKey?: string; lastAt: number }>({ past: [], future: [], lastAt: 0 })

  const mode = (params.get('mode') as Mode) || 'view'
  const setMode = (m: Mode) => {
    setParams((p) => { p.set('mode', m); return p }, { replace: true })
    setSelectedLink(null)
    setSelectedId(null)
    setProposal(null)
    if (m !== 'view') setSels({})
  }

  // ---- load
  useEffect(() => {
    api.get<Dashboard>(`/api/dashboards/${id}`).then((d) => {
      setDash(d)
      setSavedAt(d.updated_at)
      if (!params.get('mode')) setParams((p) => { p.set('mode', d.spec.widgets.length ? 'view' : 'edit'); return p }, { replace: true })
    }).catch((e: Error) => setLoadError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  const loadData = useCallback(async (dataset: string) => {
    setDataLoading(true)
    try { setData(await api.get<DashData>(`/api/dashboards/data?${qs({ dataset })}`)); setDataError(null) } catch (e) { setDataError((e as Error).message) } finally { setDataLoading(false) }
  }, [])
  useEffect(() => { if (dash?.dataset) loadData(dash.dataset) }, [dash?.dataset, loadData])

  const rows = useMemo(() => (data ? toRows(data) : []), [data])
  const columns = useMemo(() => data?.columns ?? [], [data])
  const types = useMemo(() => Object.fromEntries(columns.map((c) => [c.name, c.type as ColType])), [columns])

  // ---- editing (with undo)
  const spec = dash?.spec ?? { widgets: [], links: [] }
  const setSpec = useCallback((next: DashboardSpec | ((s: DashboardSpec) => DashboardSpec), coalesceKey?: string) => {
    setDash((d) => {
      if (!d) return d
      const value = typeof next === 'function' ? next(d.spec) : next
      const h = history.current
      const now = Date.now()
      if (!(coalesceKey && coalesceKey === h.lastKey && now - h.lastAt < 1200)) h.past = [...h.past.slice(-99), d.spec]
      h.future = []
      h.lastKey = coalesceKey
      h.lastAt = now
      return { ...d, spec: value }
    })
    setDirty(true)
  }, [])
  const undo = () => {
    const h = history.current
    const prev = h.past.pop()
    if (!prev || !dash) return
    h.future.push(dash.spec)
    h.lastKey = undefined
    setDash({ ...dash, spec: prev })
    setDirty(true)
  }
  const redo = () => {
    const h = history.current
    const next = h.future.pop()
    if (!next || !dash) return
    h.past.push(dash.spec)
    setDash({ ...dash, spec: next })
    setDirty(true)
  }
  const setMeta = (patch: Partial<Pick<Dashboard, 'name' | 'description'>>) => { setDash((d) => d && { ...d, ...patch }); setDirty(true) }

  const updateWidget = (w: Widget, key?: string) => setSpec((s) => ({ ...s, widgets: s.widgets.map((x) => (x.id === w.id ? w : x)) }), key ?? `w:${w.id}`)
  const addWidget = (type: WidgetType, box?: Box) => {
    const size = { headline: { w: 3, h: 3 }, chart: { w: 6, h: 8 }, table: { w: 6, h: 8 } }[type]
    const at = box ?? freeSpot(spec.widgets, size.w, size.h)
    // A new chart starts blank: its wireframe asks whether to set it up by hand or describe it to the chatbot.
    const w: Widget = type === 'chart'
      ? { id: newId('c'), type: 'chart', chart: 'bar', title: 'New chart', y: defaultMeasure(columns), box: at }
      : newWidget(type, columns, at)
    setSpec((s) => ({ ...s, widgets: settle(settle([...s.widgets, w], { id: w.id, box: w.box })) }))
    setSelectedId(w.id)
    return w
  }
  // The chatbot's object replaces this one in place. Links stay unless the new kind can't take part in them.
  const applyAi = (wid: string, next: Widget, notes: string[]) => {
    setSpec((s) => ({
      widgets: s.widgets.map((x) => (x.id === wid ? { ...next, id: wid, box: x.box, title: next.title || x.title } : x)),
      links: s.links.filter((l) => !(l.source === wid && !canDrive(next))).map((l) => (l.target === wid && l.effect === 'highlight' && !canHighlight(next) ? { ...l, effect: 'filter' as const } : l)),
    }))
    compose(wid, false)
    toast(notes.length ? `Applied, with notes: ${notes.join(' ')}` : 'Applied the chatbot’s design — Ctrl+Z undoes it')
  }
  // "Set it up yourself": fill the blank chart with the builder's defaults, keeping its place.
  const setUpManually = (blank: Widget) => {
    const filled = newWidget('chart', columns, blank.box)
    setSpec((s) => ({ ...s, widgets: s.widgets.map((x) => (x.id === blank.id ? { ...filled, id: blank.id } : x)) }))
    setSelectedId(blank.id)
  }
  const removeWidget = (wid: string) => {
    setSpec((s) => ({ widgets: settle(s.widgets.filter((w) => w.id !== wid)), links: s.links.filter((l) => l.source !== wid && l.target !== wid) }))
    setSelectedId(null)
  }
  const duplicateWidget = (wid: string) => {
    const src = spec.widgets.find((w) => w.id === wid)
    if (!src) return
    const copy = { ...structuredClone(src), id: newId(src.type[0]), title: `${src.title} (copy)`, box: freeSpot(spec.widgets, src.box.w, src.box.h) } as Widget
    setSpec((s) => ({ ...s, widgets: [...s.widgets, copy] }))
    setSelectedId(copy.id)
  }

  // A column dropped on an object fills the obvious slot; dropped on the canvas it starts a fitting object.
  const fieldDrop = (field: string, target: string | null, box: Box) => {
    const t = types[field]
    const sum = measureOf(field)
    if (!target) {
      const type: WidgetType = isNumeric(t) ? 'headline' : 'chart'
      const base = newWidget(type, columns, type === 'headline' ? { ...box, w: 3, h: 3 } : box)
      let w: Widget = base
      if (base.type === 'headline') w = { ...base, measure: sum, title: measureLabel(sum) }
      else if (base.type === 'chart') {
        w = t === 'date'
          ? { ...base, chart: 'line', x: field, timeUnit: timeUnitFor(rows, field), top: undefined, title: `${measureLabel(base.y)} over time` }
          : { ...base, chart: 'bar', x: field, title: `${measureLabel(base.y)} by ${field}` }
      }
      setSpec((s) => ({ ...s, widgets: settle(settle([...s.widgets, w], { id: w.id, box: w.box })) }))
      setSelectedId(w.id)
      return
    }
    const w = spec.widgets.find((x) => x.id === target)
    if (!w) return
    let next: Widget = w
    if (w.type === 'headline') next = { ...w, measure: isNumeric(t) ? sum : { agg: 'distinct', field } }
    else if (w.type === 'table') {
      if (w.mode === 'pivot') {
        next = isNumeric(t) ? { ...w, pivotValue: sum }
          : !w.pivotColumn ? { ...w, pivotColumn: field, groupBy: w.groupBy.filter((g) => g !== field) }
          : field === w.pivotColumn || w.groupBy.includes(field) ? w : { ...w, groupBy: [...w.groupBy, field] }
      } else if (w.mode === 'summary') next = isNumeric(t) ? { ...w, measures: [...w.measures, sum] } : { ...w, groupBy: w.groupBy.includes(field) ? w.groupBy : [...w.groupBy, field] }
      else next = { ...w, columns: w.columns.includes(field) ? w.columns : [...w.columns, field] }
    } else if (w.chart === 'scatter') next = isNumeric(t) ? (w.x ? { ...w, y: sum } : { ...w, x: field }) : { ...w, color: field }
    else if (isNumeric(t)) next = { ...w, y: sum }
    else if (w.x && w.x !== field && isCategory(t) && w.chart !== 'donut') next = { ...w, color: field }
    else next = { ...w, x: field, timeUnit: t === 'date' ? w.timeUnit ?? timeUnitFor(rows, field) : w.timeUnit }
    updateWidget(next)
    setSelectedId(w.id)
    toast(`${field} → ${w.title || TYPE_LABEL[w.type]}`)
  }

  const connect = (source: string, target: string) => {
    const tgt = spec.widgets.find((w) => w.id === target)
    if (spec.links.some((l) => l.source === source && l.target === target)) { toast('Those two are already connected'); return }
    const link = { id: newId('l'), source, target, effect: 'filter' as const }
    setSpec((s) => ({ ...s, links: [...s.links, link] }))
    setSelectedLink(link.id)
    setSelectedId(null)
    if (tgt) toast(`Connected — clicking now filters “${tgt.title || TYPE_LABEL[tgt.type]}”`)
  }

  // ---- save
  const save = useCallback(async () => {
    if (!dash) return false
    setSaving(true)
    try {
      const d = await api.put<Dashboard>(`/api/dashboards/${dash.id}`, { name: dash.name, description: dash.description, dataset: dash.dataset, spec: dash.spec })
      setDash((cur) => cur && { ...cur, updated_at: d.updated_at })
      setSavedAt(d.updated_at)
      setDirty(false)
      toast('Dashboard saved')
      return true
    } catch (e) { toast((e as Error).message, true); return false } finally { setSaving(false) }
  }, [dash, toast])

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ---- keyboard
  const keys = useRef({ save, undo, redo, removeWidget, duplicateWidget, mode, selectedId, selectedLink, spec })
  keys.current = { save, undo, redo, removeWidget, duplicateWidget, mode, selectedId, selectedLink, spec }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); k.save(); return }
      if (typing || document.querySelector('.modal-back')) return
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo() }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); k.redo() }
      else if (mod && e.key.toLowerCase() === 'd' && k.mode === 'edit' && k.selectedId) { e.preventDefault(); k.duplicateWidget(k.selectedId) }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && k.mode === 'edit' && k.selectedId) { e.preventDefault(); k.removeWidget(k.selectedId) }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && k.mode === 'wire' && k.selectedLink) {
        e.preventDefault()
        setSpec((s) => ({ ...s, links: s.links.filter((l) => l.id !== k.selectedLink) }))
        setSelectedLink(null)
      } else if (e.key === 'Escape') { setSelectedId(null); setSelectedLink(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSpec])

  // ---- what each object shows: the dataset, narrowed by the selections of the objects it listens to
  const live = mode === 'view'
  const cache = useRef(new Map<string, { key: string; value: WidgetData }>())
  const widgetData = useMemo(() => {
    const out: Record<string, WidgetData> = {}
    const seen = new Set<string>()
    for (const w of spec.widgets) {
      const inc = live ? spec.links.filter((l) => l.target === w.id && !selIsEmpty(sels[l.source])) : []
      const filters = inc.filter((l) => l.effect === 'filter' || !canHighlight(w))
      const highlights = inc.filter((l) => l.effect === 'highlight' && canHighlight(w))
      const key = JSON.stringify([w.filter ?? null, filters.map((l) => sels[l.source]), highlights.map((l) => sels[l.source]), rows.length])
      const hit = cache.current.get(w.id)
      seen.add(w.id)
      if (hit && hit.key === key) { out[w.id] = hit.value; continue }
      const fsels = filters.map((l) => sels[l.source])
      const hsels = highlights.map((l) => sels[l.source])
      // The object's own filter first, then whatever other objects' picks narrow it to.
      const own = applyFilter(rows, w.filter, types)
      const r = fsels.length ? own.filter((row) => fsels.every((s) => matches(row, s))) : own
      const highlightFn = hsels.length ? (row: Row) => hsels.every((s) => matches(row, s)) : null
      const value: WidgetData = {
        rows: r, highlightFn, highlighted: highlightFn ? r.filter(highlightFn) : null,
        filteredBy: filters.map((l) => spec.widgets.find((x) => x.id === l.source)?.title ?? ''),
        ownCount: own.length,
        liveFilters: filters.map((l) => ({ from: spec.widgets.find((x) => x.id === l.source)?.title ?? '', text: describeSel(sels[l.source]) })),
      }
      cache.current.set(w.id, { key, value })
      out[w.id] = value
    }
    for (const k of cache.current.keys()) if (!seen.has(k)) cache.current.delete(k)
    return out
  }, [spec, sels, rows, live, data, types])
  // Object identity of rows changes with the dataset; start fresh when it does.
  useEffect(() => { cache.current.clear() }, [rows])

  const drives = (w: Widget) => spec.links.some((l) => l.source === w.id)
  const setSel = (wid: string, s: Sel | null) => setSels((cur) => {
    if (selIsEmpty(s)) { if (!(wid in cur)) return cur; const { [wid]: _drop, ...rest } = cur; return rest }
    return { ...cur, [wid]: s! }
  })
  const activeSels = Object.entries(sels).filter(([wid, s]) => !selIsEmpty(s) && spec.widgets.some((w) => w.id === wid))

  const renderBody = (w: Widget) => {
    if (dataError) return <div className="dash-placeholder bad">No data</div>
    if (!data) return <div className="dash-placeholder"><Spinner /></div>
    if (mode === 'edit' && composing.has(w.id) && !isSmall(w)) {
      return <AiComposer dataset={dash!.dataset} widget={w} columns={columns} blank={isBlank(w)}
        onApply={(next, notes) => applyAi(w.id, next, notes)} onCancel={() => compose(w.id, false)} />
    }
    if (mode === 'edit' && isBlank(w)) {
      return <BlankChartChoice w={w} onManual={() => setUpManually(w)} onDescribe={() => { setSelectedId(w.id); compose(w.id, true) }} />
    }
    const d = widgetData[w.id]
    if (!d) return null
    if (w.type === 'headline') return <HeadlineBody w={w} rows={d.rows} highlighted={d.highlighted ?? []} highlighting={!!d.highlightFn} />
    if (w.type === 'table' && w.mode === 'pivot') {
      return <PivotBody w={w} rows={d.rows} types={types} highlight={d.highlightFn} drive={live && drives(w)} selection={sels[w.id] ?? null} onSelect={(s) => setSel(w.id, s)} />
    }
    if (w.type === 'table') {
      const by = live && drives(w) ? defaultSelectBy(w, types) : undefined
      return <TableBody w={w} rows={d.rows} types={types} highlight={d.highlightFn} selectBy={by} selection={sels[w.id] ?? null} onSelect={(s) => setSel(w.id, s)} />
    }
    const highlightTarget = live && canHighlight(w) && spec.links.some((l) => l.target === w.id && l.effect === 'highlight')
    return <ChartBody w={w} rows={d.rows} types={types} drive={live && drives(w)} highlight={highlightTarget} highlightFn={d.highlightFn} selection={sels[w.id] ?? null} onSelect={(s) => setSel(w.id, s)} />
  }

  // The context under each object: where its numbers come from and what narrows them.
  const renderCaption = (w: Widget) => {
    const d = widgetData[w.id]
    if (w.caption === false || !data || !d || (mode === 'edit' && ((composing.has(w.id) && !isSmall(w)) || isBlank(w)))) return null
    const total = rows.length
    const conds = activeConditions(w.filter)
    const custom = w.type === 'chart' && w.vegaLite ? vegaLiteFilters(w.vegaLite) : []
    const source = `${dash!.dataset_label ?? data.label}${data.file ? ` — ${data.file}${data.sheet && data.sheet !== '(csv)' ? `, sheet ${data.sheet}` : ''}` : ''}`
    const lines = [
      `Data: ${source}`,
      data.read_at ? `Read ${fmtDate(data.read_at)}` : '',
      d.rows.length === total ? `${total.toLocaleString()} rows` : `${d.rows.length.toLocaleString()} of ${total.toLocaleString()} rows`,
      ...conds.map((c) => `Filter: ${c.column} ${describeCondition(c as never)}`),
      ...custom.map((f) => `Custom filter: ${f}`),
      ...d.liveFilters.map((l) => `Picked in “${l.from}”: ${l.text}`),
    ].filter(Boolean)
    return (
      <div className="dash-caption" title={lines.join('\n')}>
        <span className="cap-source"><FileIcon kind={dash!.dataset_kind ?? 'excel'} size={12} />{dash!.dataset_label ?? data.label}</span>
        <span className="cap-rows">{d.rows.length === total ? `${total.toLocaleString()} rows` : `${d.rows.length.toLocaleString()} of ${total.toLocaleString()} rows`}</span>
        {w.box.w <= 3 ? (
          // Narrow objects (headlines) count what narrows them; hovering shows the details.
          <>
            {conds.length + custom.length > 0 && <span className="cap-filter">{conds.length + custom.length} filter{conds.length + custom.length === 1 ? '' : 's'}</span>}
            {d.liveFilters.length > 0 && <span className="cap-live">{d.liveFilters.length} pick{d.liveFilters.length === 1 ? '' : 's'}</span>}
          </>
        ) : (
          <>
            {conds.map((c, i) => <span key={i} className="cap-filter"><b>{c.column}</b> {describeCondition(c as never)}</span>)}
            {custom.map((f, i) => <span key={`v${i}`} className="cap-filter custom">{f}</span>)}
            {d.liveFilters.map((l, i) => <span key={`l${i}`} className="cap-live">{l.text}</span>)}
          </>
        )}
      </div>
    )
  }

  const renderBadges = (w: Widget) => {
    if (mode === 'wire') {
      const out = spec.links.filter((l) => l.source === w.id).length
      const inc = spec.links.filter((l) => l.target === w.id).length
      return <>{inc > 0 && <span className="wire-count in" title={`Listens to ${inc}`}>←{inc}</span>}{out > 0 && <span className="wire-count out" title={`Drives ${out}`}>{out}→</span>}</>
    }
    if (mode !== 'view') return null
    const d = widgetData[w.id]
    const s = sels[w.id]
    return (
      <>
        {d?.filteredBy.length ? <span className="dash-badge filter" title={`Filtered by ${d.filteredBy.join(', ')}`}>⏷ Filtered</span> : null}
        {d?.highlightFn ? <span className="dash-badge hl" title="Part of this is highlighted by another object">◐ Highlighted</span> : null}
        {s && !selIsEmpty(s) ? (
          <span className="dash-badge picked" title={describeSel(s)}>
            <span className="ellipsis">{describeSel(s)}</span>
            <button aria-label="Clear selection" onClick={(e) => { e.stopPropagation(); setSel(w.id, null) }}>✕</button>
          </span>
        ) : drives(w) ? <span className="dash-hint" title={`Viewers can click this to ${spec.links.some((l) => l.source === w.id && l.effect === 'highlight') ? 'filter or highlight' : 'filter'} other objects`}>☝</span> : null}
      </>
    )
  }

  if (loadError) return <div className="dash-page-error"><ErrorBox error={loadError} /><Link to="/dashboards">← All dashboards</Link></div>
  if (!dash) return <Loading />

  const selected = spec.widgets.find((w) => w.id === selectedId)
  const shownFields = columns.filter((c) => !fieldFilter || c.name.toLowerCase().includes(fieldFilter.toLowerCase()))
  const linkCount = spec.links.length

  return (
    <div className="dash">
      <div className="dash-toolbar">
        <Link to="/dashboards" className="btn ghost sm" title="All dashboards">←</Link>
        <input className="dash-name" value={dash.name} onChange={(e) => setMeta({ name: e.target.value })} aria-label="Dashboard name" size={Math.max(8, dash.name.length)} />
        <button className="dataset-chip" onClick={() => setShowInfo(true)} title="About the data">
          <FileIcon kind={dash.dataset_kind ?? 'excel'} size={16} />
          <span className="ellipsis">{dash.dataset_label ?? 'Missing dataset'}</span>
          {data && <span className="faint">· {data.row_count.toLocaleString()} rows</span>}
          {(data?.warnings.length || data?.truncated) ? <span className="warn-dot" aria-label="Has warnings">!</span> : null}
        </button>
        <span className="spacer" />
        <div className="mode-switch" role="tablist" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)} title={m.hint}>
              {m.id === 'view' ? '◉' : m.id === 'edit' ? '▦' : '⇄'} {m.label}
              {m.id === 'wire' && linkCount > 0 && <span className="mode-count">{linkCount}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className={`dash-status ${linkCount ? 'interactive' : ''}`} title={linkCount ? `${linkCount} interaction(s)` : 'No interactions: clicking does nothing'}>
          {linkCount ? 'Interactive' : 'Static'}
        </span>
        <span className={`save-state small nowrap${dirty ? ' dirty' : ''}`} title={savedAt ? `Last saved ${fmtDate(savedAt)}` : undefined}>{dirty ? 'Unsaved' : 'Saved'}</span>
        <button className="ghost sm" onClick={undo} disabled={!history.current.past.length} title="Undo (Ctrl+Z)">↶</button>
        <button className="ghost sm" onClick={redo} disabled={!history.current.future.length} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button className="primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      {dataError && <div className="dash-banner"><ErrorBox error={`Couldn’t read the data: ${dataError}`} /></div>}
      {dataLoading && !data && <div className="dash-banner"><WaitMessages compact /></div>}

      <div className="dash-body">
        {mode === 'edit' && (
          <aside className="dash-left">
            <div className="dash-section">
              <div className="label-sm">Add an object</div>
              <div className="palette">
                {PALETTE.map((p) => (
                  <button key={p.type} className={`palette-tile t-${p.type}`} draggable
                    onDragStart={(e) => { e.dataTransfer.setData(WIDGET_MIME, p.type); e.dataTransfer.setData(`${WIDGET_MIME}+${p.type}`, ''); e.dataTransfer.effectAllowed = 'copy' }}
                    onClick={() => addWidget(p.type)} title={`Click to add, or drag onto the canvas`}>
                    <span className="palette-icon"><WidgetIcon type={p.type} size={20} /></span>
                    <span><b>{p.title}</b><span className="faint small">{p.text}</span></span>
                  </button>
                ))}
              </div>
              <button className="ghost sm tpl-open" onClick={() => setTemplating('kpi-trend')}>▦ Layout templates…</button>
            </div>
            <div className="dash-section grow">
              <div className="label-sm">Fields <span className="faint">· drag onto an object</span></div>
              {columns.length > 8 && <input placeholder="Search columns…" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} style={{ marginBottom: 6 }} />}
              <div className="field-list">
                {dataLoading && !data ? <Spinner /> : shownFields.map((c) => (
                  <div key={c.name} className="field-item" draggable title={`${c.name} (${c.type})`}
                    onDragStart={(e) => { e.dataTransfer.setData(FIELD_MIME, c.name); e.dataTransfer.effectAllowed = 'copy' }}>
                    <TypeGlyph type={c.type} /><span className="ellipsis">{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}

        <main className="dash-main" onPointerDown={(e) => { if (e.target === e.currentTarget) { setSelectedId(null); setSelectedLink(null) } }}>
          {mode !== 'wire' && (spec.showTitle !== false ? (
            <header className={`dash-heading${mode === 'edit' ? ' editing' : ''}`}>
              {mode === 'edit' ? (
                <>
                  <input className="dash-heading-title" value={dash.name} onChange={(e) => setMeta({ name: e.target.value })} placeholder="Dashboard title" aria-label="Dashboard title" />
                  <textarea className="dash-heading-sub" value={dash.description} rows={1} onChange={(e) => setMeta({ description: e.target.value })}
                    placeholder="Add a subtitle: what this dashboard shows, for whom, or how often it's updated" aria-label="Subtitle" />
                  <button className="ghost sm dash-heading-hide" onClick={() => setSpec((sp) => ({ ...sp, showTitle: false }))} title="Hide the title on this dashboard">Hide title</button>
                </>
              ) : (
                <>
                  <h1 className="dash-heading-title">{dash.name}</h1>
                  {dash.description && <p className="dash-heading-sub">{dash.description}</p>}
                </>
              )}
            </header>
          ) : mode === 'edit' && (
            <button className="ghost sm dash-heading-show" onClick={() => setSpec((sp) => ({ ...sp, showTitle: undefined }))}>+ Show the title on the dashboard</button>
          ))}
          {mode === 'view' && activeSels.length > 0 && (
            <div className="filter-bar">
              <span className="faint small">Showing</span>
              {activeSels.map(([wid, s]) => {
                const w = spec.widgets.find((x) => x.id === wid)!
                return <span key={wid} className="filter-chip"><b>{describeSel(s)}</b><span className="faint">from {w.title || TYPE_LABEL[w.type]}</span><button aria-label="Clear" onClick={() => setSel(wid, null)}>✕</button></span>
              })}
              <button className="ghost sm" onClick={() => setSels({})}>Clear all</button>
            </div>
          )}
          {mode === 'wire' && (
            <div className="wire-banner">
              <b>Interactions</b> — objects show as outlines. Select one to choose what it filters or highlights, or drag its <span className="port-inline">→</span> handle onto another object.
            </div>
          )}
          {mode === 'view' && !spec.widgets.length ? (
            <div className="dash-empty-view">
              <h3>Nothing on this dashboard yet</h3>
              <button className="primary" onClick={() => setMode('edit')}>Start adding objects</button>
            </div>
          ) : (
            <DashCanvas widgets={spec.widgets} links={spec.links} mode={mode}
              selectedId={selectedId} selectedLink={selectedLink} canDrive={canDrive}
              onSelect={setSelectedId} onSelectLink={setSelectedLink}
              onLayout={(widgets) => setSpec((s) => ({ ...s, widgets }))}
              onAdd={(type, box) => addWidget(type, box)} onFieldDrop={fieldDrop} onConnect={connect}
              renderBody={renderBody} renderBadges={renderBadges} onDuplicate={duplicateWidget} onRemove={removeWidget}
              popover={(() => {
                const w = mode === 'edit' ? spec.widgets.find((x) => composing.has(x.id) && isSmall(x)) : undefined
                return w ? { id: w.id, content: (
                  <AiComposer dataset={dash.dataset} widget={w} columns={columns} blank={isBlank(w)}
                    onApply={(next, notes) => applyAi(w.id, next, notes)} onCancel={() => compose(w.id, false)} />
                ) } : null
              })()}
              onDescribe={(w) => (isBlank(w) || composing.has(w.id) ? undefined : () => { setSelectedId(w.id); compose(w.id, true) })} renderCaption={renderCaption} preview={mode === 'wire' ? proposal : null}
              emptyState={<><h3>An empty canvas</h3><p>Click <b>Headline</b>, <b>Chart</b> or <b>Table</b> on the left, or drag them — or a column — here.</p></>} />
          )}
        </main>

        {mode === 'edit' && (
          <aside className="dash-right">
            {selected ? (
              <Inspector key={selected.id} w={selected} columns={columns} types={types} rows={rows}
                onChange={(w) => updateWidget(w)}
                onDescribe={isBlank(selected) || composing.has(selected.id) ? undefined : () => compose(selected.id, true)} />
            ) : (
              <div className="stack">
                <h3 style={{ margin: 0 }}>Dashboard</h3>
                <label className="field"><span className="label">Subtitle</span>
                  <textarea value={dash.description} onChange={(e) => setMeta({ description: e.target.value })} placeholder="What this dashboard is for (optional)" style={{ minHeight: 60 }} />
                </label>
                <div className="tip-card">
                  <b>Tips</b>
                  <ul>
                    <li>Click an object to set it up; drag its title bar to move it and its corner to resize.</li>
                    <li>Drag a column from <b>Fields</b> onto an object to use it there, or onto empty space to start a new object.</li>
                    <li>Charts and tables don’t react to clicks until you connect them in <button className="link" onClick={() => setMode('wire')}>Interactions</button>.</li>
                  </ul>
                  <span className="faint small">Ctrl+Z undo · Del delete · Ctrl+D duplicate · Ctrl+S save</span>
                </div>
              </div>
            )}
          </aside>
        )}
        {mode === 'wire' && (
          <aside className="dash-right">
            <InteractionsPanel dataset={dash.dataset} widgets={spec.widgets} links={spec.links} types={types}
              onPreview={setProposal}
              onApplyProposal={(p) => {
                setSpec((s) => ({
                  widgets: s.widgets.map((w) => (p.selectBy[w.id] && (w.type === 'chart' || w.type === 'table') ? { ...w, selectBy: p.selectBy[w.id] } : w)),
                  links: p.links,
                }))
                setSelectedId(null); setSelectedLink(null)
                toast('Interactions updated — Ctrl+Z undoes it')
              }}
              selectedId={selectedId} selectedLink={selectedLink}
              onLinks={(links) => setSpec((s) => ({ ...s, links }))} onWidget={(w) => updateWidget(w)}
              onSelect={setSelectedId} onSelectLink={setSelectedLink} onTry={() => setMode('view')} />
          </aside>
        )}
      </div>

      {showInfo && (
        <Modal title="About the data" onClose={() => setShowInfo(false)} footer={<>
          <button onClick={() => { if (dash.dataset) loadData(dash.dataset); setShowInfo(false) }}>↻ Reload the data</button>
          <button className="primary" onClick={() => setShowInfo(false)}>Close</button>
        </>}>
          <div className="stack">
            <p>This dashboard is computed from <b>{dash.dataset_label ?? 'a dataset that is no longer in your library'}</b>{data && <> — {data.row_count.toLocaleString()} rows, {columns.length} columns</>}. Every number is worked out on this PC each time it opens, so it always reflects the current file.</p>
            {data?.truncated && <div className="alert warn">Only the first {rows.length.toLocaleString()} rows are used. Summarise the data in a workflow first for complete figures.</div>}
            {data?.warnings.map((w, i) => <div key={i} className="alert warn small">{w}</div>)}
          </div>
        </Modal>
      )}
      {templating && (
        <Modal title="Start from a layout" wide onClose={() => setTemplating(null)} footer={<>
          {spec.widgets.length > 0 && <span className="faint small" style={{ marginRight: 'auto' }}>Replaces the {spec.widgets.length} objects on this dashboard and their interactions. Ctrl+Z undoes it.</span>}
          <button onClick={() => setTemplating(null)}>Cancel</button>
          <button className="primary" disabled={!data} onClick={() => {
            const t = TEMPLATES.find((x) => x.id === templating)!
            setSpec(buildFromTemplate(t, columns, rows))
            setTemplating(null); setSelectedId(null); setComposing(new Set())
            toast(`Applied “${t.name}” — Ctrl+Z undoes it`)
          }}>Use this layout</button>
        </>}>
          <p className="muted small" style={{ marginTop: 0 }}>Each layout is filled in from <b>{dash.dataset_label}</b>’s own columns; you can change everything afterwards.</p>
          <TemplatePicker value={templating} onChange={setTemplating} columns={columns} compact />
        </Modal>
      )}
      {blocker.state === 'blocked' && (
        <Modal title="Save your changes?" onClose={() => blocker.reset?.()} footer={<>
          <button onClick={() => blocker.reset?.()}>Keep editing</button>
          <button className="danger" onClick={() => blocker.proceed?.()}>Discard</button>
          <button className="primary" onClick={async () => { if (await save()) blocker.proceed?.() }}>Save</button>
        </>}>
          <p>“{dash.name}” has changes that aren’t saved yet.</p>
        </Modal>
      )}
    </div>
  )
}
