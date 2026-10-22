import type { ColumnSchema, Step } from '../types'

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
  ['not_in', 'is not one of'], ['is_blank', 'is blank'], ['not_blank', 'is not blank'],
]
const AGGS = ['sum', 'mean', 'median', 'min', 'max', 'count', 'count_distinct', 'first', 'last']
const AGG_LABEL: Record<string, string> = { mean: 'average', count_distinct: 'count distinct' }

/** A sensible starting configuration for a newly added step. */
export function newStep(op: string, cols: Cols, roles: string[], base: string): Step {
  const first = cols[0]?.name ?? ''
  const num = cols.find((c) => c.type === 'number' || c.type === 'integer')?.name ?? first
  const otherRole = roles.find((r) => r !== base) ?? ''
  switch (op) {
    case 'select_columns': return { op, columns: cols.map((c) => c.name) }
    case 'rename_columns': return { op, mapping: { [first]: first } }
    case 'filter_rows': return { op, match: 'all', conditions: [{ column: first, operator: 'eq', value: '' }] }
    case 'sort_rows': return { op, keys: [{ column: first, descending: false }] }
    case 'append_rows': return { op, inputs: otherRole ? [otherRole] : [], allow_missing_columns: false }
    case 'join': return { op, right: otherRole, left_on: [first], right_on: [''], how: 'left', expected: 'many_to_one' }
    case 'deduplicate': return { op, columns: [first], keep: 'first' }
    case 'convert_types': return { op, conversions: [{ column: first, to: 'number' }], on_error: 'blank' }
    case 'derive_column': return { op, name: 'New column', expression: '' }
    case 'group_aggregate': return { op, group_by: [first], aggregations: [{ column: num, function: 'sum', as: `Total ${num}` }] }
    case 'pivot': return { op, index: [first], columns: cols[1]?.name ?? first, values: num, function: 'sum' }
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
    case 'filter_rows': return (a.conditions as Rec[]).map((c) => `${c.column} ${OPERATORS.find((o) => o[0] === c.operator)?.[1] ?? c.operator}${['is_blank', 'not_blank'].includes(String(c.operator)) ? '' : ` ${Array.isArray(c.value) ? c.value.join('/') : c.value}`}`).join(a.match === 'any' ? ' OR ' : ' AND ')
    case 'sort_rows': return (a.keys as Rec[]).map((k) => `${k.column}${k.descending ? ' ↓' : ' ↑'}`).join(', ')
    case 'append_rows': return `+ ${list(a.inputs)}`
    case 'join': return `${a.how} join ${a.right} on ${list(a.left_on)} = ${list(a.right_on)}`
    case 'deduplicate': return a.columns ? `by ${list(a.columns)}` : 'identical rows'
    case 'convert_types': return (a.conversions as Rec[]).map((c) => `${c.column} → ${c.to}`).join(', ')
    case 'derive_column': return `${a.name} = ${a.expression}`
    case 'group_aggregate': return `by ${list(a.group_by) || '(all rows)'}: ${(a.aggregations as Rec[]).map((g) => `${AGG_LABEL[String(g.function)] ?? g.function}(${g.column})`).join(', ')}`
    case 'pivot': return `${a.values} by ${list(a.index)} × ${a.columns}`
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

export function StepEditor({ step, cols, roleCols, roles, base, onChange }: {
  step: Step; cols: Cols; roleCols: Record<string, Cols>; roles: string[]; base: string; onChange: (s: Step) => void
}) {
  const a = step as Rec
  const set = (k: string, v: unknown) => onChange({ ...step, [k]: v })
  const rows = <T extends Rec>(key: string) => (a[key] as T[]) ?? []
  const setRow = (key: string, i: number, patch: Rec) => set(key, rows(key).map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = (key: string, row: Rec) => set(key, [...rows(key), row])
  const delRow = (key: string, i: number) => set(key, rows(key).filter((_, j) => j !== i))
  const del = (i: number, key: string) => <button className="ghost icon" onClick={() => delRow(key, i)} aria-label="Remove">✕</button>
  const otherRoles = roles.filter((r) => r !== base)

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
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="small">Keep rows matching</span>
            <select className="inline-input" value={String(a.match)} onChange={(e) => set('match', e.target.value)}>
              <option value="all">all conditions</option><option value="any">any condition</option>
            </select>
          </div>
          {rows('conditions').map((c, i) => {
            const noValue = ['is_blank', 'not_blank'].includes(String(c.operator))
            const multi = ['in', 'not_in'].includes(String(c.operator))
            return (
              <div className="cond-row" key={i}>
                <ColumnSelect cols={cols} value={String(c.column)} onChange={(v) => setRow('conditions', i, { column: v })} />
                <select value={String(c.operator)} onChange={(e) => setRow('conditions', i, { operator: e.target.value, value: ['in', 'not_in'].includes(e.target.value) ? [] : ['is_blank', 'not_blank'].includes(e.target.value) ? null : '' })} aria-label="Operator">
                  {OPERATORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {noValue ? <span /> : (
                  <input
                    value={multi ? (Array.isArray(c.value) ? (c.value as string[]).join(', ') : '') : String(c.value ?? '')}
                    placeholder={multi ? 'a, b, c' : 'value'}
                    onChange={(e) => setRow('conditions', i, { value: multi ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value })}
                    aria-label="Value"
                  />
                )}
                {del(i, 'conditions')}
              </div>
            )
          })}
          <button className="sm" onClick={() => addRow('conditions', { column: cols[0]?.name ?? '', operator: 'eq', value: '' })}>+ Condition</button>
          <p className="faint small" style={{ marginTop: 6 }}>Text comparisons ignore upper/lower case. Numbers and dates are compared as values.</p>
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
      return (
        <div className="stack">
          <div className="subgrid">
            <L label="Look up in">
              <select value={right} onChange={(e) => set('right', e.target.value)}>
                <option value="">Choose input…</option>
                {otherRoles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </L>
            <L label="Keep rows">
              <select value={String(a.how)} onChange={(e) => set('how', e.target.value)}>
                <option value="left">All current rows (left)</option>
                <option value="inner">Only matched rows (inner)</option>
                <option value="outer">All rows from both (outer)</option>
                <option value="right">All rows from lookup (right)</option>
              </select>
            </L>
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
                <ColumnSelect cols={cols} value={l} onChange={(v) => set('left_on', left.map((x, j) => (j === i ? v : x)))} />
                <span className="muted">=</span>
                <ColumnSelect cols={rcols} value={rightOn[i] ?? ''} allowEmpty onChange={(v) => set('right_on', left.map((_, j) => (j === i ? v : rightOn[j] ?? '')))} />
                <button className="ghost icon" disabled={left.length === 1} onClick={() => onChange({ ...step, left_on: left.filter((_, j) => j !== i), right_on: rightOn.filter((_, j) => j !== i) })} aria-label="Remove key">✕</button>
              </div>
            ))}
            <button className="sm" onClick={() => onChange({ ...step, left_on: [...left, cols[0]?.name ?? ''], right_on: [...rightOn, ''] })}>+ Another key</button>
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
          <L label="Columns from values of"><ColumnSelect cols={cols} value={String(a.columns)} onChange={(v) => set('columns', v)} /></L>
          <L label="Values"><ColumnSelect cols={cols} value={String(a.values)} onChange={(v) => set('values', v)} /></L>
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
