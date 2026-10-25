// Dashboards: the saved spec, plus the pure logic shared by the editor and viewer —
// aggregation, cross-object selections, grid layout and a suggested starting layout.
import type { Cell, ColumnSchema } from './types'

export type Agg = 'count' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'distinct'
export interface Measure { agg: Agg; field?: string }
export type ChartKind = 'bar' | 'hbar' | 'line' | 'area' | 'scatter' | 'donut' | 'heatmap'
export type TimeUnit = 'year' | 'yearquarter' | 'yearmonth' | 'yearweek' | 'yearmonthdate'
export type NumberFormat = 'auto' | 'number' | 'currency' | 'percent'
/** Position on the 12-column grid, in grid cells. */
export interface Box { x: number; y: number; w: number; h: number }

/** A filter condition, in the same form as a workflow's Filter step. */
export interface Condition { column: string; operator: string; value?: unknown; keep_blanks?: boolean }
/** Rows an object is limited to before anything else (interactions narrow it further). */
export interface WidgetFilter { match: 'all' | 'any'; conditions: Condition[] }
interface WidgetBase {
  id: string; title: string; box: Box
  filter?: WidgetFilter
  /** Show the data source and filters under the object (on unless turned off). */
  caption?: boolean
}
export interface HeadlineWidget extends WidgetBase {
  type: 'headline'; measure: Measure; format?: NumberFormat; prefix?: string; suffix?: string
}
export interface ChartWidget extends WidgetBase {
  type: 'chart'; chart: ChartKind
  /** Categories / along the x axis (slices for a donut, columns for a heatmap). */
  x?: string
  /** The value. For a scatter, its field is plotted as-is. */
  y: Measure
  /** Split by: stacked/grouped series, line series, point colour, or a heatmap's rows. */
  color?: string
  timeUnit?: TimeUnit
  sort?: 'value' | 'label'
  /** Keep only the top N categories by value. */
  top?: number
  /** Which field a click selects, when other objects listen to this chart. */
  selectBy?: string
  /** Hand-edited Vega-Lite spec that replaces the generated one. */
  vegaLite?: Record<string, unknown>
}
export interface TableWidget extends WidgetBase {
  type: 'table'; mode: 'rows' | 'summary' | 'pivot'
  columns: string[]
  /** Summary: one row per combination. Pivot: the row fields. */
  groupBy: string[]; measures: Measure[]
  sortBy?: string; sortDesc?: boolean; limit: number
  selectBy?: string
  /** Pivot: the field spread across columns, the value in each cell, and how many columns to show. */
  pivotColumn?: string; pivotValue?: Measure; pivotTop?: number
  /** Pivot: date bucket for date fields (unset = picked from the data's time span). */
  timeUnit?: TimeUnit
  totals?: boolean; heat?: boolean
}
export type Widget = HeadlineWidget | ChartWidget | TableWidget
export type WidgetType = Widget['type']
export type Effect = 'filter' | 'highlight'
export interface DashLink { id: string; source: string; target: string; effect: Effect }
export interface DashboardSpec {
  widgets: Widget[]; links: DashLink[]
  /** Show the dashboard's name and description as a title block above the objects (on unless turned off). */
  showTitle?: boolean
}
export interface Dashboard {
  id: string; name: string; description: string; dataset: string; spec: DashboardSpec
  created_at: string; updated_at: string; dataset_label: string | null; dataset_kind: string | null
}

export type ColType = ColumnSchema['type']
export type Row = Record<string, unknown>
export interface DashData {
  label: string; columns: ColumnSchema[]; rows: Cell[][]; row_count: number; truncated: boolean; warnings: string[]
  /** The file the rows were read from, its sheet, and when. */
  file?: string; sheet?: string; read_at?: string
}

export const GRID_COLS = 12
export const newId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`

// ---------------------------------------------------------------- data

/** Rows as objects, with date columns turned into Date values for charting and range filters. */
export function toRows(d: DashData): Row[] {
  const names = d.columns.map((c) => c.name)
  const dates = d.columns.map((c) => c.type === 'date')
  return d.rows.map((r) => {
    const o: Row = {}
    for (let i = 0; i < names.length; i++) o[names[i]] = dates[i] && r[i] != null ? new Date(String(r[i])) : r[i]
    return o
  })
}

export const isNumeric = (t?: ColType) => t === 'integer' || t === 'number'
export const isCategory = (t?: ColType) => t === 'text' || t === 'boolean'

const num = (v: unknown) => (typeof v === 'number' ? v : v instanceof Date ? +v : null)

export function aggregate(rows: Row[], m: Measure): number | null {
  if (m.agg === 'count') return rows.length
  const f = m.field!
  if (m.agg === 'distinct') return new Set(rows.map((r) => norm(r[f])).filter((v) => v != null)).size
  const vals: number[] = []
  for (const r of rows) { const v = num(r[f]); if (v != null && !Number.isNaN(v)) vals.push(v) }
  if (!vals.length) return m.agg === 'sum' ? 0 : null
  switch (m.agg) {
    case 'sum': return vals.reduce((a, b) => a + b, 0)
    case 'mean': return vals.reduce((a, b) => a + b, 0) / vals.length
    case 'min': return Math.min(...vals)
    case 'max': return Math.max(...vals)
    case 'median': {
      const s = vals.sort((a, b) => a - b)
      const mid = s.length >> 1
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
    }
  }
}

export const AGG_LABEL: Record<Agg, string> = {
  count: 'Count of rows', sum: 'Sum', mean: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', distinct: 'Distinct count',
}
export function measureLabel(m: Measure) {
  if (m.agg === 'count') return 'Rows'
  if (m.agg === 'distinct') return `Distinct ${m.field}`
  return `${m.agg === 'sum' ? 'Total' : AGG_LABEL[m.agg]} ${m.field}`
}
/** Aggregations that add up across parts, so "x of total" makes sense. */
export const additive = (m: Measure) => m.agg === 'count' || m.agg === 'sum'

export function fmtValue(v: number | null, format: NumberFormat = 'auto', compact = true): string {
  if (v == null || Number.isNaN(v)) return '—'
  if (format === 'percent') return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
  const big = Math.abs(v) >= 10_000
  const opts: Intl.NumberFormatOptions = compact && big
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1 }
  const s = v.toLocaleString(undefined, opts)
  return format === 'currency' ? `$${s}` : s
}

/** Summary-table rows: one per group, with one value per measure. */
export function groupRows(rows: Row[], groupBy: string[], measures: Measure[]): Row[] {
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const key = JSON.stringify(groupBy.map((g) => norm(r[g])))
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(r)
  }
  return [...groups.values()].map((g) => {
    const o: Row = {}
    for (const f of groupBy) o[f] = g[0][f]
    measures.forEach((m) => { o[measureLabel(m)] = aggregate(g, m) })
    return o
  })
}

// ---------------------------------------------------------------- object filters
// Same rules as the workflow executor's Filter step (backend/app/transformations/executor.py), so a
// condition means the same thing on a dashboard as in a workflow.

/** A date as the filter UI shows and stores it: YYYY-MM-DD (plus the time when it isn't midnight), local time. */
export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return d.getHours() || d.getMinutes() || d.getSeconds() ? `${day}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : day
}
function parseDate(v: unknown): number {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  return m ? +new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN
}
const isBlankCell = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')

function coerce(v: unknown, t?: ColType): number | string | boolean | null {
  if (v == null) return null
  if (isNumeric(t)) return Number(v)
  if (t === 'date') return parseDate(v)
  if (t === 'boolean') return ['true', 'yes', '1'].includes(String(v).trim().toLowerCase())
  return String(v)
}
const comparable = (v: unknown) => (v instanceof Date ? +v : v ?? null)

export function conditionMatches(row: Row, c: Condition, t?: ColType): boolean {
  const cell = row[c.column]
  const blank = isBlankCell(cell)
  const op = c.operator
  if (op === 'is_blank') return blank
  if (op === 'not_blank') return !blank
  if (op === 'in' || op === 'not_in') {
    const vals = Array.isArray(c.value) ? c.value : [c.value]
    const picked = vals.filter((v) => v != null).map((v) => coerce(v, t))
    // Text (and mixed) columns match on the text form, as the values were picked from it.
    const text = !isNumeric(t) && t !== 'date' && t !== 'boolean'
    const cv = text ? (cell == null ? null : String(cell)) : comparable(cell)
    let m = cv != null && picked.some((p) => (text ? String(p) === cv : p === cv))
    if (picked.length < vals.length) m = m || blank
    return op === 'in' ? m : !m
  }
  if (op === 'between') {
    const [lo, hi] = Array.isArray(c.value) ? [...c.value, null, null] : [null, null]
    const v = comparable(cell)
    let m = true
    if (lo != null && lo !== '') m = m && v != null && (v as number) >= (coerce(lo, t) as number)
    if (hi != null && hi !== '') m = m && v != null && (v as number) <= (coerce(hi, t) as number)
    return m || (!!c.keep_blanks && blank)
  }
  if (op === 'contains' || op === 'not_contains' || op === 'starts_with') {
    const txt = (cell == null ? '' : cell instanceof Date ? dateKey(cell) : String(cell)).toLowerCase()
    const needle = String(c.value ?? '').toLowerCase()
    if (op === 'starts_with') return txt.startsWith(needle)
    return txt.includes(needle) === (op === 'contains')
  }
  const want = coerce(c.value, t)
  const textual = typeof want === 'string' && !isNumeric(t) && t !== 'date'
  const lhs = textual ? (cell == null ? null : String(cell).trim().toLowerCase()) : comparable(cell)
  const rhs = textual ? (want as string).trim().toLowerCase() : want
  if (op === 'ne') return lhs !== rhs
  if (lhs == null || rhs == null) return false
  switch (op) {
    case 'eq': return lhs === rhs
    case 'gt': return lhs > rhs
    case 'ge': return lhs >= rhs
    case 'lt': return lhs < rhs
    case 'le': return lhs <= rhs
  }
  return true
}

/** Conditions that actually narrow something (an untouched "all values" condition doesn't). */
export function activeConditions(f: WidgetFilter | undefined): Condition[] {
  return (f?.conditions ?? []).filter((c) => {
    if (!c.column) return false
    if (c.operator === 'not_in') return Array.isArray(c.value) && c.value.length > 0
    if (c.operator === 'between') return Array.isArray(c.value) && c.value.some((v) => v != null && v !== '')
    if (['contains', 'not_contains', 'starts_with'].includes(c.operator)) return String(c.value ?? '') !== ''
    return true
  })
}

export function applyFilter(rows: Row[], f: WidgetFilter | undefined, types: Record<string, ColType>): Row[] {
  const conds = activeConditions(f)
  if (!conds.length) return rows
  return f!.match === 'any'
    ? rows.filter((r) => conds.some((c) => conditionMatches(r, c, types[c.column])))
    : rows.filter((r) => conds.every((c) => conditionMatches(r, c, types[c.column])))
}

/** Values and range of a column, for the filter editor (the same shape the workflow studio loads from the server). */
export function columnValues(rows: Row[], column: string, type: ColType) {
  const counts = new Map<string, { value: Cell; count: number }>()
  let nulls = 0, lo = Infinity, hi = -Infinity
  for (const r of rows) {
    const v = r[column]
    if (isBlankCell(v)) { nulls++; continue }
    const cell: Cell = v instanceof Date ? dateKey(v) : (v as Cell)
    const n = v instanceof Date ? +v : typeof v === 'number' ? v : null
    if (n != null) { lo = Math.min(lo, n); hi = Math.max(hi, n) }
    const k = String(cell)
    const e = counts.get(k)
    if (e) e.count++
    else counts.set(k, { value: cell, count: 1 })
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count)
  const out: { type: string; count: number; nulls: number; distinct: number; truncated: boolean; values: { value: Cell; count: number }[]; min?: number | string; max?: number | string } =
    { type, count: rows.length, nulls, distinct: all.length, truncated: all.length > 1000, values: all.slice(0, 1000) }
  if (lo <= hi) {
    out.min = type === 'date' ? dateKey(new Date(lo)).slice(0, 10) : lo
    out.max = type === 'date' ? dateKey(new Date(hi)).slice(0, 10) : hi
  }
  return out
}

/** Filter expressions inside a hand-written Vega-Lite spec, for the object's caption. */
export function vegaLiteFilters(spec: unknown): string[] {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (k === 'transform' && Array.isArray(v)) {
          for (const t of v) if (t && typeof t === 'object' && 'filter' in t && typeof (t as { filter: unknown }).filter === 'string') out.push((t as { filter: string }).filter.replace(/datum\./g, ''))
        }
        walk(v)
      }
    }
  }
  walk(spec)
  return out
}

// ---------------------------------------------------------------- selections

/** What a viewer picked in an object: clicked values, or a dragged range (per field). */
export type Sel =
  | { kind: 'point'; tuples: Record<string, unknown>[] }
  | { kind: 'interval'; ranges: Record<string, [number, number]> }

/** Comparable form of a value: dates by time, everything else as-is. */
/** A date bucket picked in a pivot (e.g. "Mar 2026"): matches dates from start (inclusive) to end (exclusive). */
export interface RangeValue { range: [number, number]; label: string }
export const isRange = (v: unknown): v is RangeValue =>
  !!v && typeof v === 'object' && !(v instanceof Date) && Array.isArray((v as RangeValue).range)

/** Comparable form of a value: dates by time, date buckets by their span, everything else as-is. */
export const norm = (v: unknown) => (v instanceof Date ? +v : isRange(v) ? `${v.range[0]}~${v.range[1]}` : v ?? null)

function valueMatches(cell: unknown, v: unknown) {
  if (!isRange(v)) return norm(cell) === norm(v)
  const n = num(cell)
  return n != null && n >= v.range[0] && n < v.range[1]
}

export function matches(row: Row, sel: Sel): boolean {
  if (sel.kind === 'point') return sel.tuples.some((t) => Object.entries(t).every(([f, v]) => valueMatches(row[f], v)))
  return Object.entries(sel.ranges).every(([f, [a, b]]) => {
    const v = num(row[f])
    return v != null && v >= Math.min(a, b) && v <= Math.max(a, b)
  })
}

export const selIsEmpty = (s: Sel | null | undefined) =>
  !s || (s.kind === 'point' ? s.tuples.length === 0 : Object.keys(s.ranges).length === 0)

export function describeSel(sel: Sel): string {
  if (sel.kind === 'point') {
    // Picks can mix shapes (a pivot cell, a row, a column), so only name the fields when they all agree.
    const sig = (t: Record<string, unknown>) => Object.keys(t).join(' · ')
    const same = sel.tuples.every((t) => sig(t) === sig(sel.tuples[0]))
    const vals = sel.tuples.map((t) => Object.values(t).map(fmtCell).join(' · '))
    const list = vals.length > 3 ? `${vals.slice(0, 2).join(', ')} +${vals.length - 2}` : vals.join(', ')
    return same ? `${sig(sel.tuples[0])} = ${list}` : list
  }
  return Object.entries(sel.ranges).map(([f, [a, b]]) => {
    const isTime = Math.abs(a) > 1e11  // epoch milliseconds
    const show = (v: number) => (isTime ? new Date(v).toLocaleDateString() : fmtValue(v))
    return `${f.replace(/^(year|quarter|month|week|date)+_/, '')} ${show(Math.min(a, b))} – ${show(Math.max(a, b))}`
  }).join(', ')
}

export function fmtCell(v: unknown): string {
  if (v == null) return '(blank)'
  if (isRange(v)) return v.label
  if (v instanceof Date) return v.toLocaleDateString()
  if (typeof v === 'number') return fmtValue(v, 'auto', false)
  return String(v)
}

/** Charts that can show a highlighted part on top of the whole; the rest can only be filtered. */
export const canHighlight = (w: Widget) =>
  w.type === 'table' || w.type === 'headline' || (w.type === 'chart' && !w.vegaLite && ['bar', 'hbar', 'line', 'area', 'scatter'].includes(w.chart))
/** Objects a viewer can click to drive others. */
export const canDrive = (w: Widget) => w.type !== 'headline'

/** Fields a click on this object can select by. */
export function selectableFields(w: Widget, types: Record<string, ColType>): string[] {
  if (w.type === 'table') {
    const cols = w.mode === 'pivot' ? [...w.groupBy, ...(w.pivotColumn ? [w.pivotColumn] : [])] : w.mode === 'summary' ? w.groupBy : w.columns
    return cols.filter((c) => types[c] && types[c] !== 'empty')
  }
  if (w.type !== 'chart') return []
  return [w.x, w.color].filter((f): f is string => !!f && isCategory(types[f]))
}

export function defaultSelectBy(w: Widget, types: Record<string, ColType>): string | undefined {
  const opts = selectableFields(w, types)
  const pick = (w.type === 'chart' || w.type === 'table') ? w.selectBy : undefined
  return pick && opts.includes(pick) ? pick : opts.find((c) => isCategory(types[c])) ?? opts[0]
}

/** In plain words, what a viewer does in this object to drive others. */
export function gestureText(w: Widget, types: Record<string, ColType>): string {
  if (w.type === 'table') return w.mode === 'pivot' ? 'clicks a cell or heading in' : 'clicks a row in'
  if (w.type !== 'chart') return ''
  if (w.vegaLite) return 'selects in'
  const t = w.x ? types[w.x] : undefined
  if (w.chart === 'scatter') return 'drags across points in'
  if ((w.chart === 'line' || w.chart === 'area' || w.chart === 'bar' || w.chart === 'hbar') && (t === 'date' || isNumeric(t))) return 'drags across a range in'
  return { bar: 'clicks a bar in', hbar: 'clicks a bar in', donut: 'clicks a slice in', heatmap: 'clicks a cell in', line: 'clicks a point in', area: 'clicks a point in', scatter: '' }[w.chart]
}

// ---------------------------------------------------------------- pivot

/** The date bucket a date falls in, in local time. */
export function bucket(d: Date, unit: TimeUnit): RangeValue {
  const y = d.getFullYear(), m = d.getMonth()
  let a: Date, b: Date, label: string
  switch (unit) {
    case 'year': a = new Date(y, 0, 1); b = new Date(y + 1, 0, 1); label = String(y); break
    case 'yearquarter': { const q = Math.floor(m / 3); a = new Date(y, q * 3, 1); b = new Date(y, q * 3 + 3, 1); label = `Q${q + 1} ${y}`; break }
    case 'yearmonth': a = new Date(y, m, 1); b = new Date(y, m + 1, 1); label = a.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); break
    case 'yearweek': {
      const back = (d.getDay() + 6) % 7   // weeks start on Monday
      a = new Date(y, m, d.getDate() - back); b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7)
      label = `Wk of ${a.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      break
    }
    default: a = new Date(y, m, d.getDate()); b = new Date(y, m, d.getDate() + 1); label = a.toLocaleDateString()
  }
  return { range: [+a, +b], label }
}

/** One row or column heading of a pivot: the value it stands for, how it reads, and how it sorts. */
export interface PivotHead { key: string; value: unknown; label: string; sort: number | string }
export interface PivotRow {
  key: string; heads: PivotHead[]; cells: Record<string, number | null>; total: number | null
  /** Columns whose cell contains highlighted rows, and whether the row has any. */
  hl: Set<string>; hlAny: boolean
}
export interface Pivot {
  cols: PivotHead[]; rows: PivotRow[]; colTotals: Record<string, number | null>; grand: number | null
  /** How many columns were folded into the "Other"/"Earlier" column. */
  folded: number; colHl: Set<string>
}
/** Column key for the folded-together remainder. */
export const PIVOT_OTHER = '\u0000other'

function headOf(v: unknown, unit: TimeUnit): PivotHead {
  if (v == null || v === '') return { key: '\u0000blank', value: null, label: '(blank)', sort: '\uffff' }
  if (v instanceof Date) { const b = bucket(v, unit); return { key: `d${b.range[0]}`, value: b, label: b.label, sort: b.range[0] } }
  if (typeof v === 'number') return { key: `n${v}`, value: v, label: fmtValue(v, 'auto', false), sort: v }
  return { key: `s${String(v)}`, value: v, label: String(v), sort: String(v).toLowerCase() }
}

export const compareHeads = (a: PivotHead, b: PivotHead) =>
  typeof a.sort === 'number' && typeof b.sort === 'number' ? a.sort - b.sort : String(a.sort).localeCompare(String(b.sort), undefined, { numeric: true })

/** Fields whose values have a natural order (dates, numbers): kept in that order rather than ranked by value. */
const ordered = (t?: ColType) => t === 'date' || isNumeric(t)

/** Cross-tabulate: one row per combination of row fields, one column per value of the column field.
 *  Every figure, totals included, is aggregated from the underlying rows, so averages and distinct counts stay right. */
export function pivotTable(rows: Row[], rowFields: string[], colField: string | undefined, m: Measure, opts: {
  types: Record<string, ColType>; top: number; unit: (field: string) => TimeUnit; highlight?: ((r: Row) => boolean) | null
}): Pivot {
  const { types, highlight } = opts
  const colKey: string[] = new Array(rows.length)
  const colHeads = new Map<string, PivotHead>()
  const colRows = new Map<string, Row[]>()
  if (colField) {
    const unit = opts.unit(colField)
    rows.forEach((r, i) => {
      const h = headOf(r[colField], unit)
      colKey[i] = h.key
      if (!colHeads.has(h.key)) { colHeads.set(h.key, h); colRows.set(h.key, []) }
      colRows.get(h.key)!.push(r)
    })
  }
  const totals = new Map([...colRows].map(([k, rs]) => [k, aggregate(rs, m)]))
  const byTotal = (a: PivotHead, b: PivotHead) => (totals.get(b.key) ?? -Infinity) - (totals.get(a.key) ?? -Infinity)
  const isOrdered = ordered(colField ? types[colField] : undefined)
  let cols = [...colHeads.values()].sort(isOrdered ? compareHeads : byTotal)
  let folded = 0
  if (cols.length > opts.top) {
    // Categories keep the biggest; dates and numbers keep the latest / highest and fold the rest at the start.
    const keep = isOrdered ? cols.slice(-opts.top) : cols.slice(0, opts.top)
    const kept = new Set(keep.map((c) => c.key))
    folded = cols.length - keep.length
    const rest: Row[] = []
    rows.forEach((r, i) => { if (!kept.has(colKey[i])) { colKey[i] = PIVOT_OTHER; rest.push(r) } })
    const other: PivotHead = { key: PIVOT_OTHER, value: null, label: isOrdered ? `Earlier (${folded})` : `Other (${folded})`, sort: 0 }
    cols = isOrdered ? [other, ...keep] : [...keep, other]
    totals.set(PIVOT_OTHER, aggregate(rest, m))
    colRows.set(PIVOT_OTHER, rest)
  }

  const units = rowFields.map((f) => opts.unit(f))
  const groups = new Map<string, { heads: PivotHead[]; idx: number[] }>()
  rows.forEach((r, i) => {
    const heads = rowFields.map((f, j) => headOf(r[f], units[j]))
    const key = heads.map((h) => h.key).join('\u0001')
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { heads, idx: [] }))
    g.idx.push(i)
  })
  const out: PivotRow[] = [...groups].map(([key, g]) => {
    const byCol = new Map<string, Row[]>()
    for (const i of g.idx) {
      const k = colField ? colKey[i] : ''
      let list = byCol.get(k)
      if (!list) byCol.set(k, (list = []))
      list.push(rows[i])
    }
    const cells: Record<string, number | null> = {}
    const hl = new Set<string>()
    for (const [k, rs] of byCol) {
      cells[k] = aggregate(rs, m)
      if (highlight && rs.some(highlight)) hl.add(k)
    }
    return { key, heads: g.heads, cells, total: aggregate(g.idx.map((i) => rows[i]), m), hl, hlAny: hl.size > 0 }
  })
  // Rows: in their natural order when any row field has one, else biggest total first.
  if (rowFields.some((f) => ordered(types[f]))) {
    out.sort((a, b) => { for (let j = 0; j < a.heads.length; j++) { const c = compareHeads(a.heads[j], b.heads[j]); if (c) return c } return 0 })
  } else out.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity))
  const colHl = new Set<string>()
  if (highlight) for (const [k, rs] of colRows) if (rs.some(highlight)) colHl.add(k)
  return { cols, rows: out, colTotals: Object.fromEntries(totals), grand: aggregate(rows, m), folded, colHl }
}

// ---------------------------------------------------------------- layout

const collide = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Float every object up as far as it goes without overlapping; `pinned` keeps its place and others move around it. */
export function settle(widgets: Widget[], pinned?: { id: string; box: Box }): Widget[] {
  const order = [...widgets].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  const placed: Box[] = pinned ? [pinned.box] : []
  const out = new Map<string, Box>()
  if (pinned) out.set(pinned.id, pinned.box)
  for (const w of order) {
    if (w.id === pinned?.id) continue
    const b = { ...w.box, y: 0 }
    while (placed.some((p) => collide(p, b))) b.y++
    placed.push(b)
    out.set(w.id, b)
  }
  return widgets.map((w) => ({ ...w, box: out.get(w.id)! }))
}

/** The first free spot for a w×h box, scanning top to bottom, left to right. */
export function freeSpot(widgets: Widget[], w: number, h: number): Box {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const b = { x, y, w, h }
      if (!widgets.some((o) => collide(o.box, b))) return b
    }
  }
}

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  headline: { w: 3, h: 3 }, chart: { w: 6, h: 8 }, table: { w: 6, h: 8 },
}

// ---------------------------------------------------------------- new objects

/** Numbers worth adding up or averaging (not ids, codes or row numbers). */
/** Column names that identify rows rather than measure or group them. */
const ID_LIKE = /(^|\b|_)(id|no|number|code|key)$/i
export const valueColumns = (columns: ColumnSchema[]) =>
  columns.filter((c) => isNumeric(c.type) && !ID_LIKE.test(c.name)).map((c) => c.name)
/** Amounts add up; prices, rates and scores only make sense averaged. */
export const measureOf = (field: string): Measure =>
  ({ agg: /price|rate|ratio|percent|pct|score|avg|average|age|margin/i.test(field) ? 'mean' : 'sum', field })
/** The value a new object shows first: the first amount, else the first number, else a row count. */
export function defaultMeasure(columns: ColumnSchema[]): Measure {
  const nums = valueColumns(columns)
  const amount = nums.find((f) => measureOf(f).agg === 'sum')
  return amount ? measureOf(amount) : nums[0] ? measureOf(nums[0]) : { agg: 'count' }
}

export function newWidget(type: WidgetType, columns: ColumnSchema[], box: Box): Widget {
  const cats = columns.filter((c) => isCategory(c.type)).map((c) => c.name)
  const dates = columns.filter((c) => c.type === 'date').map((c) => c.name)
  const value = defaultMeasure(columns)
  const id = newId(type[0])
  if (type === 'headline') return { id, type, box, title: measureLabel(value), measure: value }
  if (type === 'chart') {
    const x = cats[0] ?? dates[0] ?? columns[0]?.name
    const chart: ChartKind = cats[0] ? 'bar' : dates[0] ? 'line' : 'bar'
    return { id, type, box, chart, x, y: value, title: x ? `${measureLabel(value)} by ${x}` : measureLabel(value), sort: 'value', top: cats[0] ? 12 : undefined }
  }
  return { id, type, box, title: 'Details', mode: 'rows', columns: columns.slice(0, 6).map((c) => c.name), groupBy: [], measures: [], limit: 200 }
}

/** A date bucket that gives a trend a sensible number of points for the data's time span. */
export function timeUnitFor(rows: Row[], field: string): TimeUnit {
  let lo = Infinity, hi = -Infinity
  for (const r of rows) { const v = r[field]; if (v instanceof Date) { lo = Math.min(lo, +v); hi = Math.max(hi, +v) } }
  const days = hi > lo ? (hi - lo) / 86_400_000 : 0
  return days <= 45 ? 'yearmonthdate' : days <= 200 ? 'yearweek' : days <= 1100 ? 'yearmonth' : 'yearquarter'
}

/** A date bucket for pivot headings: coarser than a chart's, so a cross-tab stays around a dozen columns wide. */
export function pivotUnitFor(rows: Row[], field: string): TimeUnit {
  let lo = Infinity, hi = -Infinity
  for (const r of rows) { const v = r[field]; if (v instanceof Date) { lo = Math.min(lo, +v); hi = Math.max(hi, +v) } }
  const days = hi > lo ? (hi - lo) / 86_400_000 : 0
  return days <= 14 ? 'yearmonthdate' : days <= 90 ? 'yearweek' : days <= 730 ? 'yearmonth' : days <= 3650 ? 'yearquarter' : 'year'
}

/** A sensible first dashboard for a dataset: a few headlines, a trend, a breakdown and the detail rows. */
/** Text columns worth slicing by (2–40 distinct values in a sample), fewest values first, with their counts. */
export function rankCategories(columns: ColumnSchema[], rows: Row[]): { field: string; distinct: number }[] {
  const sample = rows.slice(0, 5000)
  // Text codes like "Product ID" can be good categories in a sales table; only one-per-row values are excluded.
  return columns.filter((c) => isCategory(c.type))
    .map((c) => ({ field: c.name, distinct: new Set(sample.map((r) => norm(r[c.name]))).size }))
    // A column with a different value on every row is an identifier, not a category.
    .filter((c) => c.distinct >= 2 && c.distinct <= 40 && !(sample.length >= 3 && c.distinct === sample.length))
    .sort((a, b) => a.distinct - b.distinct)
}

/** "Region" → "Regions", "Category" → "Categories", "Branch" → "Branches". */
export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  return `${word}s`
}

export function suggestLayout(columns: ColumnSchema[], rows: Row[]): DashboardSpec {
  const nums = valueColumns(columns)
  const cats = rankCategories(columns, rows).map((c) => c.field)
  const date = columns.find((c) => c.type === 'date')?.name
  const value = defaultMeasure(columns)
  const widgets: Widget[] = []

  const heads: Measure[] = [{ agg: 'count' }, ...nums.slice(0, 2).map(measureOf)]
  if (cats[0]) heads.push({ agg: 'distinct', field: cats[0] })
  const hw = Math.floor(GRID_COLS / heads.length)
  heads.forEach((m, i) => widgets.push({
    id: newId('h'), type: 'headline', title: m.agg === 'count' ? 'Rows' : m.agg === 'distinct' ? plural(m.field!) : measureLabel(m),
    measure: m, box: { x: i * hw, y: 0, w: i === heads.length - 1 ? GRID_COLS - i * hw : hw, h: 3 },
  }))
  let y = 3
  const charts: ChartWidget[] = []
  if (date) charts.push({ id: newId('c'), type: 'chart', chart: 'line', x: date, timeUnit: timeUnitFor(rows, date), y: value, title: `${measureLabel(value)} over time`, box: { x: 0, y, w: 6, h: 8 } })
  if (cats[0]) charts.push({ id: newId('c'), type: 'chart', chart: 'bar', x: cats[0], y: value, sort: 'value', top: 12, title: `${measureLabel(value)} by ${cats[0]}`, box: { x: 6, y, w: 6, h: 8 } })
  if (cats[1] && charts.length < 2) charts.push({ id: newId('c'), type: 'chart', chart: 'donut', x: cats[1], y: value, top: 8, title: `Share by ${cats[1]}`, box: { x: 0, y, w: 6, h: 8 } })
  charts.forEach((c, i) => { c.box = { x: charts.length === 1 ? 0 : i * 6, y, w: charts.length === 1 ? 12 : 6, h: 8 } })
  widgets.push(...charts)
  if (charts.length) y += 8
  // A cross-tab when there are two ways to slice the data: the main category down, time (or a second category) across.
  const across = date ?? cats[1]
  if (cats[0] && across) {
    widgets.push({
      id: newId('t'), type: 'table', mode: 'pivot', title: `${measureLabel(value)} by ${cats[0]} & ${across}`,
      columns: [], groupBy: [cats[0]], measures: [], pivotColumn: across, pivotValue: value, pivotTop: 12, totals: true, heat: true, limit: 200,
      box: { x: 0, y, w: 12, h: 6 },
    })
    y += 6
  }
  widgets.push({ id: newId('t'), type: 'table', title: 'Details', mode: 'rows', columns: columns.slice(0, 8).map((c) => c.name), groupBy: [], measures: [], limit: 200, box: { x: 0, y, w: 12, h: 8 } })
  return { widgets, links: [] }
}
