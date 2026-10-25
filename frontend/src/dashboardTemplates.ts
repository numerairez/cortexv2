// Layout templates: starting points people pick from a gallery. A template describes intent ("a trend across
// the top", "a category sidebar") in grid slots; each slot is filled from the chosen dataset's columns with the
// same rules as the suggested layout. Slots the data can't support fall back to something similar, or drop out.
import {
  GRID_COLS, defaultMeasure, measureLabel, measureOf, newId, plural, rankCategories, settle, suggestLayout, timeUnitFor, valueColumns,
  type Box, type ChartKind, type DashboardSpec, type DashLink, type Effect, type Measure, type Row, type Widget,
} from './dashboard'
import type { ColumnSchema } from './types'

export type Intent =
  | 'kpi1' | 'kpi2' | 'kpi3' | 'kpi4'
  | 'trend' | 'trendArea' | 'trendBySeries' | 'breakdown' | 'breakdownH' | 'breakdown2' | 'share' | 'heatmap' | 'scatter'
  | 'pivot' | 'summary' | 'topTable' | 'details'

interface Slot { intent: Intent; box: Box }
export interface DashTemplate {
  id: string; name: string; description: string
  /** Comes with interactions already connected. */
  interactive?: boolean
  slots: Slot[]
  /** Links between slots, by slot index; 'all' means every other object. */
  links?: { from: number; to: number | 'all'; effect: Effect }[]
  /** Builds the whole dashboard instead of the slots (the slots then only draw the preview). */
  build?: (columns: ColumnSchema[], rows: Row[]) => DashboardSpec
}

const b = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })
const kpiRow = (n: number, y = 0, w = GRID_COLS / n): Slot[] =>
  Array.from({ length: n }, (_, i) => ({ intent: `kpi${i + 1}` as Intent, box: b(i * w, y, w, 3) }))

export const TEMPLATES: DashTemplate[] = [
  {
    id: 'summary', name: 'Executive summary', description: 'Headline numbers, a trend, a breakdown, a pivot and the detail rows.',
    slots: [...kpiRow(4), { intent: 'trend', box: b(0, 3, 6, 8) }, { intent: 'breakdown', box: b(6, 3, 6, 8) },
      { intent: 'pivot', box: b(0, 11, 12, 6) }, { intent: 'details', box: b(0, 17, 12, 7) }],
    build: suggestLayout,
  },
  {
    id: 'kpi-trend', name: 'Numbers & trend', description: 'A row of headlines over one wide trend, with a breakdown and a share underneath.',
    slots: [...kpiRow(4), { intent: 'trendArea', box: b(0, 3, 12, 7) }, { intent: 'breakdown', box: b(0, 10, 6, 7) }, { intent: 'share', box: b(6, 10, 6, 7) }],
  },
  {
    id: 'three-up', name: 'Three across', description: 'Three headlines over three charts side by side, then the details.',
    slots: [...kpiRow(3), { intent: 'breakdown', box: b(0, 3, 4, 8) }, { intent: 'share', box: b(4, 3, 4, 8) },
      { intent: 'trend', box: b(8, 3, 4, 8) }, { intent: 'details', box: b(0, 11, 12, 7) }],
  },
  {
    id: 'focus', name: 'One big chart', description: 'A large main chart with headlines stacked beside it, a pivot below.',
    slots: [{ intent: 'trendArea', box: b(0, 0, 8, 10) }, { intent: 'kpi1', box: b(8, 0, 4, 3) }, { intent: 'kpi2', box: b(8, 3, 4, 3) },
      { intent: 'kpi3', box: b(8, 6, 4, 4) }, { intent: 'pivot', box: b(0, 10, 12, 7) }],
  },
  {
    id: 'explorer', name: 'Click-to-filter explorer', interactive: true,
    description: 'A category list down the side; clicking a bar filters everything else.',
    slots: [{ intent: 'breakdownH', box: b(0, 0, 4, 15) }, { intent: 'kpi1', box: b(4, 0, 4, 3) }, { intent: 'kpi2', box: b(8, 0, 4, 3) },
      { intent: 'trend', box: b(4, 3, 8, 6) }, { intent: 'details', box: b(4, 9, 8, 6) }],
    links: [{ from: 0, to: 'all', effect: 'filter' }],
  },
  {
    id: 'time', name: 'Over time', description: 'How things move: a wide trend, one line per category, and a calendar-style heatmap.',
    slots: [...kpiRow(3), { intent: 'trendArea', box: b(0, 3, 12, 7) }, { intent: 'trendBySeries', box: b(0, 10, 6, 8) }, { intent: 'heatmap', box: b(6, 10, 6, 8) }],
  },
  {
    id: 'compare', name: 'Compare categories', interactive: true,
    description: 'Rankings, shares and a cross-tab; picking a category highlights it in the ranking table.',
    slots: [{ intent: 'breakdownH', box: b(0, 0, 6, 8) }, { intent: 'share', box: b(6, 0, 6, 8) },
      { intent: 'heatmap', box: b(0, 8, 6, 8) }, { intent: 'topTable', box: b(6, 8, 6, 8) }],
    links: [{ from: 0, to: 1, effect: 'filter' }, { from: 0, to: 2, effect: 'filter' }, { from: 0, to: 3, effect: 'highlight' }],
  },
  {
    id: 'report', name: 'Table report', description: 'Two headlines, a pivot and a summary next to the detail rows, for reading the numbers.',
    slots: [...kpiRow(2), { intent: 'pivot', box: b(0, 3, 12, 7) }, { intent: 'summary', box: b(0, 10, 5, 8) }, { intent: 'details', box: b(5, 10, 7, 8) }],
  },
  { id: 'blank', name: 'Blank canvas', description: 'Add each headline, chart and table yourself.', slots: [] },
]

/** What a slot looks like before there is data, for the gallery's previews. */
export function previewWidget(slot: Slot, i: number): Widget {
  const base = { id: `p${i}`, title: '', box: slot.box }
  const chart = (k: ChartKind): Widget => ({ ...base, type: 'chart', chart: k, y: { agg: 'count' }, x: 'x' })
  switch (slot.intent) {
    case 'kpi1': case 'kpi2': case 'kpi3': case 'kpi4': return { ...base, type: 'headline', measure: { agg: 'count' } }
    case 'trend': case 'trendBySeries': return chart('line')
    case 'trendArea': return chart('area')
    case 'breakdown': case 'breakdown2': return chart('bar')
    case 'breakdownH': return chart('hbar')
    case 'share': return chart('donut')
    case 'heatmap': return chart('heatmap')
    case 'scatter': return chart('scatter')
    case 'pivot': return { ...base, type: 'table', mode: 'pivot', columns: [], groupBy: [], measures: [], limit: 50 }
    default: return { ...base, type: 'table', mode: 'rows', columns: [], groupBy: [], measures: [], limit: 50 }
  }
}

/** If the data can't support an intent, try these instead (in order) before dropping the slot. */
const FALLBACK: Partial<Record<Intent, Intent[]>> = {
  trend: ['breakdown2', 'breakdown'], trendArea: ['trend', 'breakdown'], trendBySeries: ['trend', 'breakdown2'],
  breakdown: ['summary'], breakdownH: ['breakdown', 'summary'], breakdown2: ['scatter'], share: ['breakdown2'],
  heatmap: ['pivot', 'breakdown2'], pivot: ['summary'], topTable: ['summary', 'details'], summary: ['details'],
  kpi4: [], scatter: [],
}

export function buildFromTemplate(t: DashTemplate, columns: ColumnSchema[], rows: Row[]): DashboardSpec {
  if (t.build) return t.build(columns, rows)
  const ranked = rankCategories(columns, rows)
  const cats = ranked.map((c) => c.field)
  const few = ranked.filter((c) => c.distinct <= 8).map((c) => c.field)   // few enough for colours and slices
  const nums = valueColumns(columns)
  const date = columns.find((c) => c.type === 'date')?.name
  const value = defaultMeasure(columns)
  const unit = date ? timeUnitFor(rows, date) : undefined
  const kpis: Measure[] = [{ agg: 'count' }, ...nums.slice(0, 2).map(measureOf), ...(cats[0] ? [{ agg: 'distinct', field: cats[0] } as Measure] : []), ...nums.slice(2).map(measureOf)]
  const used = new Set<string>()   // so two breakdowns in one template don't show the same thing
  const kpiTitle = (m: Measure) => (m.agg === 'count' ? 'Rows' : m.agg === 'distinct' ? plural(m.field!) : measureLabel(m))

  const make = (intent: Intent, box: Box): Widget | null => {
    const id = newId(intent.startsWith('kpi') ? 'h' : ['pivot', 'summary', 'topTable', 'details'].includes(intent) ? 't' : 'c')
    const chart = (rest: Omit<Extract<Widget, { type: 'chart' }>, 'id' | 'box' | 'type'>): Widget => ({ id, box, type: 'chart', ...rest })
    const table = (rest: Partial<Extract<Widget, { type: 'table' }>> & { title: string }): Widget =>
      ({ id, box, type: 'table', mode: 'rows', columns: [], groupBy: [], measures: [], limit: 200, ...rest })
    switch (intent) {
      case 'kpi1': case 'kpi2': case 'kpi3': case 'kpi4': {
        const m = kpis[Number(intent.slice(3)) - 1]
        return m ? { id, box, type: 'headline', title: kpiTitle(m), measure: m } : null
      }
      case 'trend': case 'trendArea':
        return date ? chart({ chart: intent === 'trend' ? 'line' : 'area', x: date, timeUnit: unit, y: value, title: `${measureLabel(value)} over time` }) : null
      case 'trendBySeries':
        return date && few[0] ? chart({ chart: 'line', x: date, timeUnit: unit, y: value, color: few[0], title: `${measureLabel(value)} over time by ${few[0]}` }) : null
      case 'breakdown': case 'breakdownH': {
        const c = cats.find((f) => !used.has(f))
        if (!c) return null
        used.add(c)
        return chart({ chart: intent === 'breakdown' ? 'bar' : 'hbar', x: c, y: value, sort: 'value', top: intent === 'breakdownH' ? 15 : 12, title: `${measureLabel(value)} by ${c}` })
      }
      case 'breakdown2': {
        const c = cats.find((f) => !used.has(f))
        if (c) { used.add(c); return chart({ chart: 'bar', x: c, y: value, sort: 'value', top: 12, title: `${measureLabel(value)} by ${c}` }) }
        const other = nums[1] ? measureOf(nums[1]) : null
        return cats[0] && other ? chart({ chart: 'bar', x: cats[0], y: other, sort: 'value', top: 12, title: `${measureLabel(other)} by ${cats[0]}` }) : null
      }
      case 'share': {
        const c = few.find((f) => !used.has(f)) ?? few[0]
        if (!c) return null
        used.add(c)
        return chart({ chart: 'donut', x: c, y: value, top: 8, title: `Share by ${c}` })
      }
      case 'heatmap': {
        if (!cats[0]) return null
        const across = date ?? cats.find((f) => f !== cats[0])
        if (!across) return null
        return chart({ chart: 'heatmap', x: across, color: cats[0], y: value, timeUnit: across === date ? (unit === 'yearmonthdate' ? 'yearweek' : 'yearmonth') : undefined, title: `${measureLabel(value)} by ${cats[0]} & ${across}` })
      }
      case 'scatter':
        return nums.length >= 2 ? chart({ chart: 'scatter', x: nums[0], y: { agg: 'sum', field: nums[1] }, color: few[0], title: `${nums[1]} vs ${nums[0]}` }) : null
      case 'pivot': {
        const across = date ?? cats[1]
        return cats[0] && across ? table({ mode: 'pivot', groupBy: [cats[0]], pivotColumn: across, pivotValue: value, pivotTop: 12, totals: true, heat: true, title: `${measureLabel(value)} by ${cats[0]} & ${across}` }) : null
      }
      case 'summary': case 'topTable': {
        if (!cats[0]) return null
        const extra = nums.map(measureOf).find((m) => m.agg === 'mean')
        return table({ mode: 'summary', groupBy: [cats[0]], measures: ([{ agg: 'count' }, value, ...(extra ? [extra] : [])] as Measure[]).filter((m, i, a) => a.findIndex((x) => JSON.stringify(x) === JSON.stringify(m)) === i),
          limit: intent === 'topTable' ? 10 : 200, title: intent === 'topTable' ? `Top ${cats[0]}` : `By ${cats[0]}` })
      }
      case 'details':
        return table({ title: 'Details', columns: columns.filter((c) => c.type !== 'empty').slice(0, 8).map((c) => c.name) })
    }
  }

  const bySlot: (Widget | null)[] = t.slots.map((s) => {
    for (const intent of [s.intent, ...(FALLBACK[s.intent] ?? [])]) {
      const w = make(intent, s.box)
      if (w) return w
    }
    return null
  })
  const widgets = settle(bySlot.filter((w): w is Widget => !!w))
  const links: DashLink[] = []
  for (const l of t.links ?? []) {
    const src = bySlot[l.from]
    if (!src || src.type === 'headline') continue
    const targets = l.to === 'all' ? bySlot.filter((w, i) => w && i !== l.from) : [bySlot[l.to]]
    for (const tgt of targets) {
      if (!tgt) continue
      const highlightable = tgt.type !== 'chart' || ['bar', 'hbar', 'line', 'area', 'scatter'].includes(tgt.chart)
      links.push({ id: newId('l'), source: src.id, target: tgt.id, effect: l.effect === 'highlight' && highlightable ? 'highlight' : 'filter' })
    }
  }
  return { widgets, links }
}

/** Whether a template is built around time (for the gallery's hint when the data has no dates). */
export const needsDate = (t: DashTemplate) => t.slots.some((s) => ['trend', 'trendArea', 'trendBySeries'].includes(s.intent))
