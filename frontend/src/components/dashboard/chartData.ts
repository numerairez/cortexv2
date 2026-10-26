// What a chart is drawn from: its groups already added up, one row per bar, point or cell, rather
// than the whole dataset. Vega keeps its own copy of whatever it is given, so feeding it every row
// cost a full copy of the dataset per chart; totals keep memory flat and redraws after a click cheap.
import { timeFloor } from 'vega-time'
import { aggregate, isNumeric, type ChartWidget, type ColType, type Row, type TimeUnit } from '../../dashboard'

/** The measure, already aggregated for the row's group. */
export const VALUE = '__v'
/** The category's value across every series, so "sort by value" ranks categories as a whole. */
export const RANK = '__rank'
/** Marks a row of the highlighted part; a highlighted chart draws the whole with the part on top. */
export const PART = '__part'
/** Scatter plots draw individual rows; beyond this many, an even sample of them. */
export const MAX_POINTS = 5000

/** Vega-Lite's time units as Vega's floor units, so buckets match what the chart's axis shows. */
const UNITS: Record<TimeUnit, string[]> = {
  year: ['year'], yearquarter: ['year', 'quarter'], yearmonth: ['year', 'month'],
  yearweek: ['year', 'week'], yearmonthdate: ['year', 'month', 'date'],
}

export interface ChartData {
  rows: Row[]
  /** Set when a scatter shows a sample of its points. */
  sampled?: { shown: number; of: number }
}

/** Whether a chart is drawn from totals (otherwise from rows: scatter plots and hand-written specs). */
export const preAggregated = (w: ChartWidget) => !w.vegaLite && w.chart !== 'scatter'

/**
 * @param highlight When another object highlights this chart: which rows form the highlighted part
 *   (`null` while nothing is picked, so the part is everything). Omit when nothing can highlight it.
 */
export function chartData(w: ChartWidget, rows: Row[], types: Record<string, ColType>,
  highlight?: ((r: Row) => boolean) | null): ChartData {
  if (w.vegaLite) return { rows }
  const layered = highlight !== undefined
  const inPart = highlight ?? (() => true)
  if (w.chart === 'scatter') return scatterPoints(w, rows, layered ? inPart : null)
  if (!w.x) return { rows: [] }

  const x = w.x
  const series = w.chart === 'donut' ? undefined : w.color
  const xt = types[x]
  const floor = xt === 'date' ? timeFloor(UNITS[w.timeUnit ?? 'yearmonth']) : null
  // Continuous axes drop blanks, as Vega-Lite does; a blank category is still a category.
  const dropBlankX = xt === 'date' || isNumeric(xt)
  const xOf = (r: Row) => {
    const v = r[x]
    return floor && v instanceof Date ? floor(v) : v
  }
  const keyOf = (v: unknown) => (v instanceof Date ? `d${+v}` : JSON.stringify(v ?? null))

  // Each category's rows across all series: its rank, and which categories make the top N.
  const byX = new Map<string, { x: unknown; rows: Row[] }>()
  for (const r of rows) {
    const xv = xOf(r)
    if (dropBlankX && xv == null) continue
    const k = keyOf(xv)
    const g = byX.get(k)
    if (g) g.rows.push(r)
    else byX.set(k, { x: xv, rows: [r] })
  }
  const rank = new Map([...byX].map(([k, g]) => [k, aggregate(g.rows, w.y)]))
  if (w.top && !dropBlankX && w.chart !== 'heatmap') {
    // Dense rank: categories tied on value share a place, as Vega's dense_rank does.
    const kept = new Set([...new Set(rank.values())].filter((v): v is number => v != null).sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(w.top))))
    for (const [k, v] of rank) if (v == null || !kept.has(v)) byX.delete(k)
  }

  // Behind a highlight, a bar chart's whole is one grey bar per category; lines keep a grey line per series.
  const unsplitWhole = w.chart === 'bar' || w.chart === 'hbar'
  const out: Row[] = []
  const emit = (part: boolean | null) => {
    const split = series && !(part === false && unsplitWhole)
    for (const [k, g] of byX) {
      const groupRows = part ? g.rows.filter(inPart) : g.rows
      const groups = new Map<string, { s: unknown; rows: Row[] }>()
      if (split) {
        for (const r of groupRows) {
          const sk = keyOf(r[series])
          const sg = groups.get(sk)
          if (sg) sg.rows.push(r)
          else groups.set(sk, { s: r[series], rows: [r] })
        }
      } else if (groupRows.length || !part) {
        groups.set('', { s: undefined, rows: groupRows })
      }
      for (const sg of groups.values()) {
        const o: Row = { [x]: g.x, [VALUE]: aggregate(sg.rows, w.y), [RANK]: rank.get(k) }
        if (split) o[series] = sg.s
        if (part !== null) o[PART] = part
        out.push(o)
      }
    }
  }
  emit(layered ? false : null)
  if (layered) emit(true)
  return { rows: out }
}

/** The rows a scatter plot needs, cut down to its own fields and, past MAX_POINTS, sampled evenly. */
function scatterPoints(w: ChartWidget, rows: Row[], inPart: ((r: Row) => boolean) | null): ChartData {
  const fields = [w.x, w.y.field, w.color].filter((f): f is string => !!f)
  const step = rows.length > MAX_POINTS ? rows.length / MAX_POINTS : 1
  const n = Math.min(rows.length, MAX_POINTS)
  const out: Row[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = rows[Math.floor(i * step)]
    const o: Row = {}
    for (const f of fields) o[f] = r[f]
    if (inPart) o[PART] = inPart(r)
    out[i] = o
  }
  return { rows: out, sampled: step > 1 ? { shown: n, of: rows.length } : undefined }
}
