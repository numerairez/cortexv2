import { useEffect, useRef, useState } from 'react'
import type { Cell, ColumnSchema, ColumnValues, Selection, Step } from '../types'
import { JoinVenn, type JoinHow } from './JoinVenn'

type Cols = ColumnSchema[]
type Rec = Record<string, unknown>

export const OP_LABEL: Record<string, string> = {
  select_columns: 'Select columns', rename_columns: 'Rename columns', filter_rows: 'Filter rows', sort_rows: 'Sort rows',
  append_rows: 'Append tables', join: 'Join / lookup', deduplicate: 'Remove duplicates', convert_types: 'Convert types',
  derive_column: 'Calculated column', group_aggregate: 'Group & summarise', pivot: 'Pivot', unpivot: 'Unpivot',
}

const OPERATORS: [string, string][] = [
  ['eq', 'equals'], ['ne', 'does not equal'], ['gt', 'greater than'], ['ge', 'at least'], ['lt', 'less than'], ['le', 'at most'],
  ['contains', 'contains'], ['not_contains', 'does not contain'], ['starts_with', 'starts with'], ['in', 'is one of'],
  ['not_in', 'is not one of'], ['between', 'is between'], ['is_blank', 'is blank'], ['not_blank', 'is not blank'],
]
const AGGS = ['sum', 'mean', 'median', 'min', 'max', 'count', 'count_distinct', 'first', 'last']
const isRange = (type?: string) => type === 'number' || type === 'integer' || type === 'date'
const isSet = (v: unknown) => v !== null && v !== undefined && v !== ''

/** A filter condition that keeps every row: an open range for numbers/dates, no excluded values otherwise. */
export function keepAll(col?: ColumnSchema): Rec {
  const column = col?.name ?? ''
  return isRange(col?.type) ? { column, operator: 'between', value: [null, null], keep_blanks: true } : { column, operator: 'not_in', value: [] }
}

/** What a filter condition keeps, without the column name: "all values", "not A/B", "10–20", … */
function describeCondition(c: Rec): string {
  const op = String(c.operator)
  const list = Array.isArray(c.value) ? (c.value as Cell[]) : []
  const shown = (v: unknown) => (v === null || v === undefined ? '(blank)' : String(v))
  const vals = list.length > 3 ? `${list.length} values` : list.map(shown).join(', ')
  if (op === 'not_in') return list.length ? `all except ${vals}` : 'all values'
  if (op === 'in') return list.length ? `only ${vals}` : 'no values'
  if (op === 'between') {
    const [lo, hi] = list
    if (isSet(lo) && isSet(hi)) return `${lo} – ${hi}`
    if (isSet(lo)) return `at least ${lo}`
    if (isSet(hi)) return `at most ${hi}`
    return 'all values'
  }
  const label = OPERATORS.find((o) => o[0] === op)?.[1] ?? op
  return ['is_blank', 'not_blank'].includes(op) ? label : `${label} "${shown(c.value)}"`
}

function conditionSummary(c: Rec): string {
  return `${c.column}: ${describeCondition(c)}`
}
const AGG_LABEL: Record<string, string> = { mean: 'average', count_distinct: 'count distinct' }

const SAME_TYPE: Record<string, string> = { integer: 'integer', number: 'number', date: 'date', boolean: 'boolean' }

/** A starting configuration for a newly added step. Untouched, every step either changes nothing or
 *  waits to be set up (passing the data through) — never an error. */
export function newStep(op: string, cols: Cols, roles: string[], base: string): Step {
  const first = cols[0]?.name ?? ''
  const num = cols.slice(1).find((c) => c.type === 'number' || c.type === 'integer')?.name
  const others = roles.filter((r) => r !== base)
  const otherRole = others[0] ?? ''
  switch (op) {
    case 'select_columns': return { op, columns: cols.map((c) => c.name) }
    case 'rename_columns': return { op, mapping: { [first]: first } }
    case 'filter_rows': return { op, match: 'all', conditions: [keepAll(cols[0])] }
    case 'sort_rows': return { op, keys: [{ column: first, descending: false }] }
    case 'append_rows': return { op, inputs: otherRole ? [otherRole] : [], allow_missing_columns: true }
    case 'join': return { op, right: others.length === 1 ? otherRole : '', left_on: [''], right_on: [''], how: 'left', expected: 'many_to_one' }
    case 'deduplicate': return { op, keep: 'first' }
    // Converts the first column to the type it already has, so nothing changes until the user picks one.
    case 'convert_types': return { op, conversions: [{ column: first, to: SAME_TYPE[cols[0]?.type ?? ''] ?? 'text' }], on_error: 'blank' }
    case 'derive_column': return { op, name: 'New column', expression: '' }
    case 'group_aggregate': return { op, group_by: [first], aggregations: [num ? { column: num, function: 'sum', as: `Total ${num}` } : { column: first, function: 'count', as: 'Rows' }] }
    case 'pivot': return { op, index: [], columns: '', values: '', function: 'sum' }
    case 'unpivot': return { op, id_columns: [first], variable_name: 'Attribute', value_name: 'Value' }
    default: return { op }
  }
}

export function stepSummary(s: Step): string {
  const a = s as Rec
  const list = (v: unknown) => (Array.isArray(v) ? (v as string[]).join(', ') : '')
  switch (s.op) {
    case 'select_columns': return `${(a.columns as string[]).length} column(s)`
    case 'rename_columns': return Object.entries(a.mapping as Rec).map(([k, v]) => `${k} → ${v}`).join(', ')
    case 'filter_rows': return (a.conditions as Rec[]).map(conditionSummary).join(a.match === 'any' ? ' OR ' : ' AND ') || 'all rows'
    case 'sort_rows': return (a.keys as Rec[]).map((k) => `${k.column}${k.descending ? ' ↓' : ' ↑'}`).join(', ')
    case 'append_rows': return (a.inputs as string[]).length ? `+ ${list(a.inputs)}` : 'not set up yet'
    case 'join': {
      const keys = (a.left_on as string[]).map((l, i) => [l, (a.right_on as string[])[i]]).filter(([l, r]) => l && r)
      return a.right && keys.length ? `${a.how} join ${a.right} on ${keys.map(([l, r]) => (l === r ? l : `${l} = ${r}`)).join(', ')}` : 'not set up yet'
    }
    case 'deduplicate': return a.columns ? `by ${list(a.columns)}` : 'identical rows'
    case 'convert_types': return (a.conversions as Rec[]).map((c) => `${c.column} → ${c.to}`).join(', ') || 'no conversions'
    case 'derive_column': return String(a.expression).trim() ? `${a.name} = ${a.expression}` : 'not set up yet'
    case 'group_aggregate': return `by ${list(a.group_by) || '(all rows)'}: ${(a.aggregations as Rec[]).map((g) => `${AGG_LABEL[String(g.function)] ?? g.function}(${g.column})`).join(', ')}`
    case 'pivot': return a.values && a.columns && (a.index as string[]).length ? `${a.values} by ${list(a.index)} × ${a.columns}` : 'not set up yet'
    case 'unpivot': return `keep ${list(a.id_columns)}`
    default: return ''
  }
}

function ColumnSelect({ cols, value, onChange, allowEmpty }: { cols: Cols; value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const known = cols.some((c) => c.name === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Column">
      {(allowEmpty || !value) && <option value="">Choose column…</option>}
      {!known && value && <option value={value}>{value} (not found)</option>}
      {cols.map((c) => <option key={c.name} value={c.name}>{c.name} · {c.type}</option>)}
    </select>
  )
}

function ColumnMulti({ cols, value, onChange, placeholder = 'Add column…' }: { cols: Cols; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <div>
      <div className="chips" style={{ marginBottom: 6 }}>
        {value.map((c) => (
          <span key={c} className="chip" style={cols.some((x) => x.name === c) ? undefined : { background: 'var(--bad-soft)', color: 'var(--bad)' }}>
            {c}<button onClick={() => onChange(value.filter((x) => x !== c))} aria-label={`Remove ${c}`}>×</button>
          </span>
        ))}
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label={placeholder}>
          <option value="">{placeholder}</option>
          {cols.filter((c) => !value.includes(c.name)).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        {cols.length > value.length && <button className="sm" onClick={() => onChange([...value, ...cols.map((c) => c.name).filter((n) => !value.includes(n))])}>All</button>}
        {value.length > 0 && <button className="sm" onClick={() => onChange([])}>Clear</button>}
      </div>
    </div>
  )
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span className="label small">{label}</span>{children}</label>
}

type ValuesLoader = (column: string) => Promise<ColumnValues>

const WILDCARD_OPS: [string, string, string | null][] = [   // [operator, label, its "exclude" form]
  ['contains', 'Contains', 'not_contains'], ['starts_with', 'Starts with', null], ['eq', 'Exactly matches', 'ne'],
]
const WILDCARD_EXCLUDED: Record<string, string> = { not_contains: 'contains', ne: 'eq' }

function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="seg-tabs" role="tablist">
      {tabs.map(([v, l]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => v !== value && onChange(v)}>{l}</button>)}
    </div>
  )
}

/** One filter condition, laid out like Tableau's filter dialog: pick values from a list, or a range for numbers and dates. */
function FilterCondition({ cond, cols, load, defaultOpen, onChange, onRemove }: {
  cond: Rec; cols: Cols; load?: ValuesLoader; defaultOpen?: boolean; onChange: (patch: Rec) => void; onRemove: () => void
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const column = String(cond.column)
  const col = cols.find((c) => c.name === column)
  const range = isRange(col?.type)
  const op = String(cond.operator)
  const bounds = Array.isArray(cond.value) ? (cond.value as unknown[]) : []
  const [info, setInfo] = useState<ColumnValues | null>(null)
  const [rangeMode, setRangeMode] = useState(() => (isSet(bounds[0]) && !isSet(bounds[1]) ? 'min' : !isSet(bounds[0]) && isSet(bounds[1]) ? 'max' : 'range'))
  const loadRef = useRef(load)
  loadRef.current = load
  const canLoad = !!load
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!open || loadedFor.current === column) return
    loadedFor.current = column
    setInfo(null)
    if (!column || !loadRef.current) return
    let live = true
    loadRef.current(column)
      .then((v) => { if (live) setInfo(v) })
      .catch((e: Error) => { if (live) setInfo({ type: 'unknown', values: [], error: e.message }) })
    return () => { live = false; loadedFor.current = null }
  }, [column, canLoad, open])

  const tab = ['in', 'not_in'].includes(op) ? 'values'
    : op === 'between' ? rangeMode
      : !range && (op in WILDCARD_EXCLUDED || WILDCARD_OPS.some((w) => w[0] === op)) ? 'wildcard' : 'other'
  const tabs: [string, string][] = range
    ? [['range', 'Range'], ['min', 'At least'], ['max', 'At most'], ['values', 'Values']]
    : [['values', 'Values'], ['wildcard', 'Wildcard']]
  const setTab = (t: string) => {
    if (t === 'values') return onChange({ operator: 'not_in', value: [] })
    if (t === 'wildcard') return onChange({ operator: 'contains', value: '' })
    setRangeMode(t)
    const [lo, hi] = op === 'between' ? bounds : [null, null]
    onChange({ operator: 'between', value: t === 'min' ? [lo ?? null, null] : t === 'max' ? [null, hi ?? null] : [lo ?? null, hi ?? null], keep_blanks: cond.keep_blanks ?? true })
  }

  return (
    <div className={`filter-cond${open ? ' open' : ''}`}>
      <div className="cond-head">
        <button className="ghost icon chevron" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>{open ? '▾' : '▸'}</button>
        {open ? (
          <select className="col-pick" value={column} onChange={(e) => { setRangeMode('range'); onChange(keepAll(cols.find((c) => c.name === e.target.value))) }} aria-label="Column">
            {!col && <option value={column}>{column || 'Choose column…'}{column ? ' (not found)' : ''}</option>}
            {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        ) : (
          <button className="ghost summary-line" onClick={() => setOpen(true)} title={conditionSummary(cond)}>
            <span className="col">{column || 'Choose column…'}</span><span className="desc">{describeCondition(cond)}</span>
          </button>
        )}
        <button className="ghost icon" onClick={onRemove} aria-label="Remove condition" title="Remove condition">✕</button>
      </div>
      {open && <>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'values' ? <ValuePicker cond={cond} info={info} loading={canLoad && !info} onChange={onChange} />
        : op === 'between' ? <RangeFilter cond={cond} mode={rangeMode} type={col?.type} info={info} onChange={onChange} />
          : tab === 'wildcard' ? <Wildcard cond={cond} onChange={onChange} />
            : (
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <span className="small nowrap">{OPERATORS.find((o) => o[0] === op)?.[1] ?? op}</span>
                {!['is_blank', 'not_blank'].includes(op) && <input value={String(cond.value ?? '')} aria-label="Value" onChange={(e) => onChange({ value: e.target.value })} />}
              </div>
            )}
      </>}
    </div>
  )
}

function Wildcard({ cond, onChange }: { cond: Rec; onChange: (patch: Rec) => void }) {
  const op = String(cond.operator)
  const excluded = op in WILDCARD_EXCLUDED
  const base = WILDCARD_EXCLUDED[op] ?? op
  const negate = (b: string, ex: boolean) => (ex ? WILDCARD_OPS.find((w) => w[0] === b)?.[2] ?? b : b)
  return (
    <div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <select className="inline-input" value={base} onChange={(e) => onChange({ operator: negate(e.target.value, excluded) })} aria-label="Match">
          {WILDCARD_OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input value={String(cond.value ?? '')} placeholder="Text" aria-label="Text" onChange={(e) => onChange({ value: e.target.value })} />
      </div>
      <label className="check small">
        <input type="checkbox" checked={excluded} disabled={!WILDCARD_OPS.find((w) => w[0] === base)?.[2]} onChange={(e) => onChange({ operator: negate(base, e.target.checked) })} /> Exclude
      </label>
    </div>
  )
}

/** Checklist with an "(All)" row. Stores whichever list is shorter — the unticked values (not_in) or
 *  the ticked ones (in) — so "everything" is an empty exclusion list and new values pass through. */
function ValuePicker({ cond, info, loading, onChange }: { cond: Rec; info: ColumnValues | null; loading: boolean; onChange: (patch: Rec) => void }) {
  const [q, setQ] = useState('')
  const exclude = cond.operator === 'not_in'
  const list = (Array.isArray(cond.value) ? cond.value : []) as Cell[]
  const key = (v: Cell) => (v === null ? '\u0000blank' : String(v))
  const display = (v: Cell) => (v === null ? '(Blank)' : String(v))

  if (!info || !info.values.length) {
    // No values to offer (data not bound yet, or the column could not be read): type them instead.
    return (
      <div>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <select className="inline-input" value={exclude ? 'not_in' : 'in'} onChange={(e) => onChange({ operator: e.target.value })} aria-label="Mode">
            <option value="not_in">All except</option><option value="in">Only</option>
          </select>
          <input value={list.filter((v) => v !== null).join(', ')} placeholder={exclude ? 'nothing excluded' : 'a, b, c'} aria-label="Values"
            onChange={(e) => onChange({ value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </div>
        {loading ? <div className="faint small">Loading values…</div> : info?.error && <div className="faint small">{info.error}</div>}
      </div>
    )
  }

  const opts = [...info.values].sort((x, y) => String(x.value).localeCompare(String(y.value), undefined, { numeric: true }))
  if (info.nulls) opts.push({ value: null, count: info.nulls })
  const all = opts.map((o) => o.value)
  const listed = new Set(list.map(key))
  const isOn = (v: Cell) => exclude !== listed.has(key(v))
  const toggle = (vals: Cell[], on: boolean) => {
    const next = new Map(list.map((v) => [key(v), v]))
    for (const v of vals) { if (on !== exclude) next.set(key(v), v); else next.delete(key(v)) }
    let picked = [...next.values()]
    let mode = exclude
    if (!info.truncated && picked.length > all.length / 2) { picked = all.filter((v) => !next.has(key(v))); mode = !mode }
    onChange({ operator: mode ? 'not_in' : 'in', value: picked })
  }
  const needle = q.trim().toLowerCase()
  const visible = needle ? opts.filter((o) => display(o.value).toLowerCase().includes(needle)) : opts
  const onCount = all.filter(isOn).length
  const allOn = visible.every((o) => isOn(o.value))
  const someOn = visible.some((o) => isOn(o.value))
  const setAll = (on: boolean) => (needle ? toggle(visible.map((o) => o.value), on) : onChange(on ? { operator: 'not_in', value: [] } : { operator: 'in', value: [] }))

  return (
    <div className="value-pick">
      {opts.length > 8 && <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search values" />}
      <div className="pick-list">
        <label className="all">
          <input type="checkbox" checked={allOn} ref={(el) => { if (el) el.indeterminate = someOn && !allOn }} onChange={(e) => setAll(e.target.checked)} />
          <span className="v">(All)</span>
        </label>
        {visible.slice(0, 500).map((o) => (
          <label key={key(o.value)}>
            <input type="checkbox" checked={isOn(o.value)} onChange={(e) => toggle([o.value], e.target.checked)} />
            <span className={`v${o.value === null ? ' muted' : ''}`} title={display(o.value)}>{display(o.value)}</span>
            <span className="n">{o.count.toLocaleString()}</span>
          </label>
        ))}
        {visible.length > 500 && <div className="faint small">Showing 500 of {visible.length.toLocaleString()} — search to narrow down.</div>}
        {!visible.length && <div className="faint small">No matching values.</div>}
      </div>
      <div className="faint small">
        {onCount.toLocaleString()} of {all.length.toLocaleString()}{info.truncated ? '+' : ''} selected
        {info.truncated && ' · only the most common values are listed'}
      </div>
    </div>
  )
}

/** Range / At least / At most over a two-handle slider; an empty bound means "no limit". */
function RangeFilter({ cond, mode, type, info, onChange }: { cond: Rec; mode: string; type?: string; info: ColumnValues | null; onChange: (patch: Rec) => void }) {
  const date = type === 'date'
  const v = Array.isArray(cond.value) ? (cond.value as unknown[]) : []
  const lo = v[0] ?? null
  const hi = v[1] ?? null
  const toNum = (x: unknown) => (date ? Date.parse(String(x).slice(0, 10)) / 864e5 : Number(x))
  const ready = info?.min !== undefined && info?.max !== undefined
  const min = ready ? toNum(info!.min) : 0
  const max = ready ? toNum(info!.max) : 0
  const step = date || type === 'integer' ? 1 : (max - min) / 200 || 1
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  const fromNum = (n: number) => (date ? new Date(Math.round(n) * 864e5).toISOString().slice(0, 10) : Number(n.toFixed(decimals)))
  const loN = isSet(lo) ? Math.max(min, toNum(lo)) : min
  const hiN = isSet(hi) ? Math.min(max, toNum(hi)) : max
  const setBounds = (l: unknown, h: unknown) => onChange({ value: [l, h] })
  const bound = (s: string) => (s === '' ? null : date ? s : Number(s))
  const pct = (n: number) => (max > min ? ((n - min) / (max - min)) * 100 : 0)
  const showLo = mode !== 'max'
  const showHi = mode !== 'min'
  const inputType = date ? 'date' : 'number'

  return (
    <div className="range-filter">
      <div className="bounds">
        {showLo ? <input type={inputType} value={String(lo ?? '')} placeholder={ready ? String(info!.min) : 'Minimum'} aria-label="At least" onChange={(e) => setBounds(bound(e.target.value), hi)} /> : <span />}
        {showHi ? <input type={inputType} value={String(hi ?? '')} placeholder={ready ? String(info!.max) : 'Maximum'} aria-label="At most" onChange={(e) => setBounds(lo, bound(e.target.value))} /> : <span />}
      </div>
      {ready && max > min && (
        <div className="slider">
          <div className="fill" style={{ left: `${pct(showLo ? loN : min)}%`, right: `${100 - pct(showHi ? hiN : max)}%` }} />
          {showLo && <input type="range" min={min} max={max} step={step} value={loN} aria-label="Minimum"
            onChange={(e) => { const n = Number(e.target.value); setBounds(n <= min ? null : fromNum(Math.min(n, hiN)), hi) }} />}
          {showHi && <input type="range" min={min} max={max} step={step} value={hiN} aria-label="Maximum"
            onChange={(e) => { const n = Number(e.target.value); setBounds(lo, n >= max ? null : fromNum(Math.max(n, loN))) }} />}
        </div>
      )}
      {(info?.nulls ?? 0) > 0 && (
        <label className="check small">
          <input type="checkbox" checked={cond.keep_blanks !== false} onChange={(e) => onChange({ keep_blanks: e.target.checked })} /> Include blanks
        </label>
      )}
    </div>
  )
}

/** Datasets a Join can use: inputs already in the workflow (by their dataset name) and the rest of the Library. */
export interface DatasetChoice {
  label: (role: string) => string
  library: Selection[]
  onPick: (s: Selection) => void
}

export function StepEditor({ step, cols, roleCols, roles, base, onChange, columnValues, datasets, details }: {
  step: Step; cols: Cols; roleCols: Record<string, Cols>; roles: string[]; base: string; onChange: (s: Step) => void
  /** Loads a column's values as they enter this step, for the filter's pickers. */
  columnValues?: ValuesLoader
  datasets?: DatasetChoice
  /** What the last preview reported for this step (e.g. join match counts). */
  details?: Record<string, unknown>
}) {
  const a = step as Rec
  const set = (k: string, v: unknown) => onChange({ ...step, [k]: v })
  const rows = <T extends Rec>(key: string) => (a[key] as T[]) ?? []
  const setRow = (key: string, i: number, patch: Rec) => set(key, rows(key).map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = (key: string, row: Rec) => set(key, [...rows(key), row])
  const delRow = (key: string, i: number) => set(key, rows(key).filter((_, j) => j !== i))
  const del = (i: number, key: string) => <button className="ghost icon" onClick={() => delRow(key, i)} aria-label="Remove">✕</button>
  const otherRoles = roles.filter((r) => r !== base)
  const [added, setAdded] = useState<number | null>(null)   // a filter condition just added opens expanded

  switch (step.op) {
    case 'select_columns':
      return <L label="Keep these columns (in this order)"><ColumnMulti cols={cols} value={a.columns as string[]} onChange={(v) => set('columns', v)} /></L>

    case 'rename_columns': {
      const entries = Object.entries(a.mapping as Record<string, string>)
      const setEntries = (e: [string, string][]) => set('mapping', Object.fromEntries(e))
      return (
        <div>
          {entries.map(([from, to], i) => (
            <div className="cond-row" key={i} style={{ gridTemplateColumns: '1fr auto 1fr auto' }}>
              <ColumnSelect cols={cols} value={from} onChange={(v) => setEntries(entries.map((e, j) => (j === i ? [v, e[1] === e[0] ? v : e[1]] : e)))} />
              <span className="muted">→</span>
              <input value={to} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} aria-label="New name" />
              <button className="ghost icon" onClick={() => setEntries(entries.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
            </div>
          ))}
          <button className="sm" onClick={() => { const c = cols.find((x) => !(x.name in (a.mapping as Rec))); if (c) setEntries([...entries, [c.name, c.name]]) }}>+ Rename another</button>
        </div>
      )
    }

    case 'filter_rows':
      return (
        <div>
          {rows('conditions').length > 1 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="small">Keep rows matching</span>
              <select className="inline-input" value={String(a.match)} onChange={(e) => set('match', e.target.value)}>
                <option value="all">all conditions</option><option value="any">any condition</option>
              </select>
            </div>
          )}
          {rows('conditions').map((c, i) => (
            <FilterCondition key={i} cond={c} cols={cols} load={columnValues} defaultOpen={i === added} onChange={(patch) => setRow('conditions', i, patch)} onRemove={() => delRow('conditions', i)} />
          ))}
          {!rows('conditions').length && <p className="faint small">No conditions — every row is kept.</p>}
          <button className="ghost sm" onClick={() => { setAdded(rows('conditions').length); addRow('conditions', keepAll(cols[0])) }}>+ Add condition</button>
        </div>
      )

    case 'sort_rows':
      return (
        <div>
          {rows('keys').map((k, i) => (
            <div className="cond-row" key={i} style={{ gridTemplateColumns: '1fr auto auto' }}>
              <ColumnSelect cols={cols} value={String(k.column)} onChange={(v) => setRow('keys', i, { column: v })} />
              <select value={k.descending ? 'desc' : 'asc'} onChange={(e) => setRow('keys', i, { descending: e.target.value === 'desc' })} aria-label="Direction">
                <option value="asc">A→Z / smallest first</option><option value="desc">Z→A / largest first</option>
              </select>
              {del(i, 'keys')}
            </div>
          ))}
          <button className="sm" onClick={() => addRow('keys', { column: cols[0]?.name ?? '', descending: false })}>+ Then by</button>
        </div>
      )

    case 'append_rows':
      return (
        <div className="stack">
          {!(a.inputs as string[]).length && <div className="drop-tip">⇣ Drag tables from the Library onto this Append box, or tick inputs below.</div>}
          <L label="Stack these inputs below the current table">
            <div className="row">
              {otherRoles.length === 0 && <span className="muted small">Add another input first.</span>}
              {otherRoles.map((r) => (
                <label className="check" key={r}>
                  <input type="checkbox" checked={(a.inputs as string[]).includes(r)} onChange={(e) => set('inputs', e.target.checked ? [...(a.inputs as string[]), r] : (a.inputs as string[]).filter((x) => x !== r))} /> {r}
                </label>
              ))}
            </div>
          </L>
          <label className="check small"><input type="checkbox" checked={Boolean(a.allow_missing_columns)} onChange={(e) => set('allow_missing_columns', e.target.checked)} /> Allow different columns (fill gaps with blanks)</label>
        </div>
      )

    case 'join': {
      const right = String(a.right)
      const rcols = roleCols[right] ?? []
      const left = a.left_on as string[]
      const rightOn = a.right_on as string[]
      const nameOf = (r: string) => datasets?.label(r) ?? r
      const pick = (v: string) => {
        if (v.startsWith('lib:')) {
          const s = datasets?.library.find((x) => x.id === v.slice(4))
          if (s) datasets!.onPick(s)
        } else set('right', v)
      }
      return (
        <div className="stack">
          {!right && <div className="drop-tip">⇣ Drag a table from the Library onto this Join box, or choose a dataset below.</div>}
          <L label="Choose dataset">
            <select value={right} onChange={(e) => pick(e.target.value)}>
              <option value="">Choose dataset…</option>
              {otherRoles.length > 0 && (
                <optgroup label="In this workflow">
                  {otherRoles.map((r) => <option key={r} value={r}>{nameOf(r)}{nameOf(r) !== r ? ` (${r})` : ''}</option>)}
                </optgroup>
              )}
              {datasets && datasets.library.length > 0 && (
                <optgroup label="From your Library">
                  {datasets.library.map((s) => <option key={s.id} value={`lib:${s.id}`}>{s.label}</option>)}
                </optgroup>
              )}
            </select>
          </L>
          <div>
            <span className="label small" style={{ fontWeight: 600 }}>Join type</span>
            <JoinVenn how={String(a.how) as JoinHow} onChange={(how) => set('how', how)} leftLabel="current table"
              rightLabel={right ? nameOf(right) : 'the other dataset'} stats={details as { matched?: number }} />
          </div>
          <div className="subgrid">
            <L label="Expected match">
              <select value={String(a.expected)} onChange={(e) => set('expected', e.target.value)}>
                <option value="many_to_one">Each row finds at most one match</option>
                <option value="one_to_one">One-to-one</option>
                <option value="one_to_many">One current row → many lookup rows</option>
                <option value="many_to_many">Many-to-many (may multiply rows)</option>
              </select>
            </L>
          </div>
          <div>
            <span className="label small" style={{ fontWeight: 600 }}>Match on</span>
            {left.map((l, i) => (
              <div className="cond-row" key={i} style={{ gridTemplateColumns: '1fr auto 1fr auto' }}>
                <ColumnSelect cols={cols} value={l} allowEmpty onChange={(v) => set('left_on', left.map((x, j) => (j === i ? v : x)))} />
                <span className="muted">=</span>
                <ColumnSelect cols={rcols} value={rightOn[i] ?? ''} allowEmpty onChange={(v) => set('right_on', left.map((_, j) => (j === i ? v : rightOn[j] ?? '')))} />
                <button className="ghost icon" disabled={left.length === 1} onClick={() => onChange({ ...step, left_on: left.filter((_, j) => j !== i), right_on: rightOn.filter((_, j) => j !== i) })} aria-label="Remove key">✕</button>
              </div>
            ))}
            <button className="sm" onClick={() => onChange({ ...step, left_on: [...left, ''], right_on: [...rightOn, ''] })}>+ Another key</button>
          </div>
          <L label="Columns to bring in (empty = all)">
            <ColumnMulti cols={rcols.filter((c) => !rightOn.includes(c.name))} value={(a.right_columns as string[]) ?? []} onChange={(v) => set('right_columns', v.length ? v : undefined)} />
          </L>
        </div>
      )
    }

    case 'deduplicate':
      return (
        <div className="stack">
          <L label="Rows are duplicates when these columns match (empty = all columns)">
            <ColumnMulti cols={cols} value={(a.columns as string[]) ?? []} onChange={(v) => set('columns', v.length ? v : null)} />
          </L>
          <L label="Keep">
            <select value={String(a.keep)} onChange={(e) => set('keep', e.target.value)}><option value="first">First occurrence</option><option value="last">Last occurrence</option></select>
          </L>
        </div>
      )

    case 'convert_types':
      return (
        <div>
          {rows('conversions').map((c, i) => (
            <div className="cond-row" key={i}>
              <ColumnSelect cols={cols} value={String(c.column)} onChange={(v) => setRow('conversions', i, { column: v })} />
              <select value={String(c.to)} onChange={(e) => setRow('conversions', i, { to: e.target.value })} aria-label="Convert to">
                {['text', 'integer', 'number', 'date', 'boolean'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {c.to === 'date' ? (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input placeholder="format, e.g. %d/%m/%Y (optional)" value={String(c.date_format ?? '')} onChange={(e) => setRow('conversions', i, { date_format: e.target.value || undefined })} />
                  <label className="check small nowrap"><input type="checkbox" checked={Boolean(c.dayfirst)} onChange={(e) => setRow('conversions', i, { dayfirst: e.target.checked })} /> day first</label>
                </div>
              ) : <span />}
              {del(i, 'conversions')}
            </div>
          ))}
          <div className="row">
            <button className="sm" onClick={() => addRow('conversions', { column: cols[0]?.name ?? '', to: 'number' })}>+ Column</button>
            <span className="spacer" />
            <span className="small muted">Values that cannot convert:</span>
            <select className="inline-input" value={String(a.on_error)} onChange={(e) => set('on_error', e.target.value)}><option value="blank">become blank (with a warning)</option><option value="fail">stop the run</option></select>
          </div>
        </div>
      )

    case 'derive_column':
      return (
        <div className="stack">
          <L label="New column name"><input value={String(a.name)} onChange={(e) => set('name', e.target.value)} /></L>
          <L label="Formula">
            <textarea className="code" rows={2} value={String(a.expression)} onChange={(e) => set('expression', e.target.value)} placeholder="[Quantity] * [Unit Price]" />
          </L>
          <div className="chips">
            {cols.slice(0, 40).map((c) => (
              <button key={c.name} className="sm" onClick={() => set('expression', `${a.expression}${String(a.expression).endsWith(' ') || !a.expression ? '' : ' '}[${c.name}]`)}>[{c.name}]</button>
            ))}
          </div>
          <p className="faint small">Use + − * /, comparisons (= &lt;&gt; &gt; &lt;), AND/OR/NOT, and functions: round, abs, upper, lower, trim, len, concat, if(cond, a, b), coalesce, year, month, day, isblank. Text goes in 'quotes'.</p>
        </div>
      )

    case 'group_aggregate':
      return (
        <div className="stack">
          <L label="Group by (empty = one summary row)"><ColumnMulti cols={cols} value={a.group_by as string[]} onChange={(v) => set('group_by', v)} /></L>
          <div>
            <span className="label small" style={{ fontWeight: 600 }}>Calculate</span>
            {rows('aggregations').map((g, i) => (
              <div className="cond-row" key={i}>
                <select value={String(g.function)} onChange={(e) => setRow('aggregations', i, { function: e.target.value })} aria-label="Function">
                  {AGGS.map((f) => <option key={f} value={f}>{AGG_LABEL[f] ?? f}</option>)}
                </select>
                <ColumnSelect cols={cols} value={String(g.column)} onChange={(v) => setRow('aggregations', i, { column: v })} />
                <input placeholder="Result name" value={String(g.as ?? '')} onChange={(e) => setRow('aggregations', i, { as: e.target.value || undefined })} aria-label="Result name" />
                {del(i, 'aggregations')}
              </div>
            ))}
            <button className="sm" onClick={() => addRow('aggregations', { column: cols[0]?.name ?? '', function: 'count' })}>+ Calculation</button>
          </div>
        </div>
      )

    case 'pivot':
      return (
        <div className="subgrid">
          <L label="Rows"><ColumnMulti cols={cols} value={a.index as string[]} onChange={(v) => set('index', v)} /></L>
          <L label="Columns from values of"><ColumnSelect cols={cols} value={String(a.columns ?? '')} onChange={(v) => set('columns', v)} /></L>
          <L label="Values"><ColumnSelect cols={cols} value={String(a.values ?? '')} onChange={(v) => set('values', v)} /></L>
          <L label="Combine with">
            <select value={String(a.function)} onChange={(e) => set('function', e.target.value)}>{AGGS.map((f) => <option key={f} value={f}>{AGG_LABEL[f] ?? f}</option>)}</select>
          </L>
        </div>
      )

    case 'unpivot':
      return (
        <div className="stack">
          <L label="Keep as identifier columns"><ColumnMulti cols={cols} value={a.id_columns as string[]} onChange={(v) => set('id_columns', v)} /></L>
          <L label="Turn these columns into rows (empty = all others)"><ColumnMulti cols={cols.filter((c) => !(a.id_columns as string[]).includes(c.name))} value={(a.value_columns as string[]) ?? []} onChange={(v) => set('value_columns', v.length ? v : undefined)} /></L>
          <div className="subgrid">
            <L label="Name for the old column names"><input value={String(a.variable_name)} onChange={(e) => set('variable_name', e.target.value)} /></L>
            <L label="Name for the values"><input value={String(a.value_name)} onChange={(e) => set('value_name', e.target.value)} /></L>
          </div>
        </div>
      )

    default:
      return <pre className="prompt">{JSON.stringify(step, null, 2)}</pre>
  }
}
