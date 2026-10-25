import { useMemo, useState } from 'react'
import {
  PIVOT_OTHER, compareHeads, fmtValue, measureLabel, norm, pivotTable, pivotUnitFor,
  type ColType, type TimeUnit, type PivotHead, type PivotRow, type Row, type Sel, type TableWidget,
} from '../../dashboard'

type Tuple = Record<string, unknown>
const COUNT = { agg: 'count' as const }
type SortBy = { by: 'label' | 'total' | string; desc: boolean }

const sameKeys = (t: Tuple, vals: Tuple) => {
  const k = Object.keys(t)
  return k.length === Object.keys(vals).length && k.every((f) => f in vals)
}
/** A pick covers a cell when every field it names has that cell's value (a row pick covers its whole row). */
const covers = (t: Tuple, vals: Tuple) => Object.keys(t).length > 0 && Object.keys(t).every((f) => f in vals && norm(t[f]) === norm(vals[f]))

export function PivotBody({ w, rows, types, highlight, drive, selection, onSelect }: {
  w: TableWidget; rows: Row[]; types: Record<string, ColType>
  highlight: ((r: Row) => boolean) | null
  /** Other objects listen to this pivot: cells and headings become clickable. */
  drive: boolean; selection: Sel | null; onSelect?: (s: Sel | null) => void
}) {
  const [sort, setSort] = useState<SortBy | null>(null)
  const rowFields = w.groupBy
  const colField = w.pivotColumn
  const measure = w.pivotValue ?? COUNT
  const showTotals = w.totals !== false

  // Date fields are bucketed; unless the user chose a bucket, it follows each field's time span.
  const units = useMemo(() => {
    const out: Record<string, TimeUnit> = {}
    for (const f of [...rowFields, ...(colField ? [colField] : [])]) if (types[f] === 'date') out[f] = w.timeUnit ?? pivotUnitFor(rows, f)
    return out
  }, [rows, rowFields, colField, types, w.timeUnit])

  const pivot = useMemo(() => pivotTable(rows, rowFields, colField, measure, {
    types, top: w.pivotTop ?? 12, unit: (f) => units[f] ?? 'yearmonth', highlight,
  }), [rows, rowFields, colField, measure, types, w.pivotTop, units, highlight])

  const sorted = useMemo(() => {
    if (!sort) return pivot.rows
    const dir = sort.desc ? -1 : 1
    const val = (r: PivotRow) => (sort.by === 'total' ? r.total : r.cells[sort.by]) ?? null
    return [...pivot.rows].sort((a, b) => {
      if (sort.by === 'label') { for (let j = 0; j < a.heads.length; j++) { const c = compareHeads(a.heads[j], b.heads[j]); if (c) return c * dir } return 0 }
      const x = val(a), y = val(b)
      return x == null ? 1 : y == null ? -1 : (x - y) * dir
    })
  }, [pivot.rows, sort])

  const heatMax = useMemo(() => {
    if (!w.heat) return 0
    let m = 0
    for (const r of pivot.rows) for (const v of Object.values(r.cells)) if (v != null) m = Math.max(m, Math.abs(v))
    return m
  }, [pivot.rows, w.heat])

  if (!colField) return <div className="dash-placeholder">Pick a field to spread across the columns</div>

  const tuples = selection?.kind === 'point' ? selection.tuples : []
  const rowVals = (r: PivotRow): Tuple => Object.fromEntries(rowFields.map((f, j) => [f, r.heads[j].value]))
  const colVals = (c: PivotHead): Tuple => ({ [colField]: c.value })
  const pickedCell = (vals: Tuple) => tuples.some((t) => covers(t, vals))
  const pickedHead = (vals: Tuple) => tuples.some((t) => sameKeys(t, vals) && covers(t, vals))
  const pick = (vals: Tuple, e: React.MouseEvent) => {
    if (!drive || !onSelect) return
    const has = tuples.some((t) => sameKeys(t, vals) && covers(t, vals))
    const multi = e.shiftKey || e.ctrlKey || e.metaKey
    const rest = tuples.filter((t) => !(sameKeys(t, vals) && covers(t, vals)))
    const next = multi ? (has ? rest : [...tuples, vals]) : has && tuples.length === 1 ? [] : [vals]
    onSelect(next.length ? { kind: 'point', tuples: next } : null)
  }
  const sortBy = (by: string) => setSort((s) => (s?.by === by ? (s.desc ? { by, desc: false } : null) : { by, desc: by !== 'label' }))
  const arrow = (by: string) => (sort?.by === by ? (sort.desc ? ' ↓' : ' ↑') : '')
  const fmt = (v: number | null | undefined) => (v == null ? '' : fmtValue(v, 'number', false))
  const heat = (v: number | null | undefined) => (heatMax && v != null
    ? { background: `color-mix(in srgb, var(--accent) ${Math.round((Math.abs(v) / heatMax) * 34)}%, transparent)` } : undefined)
  const hlClass = (on: boolean) => (highlight ? (on ? ' hl' : ' dimmed') : '')
  const visible = sorted.slice(0, w.limit)

  return (
    <div className={`dash-table pivot${drive ? ' clickable' : ''}`}>
      <div className="table-wrap">
        <table className="data pivot-table">
          <thead>
            <tr>
              {(rowFields.length ? rowFields : ['']).map((f, j) => (
                <th key={f || j} rowSpan={2} className={`rowhead${j === 0 ? ' sticky' : ''}`}>
                  {f && <button className="th-sort" onClick={() => sortBy('label')} title="Sort rows">{f}{j === 0 && arrow('label')}</button>}
                </th>
              ))}
              <th colSpan={pivot.cols.length} className="col-caption">{colField} <span className="faint">· {measureLabel(measure)}</span></th>
              {showTotals && <th rowSpan={2} className="num total"><button className="th-sort" onClick={() => sortBy('total')} title="Sort by total">Total{arrow('total')}</button></th>}
            </tr>
            <tr>
              {pivot.cols.map((c) => {
                const other = c.key === PIVOT_OTHER
                return (
                  <th key={c.key} className={`num colhead${!other && pickedHead(colVals(c)) ? ' picked' : ''}${hlClass(pivot.colHl.has(c.key))}`}>
                    <span className="colhead-inner">
                      <button className={`th-sort${drive && !other ? ' pick' : ''}`} title={drive && !other ? `Pick ${c.label}` : 'Sort by this column'}
                        onClick={(e) => (drive && !other ? pick(colVals(c), e) : sortBy(c.key))}>{c.label}{arrow(c.key)}</button>
                      {drive && <button className="sort-mini" onClick={() => sortBy(c.key)} title="Sort by this column" aria-label={`Sort by ${c.label}`}>⇅</button>}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const rv = rowVals(r)
              return (
                <tr key={r.key}>
                  {(r.heads.length ? r.heads : [{ key: 'all', label: 'All rows', value: null, sort: 0 }]).map((h, j) => (
                    <th key={j} scope="row" className={`rowhead${j === 0 ? ' sticky' : ''}${r.heads.length && pickedHead(rv) ? ' picked' : ''}${hlClass(r.hlAny)}`}
                      onClick={(e) => r.heads.length && pick(rv, e)}>{h.label}</th>
                  ))}
                  {pivot.cols.map((c) => {
                    const other = c.key === PIVOT_OTHER
                    const vals = other ? rv : { ...rv, ...colVals(c) }
                    const v = r.cells[c.key]
                    return (
                      <td key={c.key} className={`num cell${v == null ? ' empty' : ''}${pickedCell(vals) && !other ? ' picked' : ''}${hlClass(r.hl.has(c.key))}${other ? ' other' : ''}`}
                        style={heat(v)} onClick={(e) => !other && v != null && pick(vals, e)}>{fmt(v)}</td>
                    )
                  })}
                  {showTotals && <td className={`num total${hlClass(r.hlAny)}`}>{fmt(r.total)}</td>}
                </tr>
              )
            })}
          </tbody>
          {showTotals && (
            <tfoot>
              <tr>
                <th colSpan={Math.max(1, rowFields.length)} className="rowhead sticky">Total</th>
                {pivot.cols.map((c) => <td key={c.key} className="num total">{fmt(pivot.colTotals[c.key])}</td>)}
                <td className="num grand">{fmt(pivot.grand)}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {!visible.length && <div className="empty small">No rows.</div>}
      </div>
      {(sorted.length > visible.length || pivot.folded > 0) && (
        <div className="dash-table-foot faint small">
          {sorted.length > visible.length && <>Showing {visible.length.toLocaleString()} of {sorted.length.toLocaleString()} rows. </>}
          {pivot.folded > 0 && <>{pivot.folded} column{pivot.folded === 1 ? '' : 's'} combined into “{pivot.cols.find((c) => c.key === PIVOT_OTHER)?.label.replace(/ \(\d+\)$/, '')}”.</>}
        </div>
      )}
    </div>
  )
}
