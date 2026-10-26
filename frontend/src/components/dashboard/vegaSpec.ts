// Turns a dashboard chart into a Vega-Lite spec: the chart itself, a selection when other
// objects listen to it, and a dimmed "whole vs highlighted part" overlay when it is highlighted.
import { canHighlight, isCategory, isNumeric, measureLabel, type ChartWidget, type ColType, type Measure, type Sel } from '../../dashboard'
import { PART, RANK, VALUE, preAggregated } from './chartData'

/** Data the chart is fed at run time (rows are pushed in by name, never inlined). Built charts other than
 *  scatter plots are fed totals from `chartData`, so their encodings read the value instead of aggregating. */
export const DATA_NAME = 'table'
/** Selection parameter name; a hand-written spec can declare one with this name to drive other objects. */
export const SEL = 'sel'

/** Categorical slots in fixed order (validated palette), light and dark steps. */
const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}
const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']

export const isDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/** How a click or drag in a chart maps back to data fields. Interval fields follow encoding order. */
export type SelectInfo = { kind: 'point'; fields: string[] } | { kind: 'interval'; fields: string[] }

type Spec = Record<string, any>   // Vega-Lite JSON; validated by the compiler at embed time

/** Escape a column name for a Vega-Lite field reference (dots and brackets mean nesting there). */
const fieldRef = (f: string) => f.replace(/[.[\]\\]/g, '\\$&')

function measureEnc(m: Measure, extra: Spec = {}): Spec {
  return m.agg === 'count'
    ? { aggregate: 'count', type: 'quantitative', title: 'Rows', ...extra }
    : { aggregate: m.agg, field: fieldRef(m.field!), type: 'quantitative', title: measureLabel(m), ...extra }
}

/** A dimension: time (bucketed), number, or category. */
function dimEnc(field: string, t: ColType | undefined, w: ChartWidget, ordinalTime = false): Spec {
  if (t === 'date') return { field: fieldRef(field), type: ordinalTime ? 'ordinal' : 'temporal', timeUnit: w.timeUnit ?? 'yearmonth', title: field }
  if (isNumeric(t) && w.chart !== 'heatmap') return { field: fieldRef(field), type: 'quantitative', title: field }
  return { field: fieldRef(field), type: isNumeric(t) ? 'ordinal' : 'nominal', title: field, axis: { labelLimit: 140 } }
}

export function selectInfo(w: ChartWidget, types: Record<string, ColType>, selectBy?: string): SelectInfo | null {
  if (w.vegaLite) {
    const p = (w.vegaLite.params as Spec[] | undefined)?.find((x) => x?.name === SEL)
    if (!p) return null
    const s = typeof p.select === 'string' ? { type: p.select } : p.select ?? {}
    return { kind: s.type === 'interval' ? 'interval' : 'point', fields: s.fields ?? [] }
  }
  const xt = w.x ? types[w.x] : undefined
  const continuousX = xt === 'date' || isNumeric(xt)
  if (w.chart === 'scatter') return w.x && w.y.field ? { kind: 'interval', fields: [w.x, w.y.field] } : null
  if (w.chart === 'heatmap') {
    const fields = [xt === 'date' ? undefined : w.x, w.color].filter((f): f is string => !!f)
    return fields.length ? { kind: 'point', fields } : null
  }
  if (['bar', 'hbar', 'line', 'area'].includes(w.chart) && continuousX && w.x) return { kind: 'interval', fields: [w.x] }
  const field = selectBy && [w.x, w.color].includes(selectBy) ? selectBy : [w.x, w.color].find((f) => f && isCategory(types[f]))
  return field ? { kind: 'point', fields: [field] } : null
}

/** Read the selection parameter's value back into a dashboard selection. */
export function readSelection(value: any, info: SelectInfo): Sel | null {
  if (!value || typeof value !== 'object') return null
  if (info.kind === 'point') {
    const tuples = (value.vlPoint?.or ?? []) as Record<string, unknown>[]
    return tuples.length ? { kind: 'point', tuples } : null
  }
  const ranges: Record<string, [number, number]> = {}
  Object.entries(value).forEach(([k, v], i) => {
    if (Array.isArray(v) && v.length === 2) {
      const [a, b] = v.map((x) => (x instanceof Date ? +x : Number(x)))
      ranges[info.fields[i] ?? k] = [a, b]
    }
  })
  return Object.keys(ranges).length ? { kind: 'interval', ranges } : null
}

export interface BuildContext {
  types: Record<string, ColType>
  /** Other objects listen to this chart: add a selection. */
  drive: boolean
  selectBy?: string
  /** Something can highlight part of this chart: draw the whole dimmed under the highlighted part. */
  highlight: boolean
}

export function buildSpec(w: ChartWidget, ctx: BuildContext): { spec: Spec; select: SelectInfo | null } {
  const select = ctx.drive ? selectInfo(w, ctx.types, ctx.selectBy) : null
  if (w.vegaLite) {
    const { data: _data, datasets: _ds, ...rest } = w.vegaLite as Spec
    return { spec: { ...rest, data: { name: DATA_NAME } }, select }
  }
  const dark = isDark()
  const palette = CATEGORICAL[dark ? 'dark' : 'light']
  const surface = cssVar('--surface') || (dark ? '#181c22' : '#ffffff')
  // The "whole" behind a highlight: thin marks need a stronger grey than filled bars to stay visible.
  const thin = w.chart === 'line' || w.chart === 'scatter'
  const dim = dark ? (thin ? '#56606e' : '#3a414c') : (thin ? '#b4bcc8' : '#d5dae2')
  const { types } = ctx
  const xt = w.x ? types[w.x] : undefined
  const ct = w.color ? types[w.color] : undefined
  const transform: Spec[] = []
  const colorEnc: Spec | undefined = w.color ? { field: fieldRef(w.color), type: 'nominal', title: w.color, scale: { range: palette } } : undefined
  const tooltip: Spec[] = []
  const pre = preAggregated(w)

  // Top N categories by value, before anything is drawn (totals arrive already cut to the top N).
  if (!pre && w.top && w.x && !(xt === 'date' || isNumeric(xt)) && w.chart !== 'scatter') {
    const op = w.y.agg === 'count' ? { op: 'count' } : { op: w.y.agg, field: fieldRef(w.y.field!) }
    transform.push(
      { joinaggregate: [{ ...op, as: '__v' }], groupby: [fieldRef(w.x)] },
      { window: [{ op: 'dense_rank', as: '__rank' }], sort: [{ field: '__v', order: 'descending' }] },
      { filter: `datum.__rank <= ${Math.max(1, Math.floor(w.top))}` },
    )
  }

  let mark: Spec
  const enc: Spec = {}
  const value = pre
    ? { field: VALUE, type: 'quantitative', title: measureLabel(w.y), format: ',.2~f' }
    : measureEnc(w.y, { format: ',.2~f' })
  switch (w.chart) {
    case 'bar':
    case 'hbar': {
      const horizontal = w.chart === 'hbar'
      const [cat, val] = horizontal ? ['y', 'x'] : ['x', 'y']
      if (w.x) {
        enc[cat] = dimEnc(w.x, xt, w)
        if (enc[cat].type === 'nominal' || enc[cat].type === 'ordinal') {
          enc[cat].sort = w.sort === 'label' ? 'ascending' : pre ? { field: RANK, op: 'max', order: 'descending' } : `-${val}`
          // Tilt category labels only when they no longer fit side by side.
          if (!horizontal) enc[cat].axis = { ...enc[cat].axis, labelAngle: { expr: "width / max(1, length(domain('x'))) < 64 ? -35 : 0" }, labelOverlap: true }
        }
      }
      // One total per bar unless split into series: nothing to stack.
      enc[val] = colorEnc ? value : { ...value, stack: null }
      if (colorEnc) enc.color = colorEnc
      else enc.color = { value: palette[0] }
      mark = { type: 'bar', cornerRadiusEnd: 4, ...(colorEnc ? { stroke: surface, strokeWidth: 1 } : {}) }
      break
    }
    case 'line':
    case 'area': {
      if (w.x) enc.x = dimEnc(w.x, xt, w)
      enc.y = value
      enc.color = colorEnc ?? { value: palette[0] }
      mark = w.chart === 'line'
        ? { type: 'line', strokeWidth: 2, interpolate: 'monotone', point: { filled: true, size: 36 } }
        : { type: 'area', interpolate: 'monotone', line: { strokeWidth: 2 }, fillOpacity: colorEnc ? 0.85 : 0.18 }
      break
    }
    case 'scatter': {
      if (w.x) enc.x = { field: fieldRef(w.x), type: 'quantitative', title: w.x, scale: { zero: false } }
      if (w.y.field) enc.y = { field: fieldRef(w.y.field), type: 'quantitative', title: w.y.field, scale: { zero: false } }
      enc.color = colorEnc ?? { value: palette[0] }
      mark = { type: 'point', filled: true, size: 56, opacity: 0.75, stroke: surface, strokeWidth: 1 }
      break
    }
    case 'donut': {
      enc.theta = { ...value, stack: true }
      if (w.x) enc.color = { field: fieldRef(w.x), type: 'nominal', title: w.x, scale: { range: palette }, legend: { orient: 'right' } }
      enc.order = { field: VALUE, type: 'quantitative', sort: 'descending' }
      mark = { type: 'arc', innerRadius: { expr: 'min(width, height) * 0.26' }, outerRadius: { expr: 'min(width, height) * 0.46' }, stroke: surface, strokeWidth: 2 }
      break
    }
    case 'heatmap': {
      if (w.x) enc.x = dimEnc(w.x, xt, w, true)
      if (w.color) enc.y = dimEnc(w.color, ct, w, true)
      enc.color = { ...value, scale: { range: dark ? [...SEQUENTIAL].reverse() : SEQUENTIAL }, legend: { orient: 'right' } }
      mark = { type: 'rect', cornerRadius: 3, stroke: surface, strokeWidth: 2 }
      break
    }
  }
  // Tooltip: the dimensions first, then the value.
  for (const ch of ['x', 'y', 'color', 'theta']) {
    const e = enc[ch]
    if (e?.field || e?.aggregate) tooltip.push({ field: e.field, aggregate: e.aggregate, type: e.type, timeUnit: e.timeUnit, title: e.title, format: e.type === 'quantitative' ? ',.2~f' : undefined })
  }
  const isValue = (t: Spec) => t.aggregate || t.field === VALUE
  enc.tooltip = [...tooltip.filter((t) => !isValue(t)), ...tooltip.filter(isValue)]
    .map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)))

  const params = select ? [selectionParam(select, w)] : []
  const pointFeedback = select?.kind === 'point' ? { opacity: { condition: { param: SEL, value: 1, empty: true }, value: 0.28 } } : {}
  const base: Spec = { data: { name: DATA_NAME }, transform }

  if (!(ctx.highlight && canHighlight(w))) {
    if (select) mark.cursor = select.kind === 'point' ? 'pointer' : 'crosshair'
    return { spec: { ...base, params, mark, encoding: { ...enc, ...pointFeedback } }, select }
  }

  // Highlighted: the whole in a muted colour, the highlighted part on top in full colour. Totals come as
  // two sets of rows, the whole's and the part's; a scatter's points are each flagged as in the part or not.
  const { color: _c, tooltip: _t, ...shape } = enc
  const wholeRows = pre ? [{ filter: `!datum.${PART}` }] : []
  const whole: Spec = { transform: wholeRows, mark: { ...mark, ...(mark.type === 'area' ? { fillOpacity: 0.5 } : {}) }, encoding: { ...shape, color: { value: dim } } }
  if (w.color && (w.chart === 'line' || w.chart === 'area')) whole.encoding.detail = { field: fieldRef(w.color) }
  // The whole of a split bar chart is one grey bar per category (its totals come unsplit).
  if (pre && (w.chart === 'bar' || w.chart === 'hbar')) {
    const ch = w.chart === 'hbar' ? 'x' : 'y'
    whole.encoding[ch] = { ...whole.encoding[ch], stack: null }
  }
  const part: Spec = { transform: [{ filter: `datum.${PART}` }], mark, encoding: { ...enc, ...pointFeedback } }
  const layer = [whole, part]
  if (select?.kind === 'point') {
    // Clicks land on a transparent copy of the whole, so the highlighted part on top doesn't swallow them.
    layer.push({ transform: wholeRows, params, mark: { type: mark.type, fill: 'transparent', stroke: null, cursor: 'pointer' }, encoding: { ...shape, tooltip: enc.tooltip } })
  } else if (select) {
    whole.params = params
    whole.mark.cursor = 'crosshair'
  }
  return { spec: { ...base, layer }, select }
}

function selectionParam(select: SelectInfo, w: ChartWidget): Spec {
  if (select.kind === 'point') {
    return { name: SEL, select: { type: 'point', fields: select.fields.map(fieldRef), on: 'click', clear: 'dblclick', toggle: 'event.shiftKey || event.ctrlKey || event.metaKey' } }
  }
  const encodings = w.chart === 'scatter' ? ['x', 'y'] : w.chart === 'hbar' ? ['y'] : ['x']
  const accent = cssVar('--accent') || '#2457c5'
  return { name: SEL, select: { type: 'interval', encodings, clear: 'dblclick', mark: { fill: accent, fillOpacity: 0.12, stroke: accent, strokeOpacity: 0.6 } } }
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Chart chrome in the app's own colours and type, read from its CSS tokens. */
export function vegaConfig(): Spec {
  const fg = cssVar('--fg'), muted = cssVar('--muted'), line = cssVar('--line'), strong = cssVar('--line-strong')
  const font = getComputedStyle(document.body).fontFamily
  return {
    background: null,
    font,
    padding: { left: 4, right: 8, top: 6, bottom: 4 },
    view: { stroke: null },
    axis: {
      labelColor: muted, titleColor: muted, gridColor: line, domainColor: strong, tickColor: strong,
      labelFontSize: 11, titleFontSize: 11.5, titleFontWeight: 600, labelFont: font, titleFont: font, titlePadding: 8,
    },
    axisX: { grid: false, tickSize: 4 },
    axisY: { domain: false, ticks: false, tickCount: 5 },
    axisQuantitative: {
      labelExpr: "abs(datum.value) >= 10000 ? replace(format(datum.value, '.3~s'), 'G', 'B') : format(datum.value, ',~r')",
    },
    legend: { labelColor: fg, titleColor: muted, labelFontSize: 11.5, titleFontSize: 11.5, titleFontWeight: 600, symbolType: 'circle', orient: 'bottom', labelLimit: 160 },
    range: { category: CATEGORICAL[isDark() ? 'dark' : 'light'] },
    // Hand-written specs that don't pick a colour still match the rest of the dashboard.
    mark: { color: CATEGORICAL[isDark() ? 'dark' : 'light'][0] },
    text: { color: fg },
  }
}
