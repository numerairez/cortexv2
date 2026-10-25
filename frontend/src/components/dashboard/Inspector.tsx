import { useState } from 'react'
import {
  AGG_LABEL, columnValues, defaultMeasure, isCategory, isNumeric, measureLabel,
  type Condition, type Row,
  type Agg, type ChartKind, type ChartWidget, type ColType, type HeadlineWidget, type Measure, type TableWidget, type TimeUnit, type Widget,
} from '../../dashboard'
import type { ColumnSchema } from '../../types'
import { SparkIcon, TypeGlyph } from '../Icons'
import { FilterCondition, keepAll } from '../StepEditor'
import { Field, Modal } from '../ui'
import { buildSpec } from './vegaSpec'
import { CHART_LABEL, TYPE_LABEL, WidgetIcon } from './Widgets'

type Filter = (t: ColType) => boolean
const anyType: Filter = (t) => t !== 'empty'

function FieldSelect({ value, columns, onChange, filter = anyType, none }: {
  value?: string; columns: ColumnSchema[]; onChange: (v: string | undefined) => void; filter?: Filter; none?: string
}) {
  const groups: [string, Filter][] = [['Text', (t) => isCategory(t)], ['Numbers', (t) => isNumeric(t)], ['Dates', (t) => t === 'date']]
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      {(none || !value) && <option value="">{none ?? 'Choose a column…'}</option>}
      {groups.map(([label, g]) => {
        const cols = columns.filter((c) => g(c.type) && filter(c.type))
        return cols.length ? <optgroup key={label} label={label}>{cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</optgroup> : null
      })}
    </select>
  )
}

function MeasurePicker({ value, columns, onChange }: { value: Measure; columns: ColumnSchema[]; onChange: (m: Measure) => void }) {
  const numeric = columns.filter((c) => isNumeric(c.type))
  const setAgg = (agg: Agg) => {
    if (agg === 'count') return onChange({ agg })
    const ok = agg === 'distinct' ? columns.some((c) => c.name === value.field) : numeric.some((c) => c.name === value.field)
    onChange({ agg, field: ok ? value.field : agg === 'distinct' ? columns[0]?.name : numeric[0]?.name })
  }
  return (
    <div className="measure-pick">
      <select value={value.agg} onChange={(e) => setAgg(e.target.value as Agg)}>
        {(Object.keys(AGG_LABEL) as Agg[]).filter((a) => a === 'count' || a === 'distinct' || numeric.length).map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
      </select>
      {value.agg !== 'count' && (
        <FieldSelect value={value.field} columns={columns} filter={value.agg === 'distinct' ? anyType : (t) => isNumeric(t)} onChange={(f) => f && onChange({ ...value, field: f })} />
      )}
    </div>
  )
}

/** The title the builder would give; kept in sync until the user types their own. */
export function autoTitle(w: Widget): string {
  if (w.type === 'headline') return measureLabel(w.measure)
  if (w.type === 'table') {
    if (w.mode === 'pivot') return `${measureLabel(w.pivotValue ?? { agg: 'count' })} by ${[...w.groupBy, w.pivotColumn].filter(Boolean).join(' & ')}`
    return w.mode === 'summary' && w.groupBy.length ? `By ${w.groupBy.join(' & ')}` : 'Details'
  }
  if (w.chart === 'scatter') return w.x && w.y.field ? `${w.y.field} vs ${w.x}` : 'Scatter'
  if (w.chart === 'donut') return w.x ? `Share by ${w.x}` : 'Share'
  if (w.chart === 'line' || w.chart === 'area') return w.x ? `${measureLabel(w.y)} over ${w.x}` : measureLabel(w.y)
  return w.x ? `${measureLabel(w.y)} by ${w.x}${w.color ? ` & ${w.color}` : ''}` : measureLabel(w.y)
}

export function Inspector({ w, columns, types, rows, onChange, onDescribe }: {
  w: Widget; columns: ColumnSchema[]; types: Record<string, ColType>
  /** The dataset's rows, for the filter's value lists and ranges. */
  rows: Row[]
  onChange: (w: Widget) => void
  /** Open the describe-a-change composer in this object's wireframe. */
  onDescribe?: () => void
}) {
  const [editingSpec, setEditingSpec] = useState(false)
  // Field edits re-title the object while its title is still the automatic one.
  const update = (patch: Partial<Widget>) => {
    const next = { ...w, ...patch } as Widget
    if (!('title' in patch) && w.title === autoTitle(w)) next.title = autoTitle(next)
    onChange(next)
  }
  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className={`type-chip t-${w.type}`}><WidgetIcon w={w} size={16} />{TYPE_LABEL[w.type]}</span>
      </div>
      <div className="stack">
        {onDescribe && <button className="ai-describe" onClick={onDescribe}><SparkIcon /> Describe a change…<span className="faint small">via your AI chatbot</span></button>}
        <Field label="Title">
          <input value={w.title} onChange={(e) => onChange({ ...w, title: e.target.value })} placeholder={autoTitle(w)} />
        </Field>
        {w.type === 'headline' && <HeadlineSettings w={w} columns={columns} update={update} />}
        {w.type === 'chart' && (w.vegaLite
          ? <div className="alert info small">This chart uses a hand-written Vega-Lite spec. <button className="sm" onClick={() => setEditingSpec(true)}>Edit spec…</button></div>
          : <ChartSettings w={w} columns={columns} types={types} update={update} />)}
        {w.type === 'table' && <TableSettings w={w} columns={columns} update={update} />}
        <FilterSettings w={w} columns={columns} types={types} rows={rows} onChange={onChange} />
        <label className="check small">
          <input type="checkbox" checked={w.caption !== false} onChange={(e) => onChange({ ...w, caption: e.target.checked ? undefined : false })} />
          Show the data source and filters under it
        </label>
        {w.type === 'chart' && !w.vegaLite && (
          <button className="ghost sm advanced-link" onClick={() => setEditingSpec(true)}>{'</>'} Customise with Vega-Lite…</button>
        )}
      </div>
      {editingSpec && w.type === 'chart' && (
        <VegaLiteEditor w={w} types={types} onClose={() => setEditingSpec(false)} onApply={(spec) => { onChange({ ...w, vegaLite: spec }); setEditingSpec(false) }} />
      )}
    </div>
  )
}

/** Rows this object is limited to: the same conditions as a workflow's Filter step. */
function FilterSettings({ w, columns, types, rows, onChange }: {
  w: Widget; columns: ColumnSchema[]; types: Record<string, ColType>; rows: Row[]; onChange: (w: Widget) => void
}) {
  const [added, setAdded] = useState<number | null>(null)
  const f = w.filter ?? { match: 'all' as const, conditions: [] }
  const set = (next: Partial<NonNullable<Widget['filter']>>) => {
    const merged = { ...f, ...next }
    onChange({ ...w, filter: merged.conditions.length ? merged : undefined })
  }
  const load = async (column: string) => columnValues(rows, column, types[column] ?? 'text')
  const usable = columns.filter((c) => c.type !== 'empty')
  return (
    <div className="obj-filter">
      <div className="row between">
        <span className="label-sm" style={{ margin: 0 }}>Filter</span>
        {f.conditions.length > 1 && (
          <select className="inline-input" value={f.match} onChange={(e) => set({ match: e.target.value as 'all' | 'any' })} aria-label="Match">
            <option value="all">Rows matching all</option><option value="any">Rows matching any</option>
          </select>
        )}
      </div>
      {f.conditions.length === 0 && <p className="faint small" style={{ margin: '2px 0 6px' }}>Uses every row of the dataset.</p>}
      {f.conditions.map((c, i) => (
        <FilterCondition key={i} cond={c as unknown as Record<string, unknown>} cols={usable} load={load} defaultOpen={i === added}
          onChange={(patch) => set({ conditions: f.conditions.map((x, j) => (j === i ? { ...x, ...patch } as Condition : x)) })}
          onRemove={() => set({ conditions: f.conditions.filter((_, j) => j !== i) })} />
      ))}
      <select className="add-cond" value="" aria-label="Add a filter condition" onChange={(e) => {
        const col = usable.find((c) => c.name === e.target.value)
        if (!col) return
        setAdded(f.conditions.length)
        set({ conditions: [...f.conditions, keepAll(col) as unknown as Condition] })
      }}>
        <option value="">+ Filter by a column…</option>
        {usable.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
    </div>
  )
}

function HeadlineSettings({ w, columns, update }: { w: HeadlineWidget; columns: ColumnSchema[]; update: (p: Partial<HeadlineWidget>) => void }) {
  return (
    <>
      <Field label="Shows"><MeasurePicker value={w.measure} columns={columns} onChange={(measure) => update({ measure })} /></Field>
      <div className="subgrid">
        <Field label="Format">
          <select value={w.format ?? 'auto'} onChange={(e) => update({ format: e.target.value as HeadlineWidget['format'] })}>
            <option value="auto">Automatic (12.9K)</option><option value="number">Full number</option>
            <option value="currency">Currency ($)</option><option value="percent">Percent</option>
          </select>
        </Field>
        <Field label="Unit after"><input value={w.suffix ?? ''} placeholder="e.g. kg" onChange={(e) => update({ suffix: e.target.value || undefined })} /></Field>
      </div>
    </>
  )
}

const CHART_KINDS: ChartKind[] = ['bar', 'hbar', 'line', 'area', 'donut', 'scatter', 'heatmap']
const TIME_UNITS: [TimeUnit, string][] = [['year', 'Year'], ['yearquarter', 'Quarter'], ['yearmonth', 'Month'], ['yearweek', 'Week'], ['yearmonthdate', 'Day']]

function ChartSettings({ w, columns, types, update }: {
  w: ChartWidget; columns: ColumnSchema[]; types: Record<string, ColType>; update: (p: Partial<ChartWidget>) => void
}) {
  const xt = w.x ? types[w.x] : undefined
  const setKind = (chart: ChartKind) => {
    const p: Partial<ChartWidget> = { chart }
    const firstNum = columns.find((c) => isNumeric(c.type))?.name
    if (chart === 'scatter') {
      if (!w.x || !isNumeric(types[w.x])) p.x = firstNum
      p.y = { agg: 'sum', field: columns.filter((c) => isNumeric(c.type))[1]?.name ?? firstNum }
    } else if (w.chart === 'scatter') {
      p.x = columns.find((c) => isCategory(c.type))?.name ?? w.x
    }
    if (chart === 'donut' && (!w.x || !isCategory(types[w.x]))) p.x = columns.find((c) => isCategory(c.type))?.name
    if (chart === 'heatmap' && !w.color) p.color = columns.find((c) => isCategory(c.type) && c.name !== (p.x ?? w.x))?.name
    if (chart === 'donut' && !w.top) p.top = 8
    update(p)
  }
  const labels: Record<ChartKind, [string, string]> = {
    bar: ['Categories', 'Split by'], hbar: ['Categories', 'Split by'], line: ['Along', 'One line per'], area: ['Along', 'Stack by'],
    scatter: ['Horizontal (number)', 'Colour by'], donut: ['Slices', ''], heatmap: ['Columns', 'Rows'],
  }
  const [xLabel, colorLabel] = labels[w.chart]
  return (
    <>
      <div>
        <span className="label-sm">Chart type</span>
        <div className="kind-grid" role="radiogroup" aria-label="Chart type">
          {CHART_KINDS.map((k) => (
            <button key={k} role="radio" aria-checked={w.chart === k} className={w.chart === k ? 'on' : ''} onClick={() => setKind(k)} title={CHART_LABEL[k]}>
              <WidgetIcon type="chart" chart={k} size={20} /><span>{CHART_LABEL[k]}</span>
            </button>
          ))}
        </div>
      </div>
      <Field label={xLabel}>
        <FieldSelect value={w.x} columns={columns} onChange={(x) => update({ x })}
          filter={w.chart === 'scatter' ? (t) => isNumeric(t) : w.chart === 'donut' ? (t) => isCategory(t) : anyType} />
      </Field>
      {xt === 'date' && w.chart !== 'scatter' && (
        <Field label="Group dates by">
          <div className="seg-control">
            {TIME_UNITS.map(([u, l]) => <button key={u} className={(w.timeUnit ?? 'yearmonth') === u ? 'on' : ''} onClick={() => update({ timeUnit: u })}>{l}</button>)}
          </div>
        </Field>
      )}
      {w.chart === 'scatter'
        ? <Field label="Vertical (number)"><FieldSelect value={w.y.field} columns={columns} filter={(t) => isNumeric(t)} onChange={(f) => f && update({ y: { agg: 'sum', field: f } })} /></Field>
        : <Field label={w.chart === 'heatmap' ? 'Colour shows' : 'Value'}><MeasurePicker value={w.y} columns={columns} onChange={(y) => update({ y })} /></Field>}
      {colorLabel && (
        <Field label={colorLabel}>
          <FieldSelect value={w.color} columns={columns} filter={(t) => isCategory(t) || (w.chart === 'heatmap' && t === 'date')} none={w.chart === 'heatmap' ? undefined : 'Nothing'} onChange={(color) => update({ color })} />
        </Field>
      )}
      {w.x && isCategory(xt) && w.chart !== 'scatter' && w.chart !== 'heatmap' && (
        <div className="subgrid">
          {w.chart !== 'donut' && (
            <Field label="Order">
              <select value={w.sort ?? 'value'} onChange={(e) => update({ sort: e.target.value as ChartWidget['sort'] })}>
                <option value="value">Largest first</option><option value="label">A → Z</option>
              </select>
            </Field>
          )}
          <Field label="Show">
            <select value={w.top ?? 0} onChange={(e) => update({ top: Number(e.target.value) || undefined })}>
              <option value={0}>All</option>{[5, 8, 10, 12, 20, 30].map((n) => <option key={n} value={n}>Top {n}</option>)}
            </select>
          </Field>
        </div>
      )}
    </>
  )
}

function TableSettings({ w, columns, update }: { w: TableWidget; columns: ColumnSchema[]; update: (p: Partial<TableWidget>) => void }) {
  const toggle = (list: string[], c: string) => (list.includes(c) ? list.filter((x) => x !== c) : columns.map((x) => x.name).filter((n) => n === c || list.includes(n)))
  const setMode = (mode: TableWidget['mode']) => {
    const firstCat = columns.find((c) => isCategory(c.type))?.name
    if (mode === 'summary' && !w.groupBy.length) {
      const n = columns.find((c) => isNumeric(c.type))?.name
      update({ mode, groupBy: firstCat ? [firstCat] : [], measures: [{ agg: 'count' }, ...(n ? [{ agg: 'sum' as const, field: n }] : [])], sortBy: undefined })
    } else if (mode === 'pivot') {
      // Rows from the summary's grouping (or the first category); columns across time when there is a date, else a second category.
      const groupBy = w.groupBy.length ? w.groupBy.slice(0, 2) : firstCat ? [firstCat] : []
      const pivotColumn = w.pivotColumn && !groupBy.includes(w.pivotColumn) ? w.pivotColumn
        : columns.find((c) => c.type === 'date' && !groupBy.includes(c.name))?.name ?? columns.find((c) => isCategory(c.type) && !groupBy.includes(c.name))?.name
      const pivotValue = w.pivotValue ?? w.measures.find((m) => m.agg !== 'count') ?? defaultMeasure(columns)
      update({ mode, groupBy, pivotColumn, pivotValue, pivotTop: w.pivotTop ?? 12, totals: w.totals ?? true, heat: w.heat ?? true, sortBy: undefined })
    } else update({ mode, sortBy: undefined })
  }
  const usesDates = w.mode === 'pivot' && [...w.groupBy, w.pivotColumn].some((f) => columns.find((c) => c.name === f)?.type === 'date')
  return (
    <>
      <Field label="Shows">
        <div className="seg-control">
          <button className={w.mode === 'rows' ? 'on' : ''} onClick={() => setMode('rows')}>Rows</button>
          <button className={w.mode === 'summary' ? 'on' : ''} onClick={() => setMode('summary')}>Summary</button>
          <button className={w.mode === 'pivot' ? 'on' : ''} onClick={() => setMode('pivot')}>Pivot</button>
        </div>
      </Field>
      {w.mode === 'pivot' ? (
        <>
          <Field label="Rows" help="One row per combination of these.">
            <div className="col-checks short">
              {columns.filter((c) => c.type !== 'empty' && c.name !== w.pivotColumn).map((c) => (
                <label key={c.name} className="check"><input type="checkbox" checked={w.groupBy.includes(c.name)} onChange={() => update({ groupBy: toggle(w.groupBy, c.name) })} />
                  <TypeGlyph type={c.type} /><span className="ellipsis">{c.name}</span></label>
              ))}
            </div>
          </Field>
          <Field label="Columns" help="Each value of this becomes a column.">
            <FieldSelect value={w.pivotColumn} columns={columns.filter((c) => !w.groupBy.includes(c.name))} onChange={(pivotColumn) => update({ pivotColumn })} />
          </Field>
          <Field label="Each cell shows">
            <MeasurePicker value={w.pivotValue ?? { agg: 'count' }} columns={columns} onChange={(pivotValue) => update({ pivotValue })} />
          </Field>
          {usesDates && (
            <Field label="Group dates by">
              <div className="seg-control">
                <button className={!w.timeUnit ? 'on' : ''} onClick={() => update({ timeUnit: undefined })} title="Picked from how much time the data covers">Auto</button>
                {TIME_UNITS.map(([u, l]) => <button key={u} className={w.timeUnit === u ? 'on' : ''} onClick={() => update({ timeUnit: u })}>{l}</button>)}
              </div>
            </Field>
          )}
          <Field label="Columns to show" help="The rest are combined into one “Other” (or “Earlier”, for dates) column.">
            <select value={w.pivotTop ?? 12} onChange={(e) => update({ pivotTop: Number(e.target.value) })}>
              {[5, 8, 12, 20, 30, 50].map((n) => <option key={n} value={n}>Up to {n}</option>)}
            </select>
          </Field>
          <div className="stack" style={{ gap: 6 }}>
            <label className="check"><input type="checkbox" checked={w.totals !== false} onChange={(e) => update({ totals: e.target.checked })} /> Row and column totals</label>
            <label className="check"><input type="checkbox" checked={!!w.heat} onChange={(e) => update({ heat: e.target.checked })} /> Shade cells by value</label>
          </div>
        </>
      ) : w.mode === 'rows' ? (
        <div>
          <div className="row between"><span className="label-sm">Columns</span>
            <span className="row" style={{ gap: 2 }}>
              <button className="ghost sm" onClick={() => update({ columns: columns.map((c) => c.name) })}>All</button>
              <button className="ghost sm" onClick={() => update({ columns: [] })}>None</button>
            </span>
          </div>
          <div className="col-checks">
            {columns.map((c) => (
              <label key={c.name} className="check"><input type="checkbox" checked={w.columns.includes(c.name)} onChange={() => update({ columns: toggle(w.columns, c.name) })} />
                <TypeGlyph type={c.type} /><span className="ellipsis">{c.name}</span></label>
            ))}
          </div>
        </div>
      ) : (
        <>
          <Field label="One row per">
            <div className="col-checks short">
              {columns.filter((c) => c.type !== 'empty').map((c) => (
                <label key={c.name} className="check"><input type="checkbox" checked={w.groupBy.includes(c.name)} onChange={() => update({ groupBy: toggle(w.groupBy, c.name) })} />
                  <TypeGlyph type={c.type} /><span className="ellipsis">{c.name}</span></label>
              ))}
            </div>
          </Field>
          <div>
            <span className="label-sm">Values</span>
            {w.measures.map((m, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap', marginBottom: 6 }}>
                <MeasurePicker value={m} columns={columns} onChange={(nm) => update({ measures: w.measures.map((x, j) => (j === i ? nm : x)) })} />
                <button className="ghost icon" aria-label="Remove value" onClick={() => update({ measures: w.measures.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <button className="sm" onClick={() => update({ measures: [...w.measures, { agg: 'count' }] })}>+ Add a value</button>
          </div>
        </>
      )}
      <Field label="Show at most">
        <select value={w.limit} onChange={(e) => update({ limit: Number(e.target.value) })}>
          {[10, 25, 50, 100, 200, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n.toLocaleString()} rows</option>)}
        </select>
      </Field>
    </>
  )
}

function VegaLiteEditor({ w, types, onClose, onApply }: {
  w: ChartWidget; types: Record<string, ColType>; onClose: () => void; onApply: (spec: Record<string, unknown> | undefined) => void
}) {
  const initial = () => {
    if (w.vegaLite) return JSON.stringify(w.vegaLite, null, 2)
    const { data: _d, ...spec } = buildSpec(w, { types, drive: false, highlight: false }).spec
    return JSON.stringify(spec, null, 2)
  }
  const [text, setText] = useState(initial)
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const check = async (): Promise<Record<string, unknown> | null> => {
    let spec: Record<string, unknown>
    try { spec = JSON.parse(text) } catch (e) { setStatus({ ok: false, msg: `Not valid JSON: ${(e as Error).message}` }); return null }
    try {
      const vl = await import('vega-lite')
      vl.compile({ ...spec, data: { name: 'table' } } as never)
      setStatus({ ok: true, msg: 'Looks good.' })
      return spec
    } catch (e) { setStatus({ ok: false, msg: (e as Error).message }); return null }
  }
  return (
    <Modal title="Customise with Vega-Lite" wide onClose={onClose} footer={<>
      {w.vegaLite && <button className="danger" onClick={() => onApply(undefined)}>Go back to the builder</button>}
      <span className="spacer" />
      <button onClick={check}>Check</button>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" onClick={async () => { const s = await check(); if (s) onApply(s) }}>Apply</button>
    </>}>
      <p className="muted small">
        Full control over the chart with a <a href="https://vega.github.io/vega-lite/docs/" target="_blank" rel="noopener">Vega-Lite</a> spec.
        Rows arrive as the named dataset <code>table</code>, already filtered by any interactions. To let this chart filter or highlight others,
        add a parameter named <code>sel</code> (a <code>point</code> selection with <code>fields</code>, or an <code>interval</code>).
        Charts can’t load files or web addresses.
      </p>
      <textarea className="code" spellCheck={false} value={text} onChange={(e) => { setText(e.target.value); setStatus(null) }} style={{ minHeight: 380 }} />
      {status && <div className={`alert ${status.ok ? 'ok' : 'bad'} small`} style={{ marginTop: 8 }}>{status.msg}</div>}
    </Modal>
  )
}
