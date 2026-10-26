import { useMemo, useState, type ReactNode } from 'react'
import {
  additive, aggregate, defaultSelectBy, fmtCell, fmtValue, groupRows, matches, measureLabel, norm,
  type ChartKind, type ChartWidget, type ColType, type HeadlineWidget, type Row, type Sel, type TableWidget, type Widget,
} from '../../dashboard'
import { buildSpec } from './vegaSpec'
import { chartData } from './chartData'
import { VegaChart } from './VegaChart'

// ---------------------------------------------------------------- icons

const CHART_PATHS: Record<ChartKind, ReactNode> = {
  bar: <path d="M5 20V12M10 20V6M15 20v-9M20 20V9" strokeWidth="3" />,
  hbar: <path d="M4 5h9M4 10h15M4 15h7M4 20h12" strokeWidth="3" />,
  line: <path d="M3 17l5-6 4 3 4-7 5 4" />,
  area: <><path d="M3 18l5-7 4 3 4-6 5 4v6H3z" fill="currentColor" fillOpacity=".25" /><path d="M3 18l5-7 4 3 4-6 5 4" /></>,
  scatter: <><circle cx="6" cy="16" r="1.6" fill="currentColor" /><circle cx="10" cy="11" r="1.6" fill="currentColor" /><circle cx="14" cy="14" r="1.6" fill="currentColor" /><circle cx="17" cy="7" r="1.6" fill="currentColor" /><circle cx="19" cy="12" r="1.6" fill="currentColor" /></>,
  donut: <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5A7.5 7.5 0 0 1 19.5 12" strokeWidth="4" /></>,
  heatmap: <><rect x="4" y="4" width="7" height="7" rx="1" fill="currentColor" fillOpacity=".8" /><rect x="13" y="4" width="7" height="7" rx="1" fill="currentColor" fillOpacity=".3" /><rect x="4" y="13" width="7" height="7" rx="1" fill="currentColor" fillOpacity=".45" /><rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" fillOpacity=".9" /></>,
}
const TYPE_PATHS = {
  headline: <><path d="M4 7h7M4 17h16" /><path d="M14 4v9M17.5 4v9M12.5 7h7M12.5 10.5h7" /></>,
  table: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" /></>,
}

export function WidgetIcon({ w, type, chart, size = 18 }: { w?: Widget; type?: Widget['type']; chart?: ChartKind; size?: number }) {
  const t = w?.type ?? type ?? 'chart'
  const k = w?.type === 'chart' ? w.chart : chart ?? 'bar'
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {t === 'chart' ? CHART_PATHS[k] : TYPE_PATHS[t]}
    </svg>
  )
}

export const CHART_LABEL: Record<ChartKind, string> = {
  bar: 'Columns', hbar: 'Bars', line: 'Line', area: 'Area', scatter: 'Scatter', donut: 'Donut', heatmap: 'Heatmap',
}
export const TYPE_LABEL: Record<Widget['type'], string> = { headline: 'Headline', chart: 'Chart', table: 'Table' }

// ---------------------------------------------------------------- headline

export function HeadlineBody({ w, rows, highlighted, highlighting }: {
  w: HeadlineWidget; rows: Row[]; highlighted: Row[]; highlighting: boolean
}) {
  const total = aggregate(rows, w.measure)
  const part = highlighting ? aggregate(highlighted, w.measure) : null
  const show = (v: number | null) => `${w.prefix ?? ''}${fmtValue(v, w.format)}${w.suffix ?? ''}`
  const share = part != null && total ? part / total : null
  return (
    <div className="headline">
      <div className="headline-value" title={(highlighting ? part : total)?.toLocaleString()}>{show(highlighting ? part : total)}</div>
      <div className="headline-note">
        {highlighting
          ? additive(w.measure) && share != null
            ? <><span className="share-bar"><span style={{ width: `${Math.min(100, share * 100)}%` }} /></span>{Math.round(share * 100)}% of {show(total)}</>
            : <>All rows: {show(total)}</>
          : w.title !== measureLabel(w.measure) ? measureLabel(w.measure) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- table

export function TableBody({ w, rows, types, highlight, selectBy, selection, onSelect }: {
  w: TableWidget; rows: Row[]; types: Record<string, ColType>
  /** Rows to emphasise (another object highlights this table); null when nothing is highlighted. */
  highlight: ((r: Row) => boolean) | null
  /** Set when other objects listen to this table: a row click selects this field's value. */
  selectBy?: string; selection: Sel | null; onSelect?: (s: Sel | null) => void
}) {
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null)
  const summary = w.mode === 'summary'
  const cols = summary ? [...w.groupBy, ...w.measures.map(measureLabel)] : w.columns
  const numericCol = (c: string) => (summary && !w.groupBy.includes(c)) || types[c] === 'integer' || types[c] === 'number'

  const shown = useMemo(() => {
    let out = summary ? groupRows(rows, w.groupBy, w.measures) : rows
    const s = sort ?? (w.sortBy ? { col: w.sortBy, desc: !!w.sortDesc } : summary && w.measures[0] ? { col: measureLabel(w.measures[0]), desc: true } : null)
    if (s && cols.includes(s.col)) {
      const dir = s.desc ? -1 : 1
      out = [...out].sort((a, b) => {
        const x = norm(a[s.col]) as never, y = norm(b[s.col]) as never
        return x == null ? 1 : y == null ? -1 : x < y ? -dir : x > y ? dir : 0
      })
    }
    if (highlight) out = [...out.filter(highlight), ...out.filter((r) => !highlight(r))]
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, w, sort, highlight])

  const picked = (r: Row) => !!selection && !!selectBy && matches(r, selection)
  const click = (r: Row, e: React.MouseEvent) => {
    if (!selectBy || !onSelect) return
    const tuple = { [selectBy]: r[selectBy] }
    const cur = selection?.kind === 'point' ? selection.tuples : []
    const has = cur.some((t) => norm(t[selectBy]) === norm(r[selectBy]))
    const multi = e.shiftKey || e.ctrlKey || e.metaKey
    const next = multi ? (has ? cur.filter((t) => norm(t[selectBy]) !== norm(r[selectBy])) : [...cur, tuple]) : has && cur.length === 1 ? [] : [tuple]
    onSelect(next.length ? { kind: 'point', tuples: next } : null)
  }
  const visible = shown.slice(0, w.limit)
  return (
    <div className="dash-table">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>{cols.map((c) => {
              const on = sort?.col === c
              return (
                <th key={c} className={numericCol(c) ? 'num' : ''}>
                  <button className="th-sort" onClick={() => setSort(on && sort!.desc ? { col: c, desc: false } : on ? null : { col: c, desc: true })} title="Sort">
                    {c}{on && <span aria-hidden>{sort!.desc ? ' ↓' : ' ↑'}</span>}
                  </button>
                </th>
              )
            })}</tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const hl = highlight?.(r)
              return (
                <tr key={i} className={`${selectBy ? 'clickable' : ''}${picked(r) ? ' picked' : ''}${highlight ? (hl ? ' hl' : ' dimmed') : ''}`}
                  onClick={(e) => click(r, e)}>
                  {cols.map((c) => {
                    const v = r[c]
                    return <td key={c} className={v == null ? 'null' : numericCol(c) ? 'num' : ''}>{v == null ? '' : typeof v === 'number' ? fmtValue(v, 'auto', false) : fmtCell(v)}</td>
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!visible.length && <div className="empty small">No rows{rows.length ? '' : ' match'}.</div>}
      </div>
      {shown.length > visible.length && <div className="dash-table-foot faint small">Showing {visible.length.toLocaleString()} of {shown.length.toLocaleString()} {summary ? 'groups' : 'rows'}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- chart

export function ChartBody({ w, rows, types, drive, highlight, highlightFn, selection, onSelect }: {
  w: ChartWidget; rows: Row[]; types: Record<string, ColType>
  drive: boolean; highlight: boolean
  /** Which rows another object's pick highlights (null while nothing is picked). */
  highlightFn: ((r: Row) => boolean) | null
  selection: Sel | null; onSelect?: (s: Sel | null) => void
}) {
  const selectBy = defaultSelectBy(w, types)
  const { spec, select } = useMemo(() => buildSpec(w, { types, drive, highlight, selectBy }), [w, types, drive, highlight, selectBy])
  const specKey = useMemo(() => JSON.stringify(spec), [spec])
  const data = useMemo(() => chartData(w, rows, types, highlight ? highlightFn : undefined), [w, rows, types, highlight, highlightFn])
  const missing = !w.vegaLite && (!w.x ? 'This chart isn’t set up yet' : w.chart === 'heatmap' && !w.color ? 'Pick the rows for the heatmap' : w.chart === 'scatter' && !w.y.field ? 'Pick a number for the vertical axis' : w.chart === 'donut' && !w.x ? 'Pick what the slices are' : null)
  if (missing) return <div className="dash-placeholder">{missing}</div>
  const note = data.sampled && `A sample of ${data.sampled.shown.toLocaleString()} of ${data.sampled.of.toLocaleString()} points`
  return <VegaChart spec={spec} specKey={specKey} rows={data.rows} note={note || undefined} select={select} active={!!selection} onSelect={onSelect} />
}

// ---------------------------------------------------------------- wireframe skeletons

export function Skeleton({ w }: { w: Widget }) {
  if (w.type === 'headline') {
    return <div className="skel skel-headline"><span className="skel-block" style={{ width: '55%', height: 26 }} /><span className="skel-line" style={{ width: '38%' }} /></div>
  }
  if (w.type === 'table' && w.mode === 'pivot') {
    return (
      <div className="skel skel-pivot">
        {Array.from({ length: 30 }, (_, i) => {
          const head = i < 6 || i % 6 === 0
          return <span key={i} className={head ? 'h' : ''} style={head ? undefined : { opacity: 0.25 + ((i * 7) % 10) / 16 }} />
        })}
      </div>
    )
  }
  if (w.type === 'table') {
    return (
      <div className="skel skel-table">
        <span className="skel-row head" />
        {Array.from({ length: 6 }, (_, i) => <span key={i} className="skel-row" style={{ opacity: 1 - i * 0.12 }} />)}
      </div>
    )
  }
  const k = w.chart
  return (
    <div className="skel skel-chart">
      <svg viewBox="0 0 120 60" preserveAspectRatio={k === 'donut' || k === 'scatter' ? 'xMidYMid meet' : 'none'} aria-hidden>
        {(k === 'bar') && [38, 52, 30, 44, 22, 34].map((h, i) => <rect key={i} x={6 + i * 19} y={60 - h} width="12" height={h} rx="2" />)}
        {k === 'hbar' && [70, 96, 52, 80].map((wd, i) => <rect key={i} x="4" y={4 + i * 14} width={wd} height="9" rx="2" />)}
        {(k === 'line' || k === 'area') && <path d="M2 48 L22 36 L42 40 L62 20 L82 28 L102 12 L118 18" className={k === 'area' ? 'skel-stroke fill' : 'skel-stroke'} />}
        {k === 'area' && <path d="M2 48 L22 36 L42 40 L62 20 L82 28 L102 12 L118 18 L118 60 L2 60Z" className="skel-area" />}
        {k === 'scatter' && [[12, 44], [26, 38], [34, 46], [48, 30], [58, 34], [70, 22], [82, 26], [96, 14], [106, 20]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.2" />)}
        {k === 'donut' && <g transform="translate(60 30)"><circle r="22" className="skel-ring" /><path d="M0 -22 A22 22 0 0 1 21 7" className="skel-ring strong" /></g>}
        {k === 'heatmap' && Array.from({ length: 18 }, (_, i) => <rect key={i} x={6 + (i % 6) * 18.5} y={4 + Math.floor(i / 6) * 18} width="16" height="16" rx="2" style={{ opacity: 0.25 + ((i * 7) % 10) / 14 }} />)}
      </svg>
    </div>
  )
}
