import type { Cell } from '../types'

export function fmt(v: Cell) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 6 })
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(v)) return v.slice(0, 10)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.replace('T', ' ').slice(0, 16)
  return String(v)
}

export function DataTable({ columns, rows, firstRowNumber, maxHeight = 420, types }: {
  columns: string[]; rows: Cell[][]; firstRowNumber?: number; maxHeight?: number; types?: Record<string, string>
}) {
  return (
    <div className="table-wrap" style={{ maxHeight }}>
      <table className="data">
        <thead>
          <tr>
            {firstRowNumber !== undefined && <th className="rownum">Row</th>}
            {columns.map((c) => (
              <th key={c} title={types?.[c]}>
                {c}
                {types?.[c] && <div className="faint" style={{ fontWeight: 400, fontSize: 11 }}>{types[c]}</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {firstRowNumber !== undefined && <td className="rownum">{firstRowNumber + i}</td>}
              {r.map((v, j) => (
                <td key={j} className={v === null ? 'null' : typeof v === 'number' ? 'num' : ''} title={v === null ? '' : String(v)}>
                  {v === null ? '—' : fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
