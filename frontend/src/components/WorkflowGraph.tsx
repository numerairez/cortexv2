import type { ReactNode } from 'react'
import type { ExtraOutput, Recipe, Step } from '../types'
import { OP_COLOR, OpIcon } from './Icons'
import { OP_LABEL } from './StepEditor'

const COL = 104
const LANE = 78
const PAD_X = 52
const PAD_Y = 30

/** Inputs a step reads besides the table flowing through it. */
const refs = (s: Step): string[] => (s.op === 'join' ? [String(s.right ?? '')].filter(Boolean) : s.op === 'append_rows' ? (s.inputs as string[]) ?? [] : [])
const label = (name: string) => name.replace(/\{(date|time)\}/g, '').trim().replace(/^[-_ ]+|[-_ ]+$/g, '') || name

/**
 * A small read-only picture of a workflow: inputs, their own steps, the main flow, and its outputs.
 * `highlight` is the output to emphasise ("main" for the Result, or an extra output's id).
 */
export function WorkflowGraph({ recipe, highlight, inputLabel }: {
  recipe: Recipe; highlight?: string; inputLabel?: (role: string) => string
}) {
  const n = recipe.steps.length
  const secondary = recipe.inputs.filter((i) => i.role !== recipe.base)
  const laneOf: Record<string, number> = Object.fromEntries(secondary.map((inp, k) => [inp.role, k + 1]))
  const stepsOf = (role: string) => secondary.find((i) => i.role === role)?.steps ?? []
  const starts: Record<string, number> = {}
  const placing = new Set<string>()
  const targetOf = (role: string): { lane: number; col: number } | null => {
    const m = recipe.steps.findIndex((s) => refs(s).includes(role))
    if (m >= 0) return { lane: 0, col: m + 1 }
    for (const other of secondary) {
      const j = other.role === role ? -1 : (other.steps ?? []).findIndex((s) => refs(s).includes(role))
      if (j >= 0) return { lane: laneOf[other.role], col: startOf(other.role) + 1 + j }
    }
    return null
  }
  const startOf = (role: string): number => {
    if (role in starts) return starts[role]
    if (placing.has(role)) return 0
    placing.add(role)
    const t = targetOf(role)
    starts[role] = t ? t.col - 1 - stepsOf(role).length : 0
    return starts[role]
  }
  const rows = secondary.map((inp) => ({ role: inp.role, steps: inp.steps ?? [], lane: laneOf[inp.role], start: startOf(inp.role), target: targetOf(inp.role) }))

  const extras: ExtraOutput[] = recipe.extra_outputs ?? []
  const busy = new Set<string>()
  const outs = extras.map((o) => {
    const r = o.branch && o.branch !== recipe.base ? rows.find((x) => x.role === o.branch) : undefined
    const from = r ? { lane: r.lane, col: r.start + (o.after < 0 ? 0 : 1 + o.after) } : { lane: 0, col: o.branch || o.after < 0 ? 0 : o.after + 1 }
    const col = from.col + 1
    let lane = Math.max(1 + secondary.length, from.lane + 1)
    while (busy.has(`${lane}:${col}`)) lane++
    busy.add(`${lane}:${col}`)
    return { o, from, col, lane }
  })

  const ox = -Math.min(0, ...rows.map((r) => r.start))
  const pos = (col: number, lane: number) => ({ x: PAD_X + (col + ox) * COL, y: PAD_Y + lane * LANE })
  const lanes = Math.max(1 + secondary.length, ...outs.map((x) => x.lane + 1))
  const maxCol = Math.max(n + 1, ...rows.map((r) => r.start + r.steps.length), ...outs.map((x) => x.col)) + ox
  const width = PAD_X * 2 + maxCol * COL
  const height = PAD_Y + lanes * LANE

  const edges: ReactNode[] = []
  const curve = (a: { col: number; lane: number }, b: { col: number; lane: number }, key: string, dashed = false) => {
    const p = pos(a.col, a.lane)
    const q = pos(b.col, b.lane)
    const mx = (p.x + q.x) / 2
    edges.push(<path key={key} d={`M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`} className={`wf-edge${dashed ? ' dashed' : ''}`} />)
  }
  for (let c = 0; c <= n; c++) curve({ col: c, lane: 0 }, { col: c + 1, lane: 0 }, `m${c}`)
  for (const r of rows) {
    for (let c = r.start; c < r.start + r.steps.length; c++) curve({ col: c, lane: r.lane }, { col: c + 1, lane: r.lane }, `b${r.role}${c}`)
    if (r.target) curve({ col: r.start + r.steps.length, lane: r.lane }, r.target, `s${r.role}`)
  }
  for (const x of outs) curve(x.from, { col: x.col, lane: x.lane }, `o${x.o.id}`, true)

  const node = (key: string, col: number, lane: number, body: ReactNode, name: string, opts: { color?: string; kind?: string; hot?: boolean; title?: string } = {}) => {
    const { x, y } = pos(col, lane)
    return (
      <div key={key} className={`wf-node${opts.kind ? ` ${opts.kind}` : ''}${opts.hot ? ' hot' : ''}`} style={{ left: x, top: y }} title={opts.title ?? name}>
        <span className="wf-shape" style={opts.color ? { background: opts.color } : undefined}>{body}</span>
        <span className="wf-label ellipsis">{name}</span>
      </div>
    )
  }
  const inputNode = (role: string, col: number, lane: number) =>
    node(`in-${role}`, col, lane, <span className="wf-input-glyph">▦</span>, inputLabel?.(role) ?? role, { kind: 'input', title: `Input: ${inputLabel?.(role) ?? role}` })
  const stepNode = (s: Step, key: string, col: number, lane: number) =>
    node(key, col, lane, <OpIcon op={s.op} size={15} color="#fff" />, OP_LABEL[s.op] ?? s.op, { color: OP_COLOR[s.op] })

  return (
    <div className="wf-graph" role="img" aria-label="Workflow diagram">
      <div className="wf-flow" style={{ width, height }}>
        <svg className="wf-edges" width={width} height={height}>{edges}</svg>
        {inputNode(recipe.base, 0, 0)}
        {recipe.steps.map((s, i) => stepNode(s, `m${i}`, i + 1, 0))}
        {node('result', n + 1, 0, <OpIcon op="output" size={15} color="#fff" />, highlight === 'main' ? 'This dataset' : 'Result',
          { color: OP_COLOR.output, kind: 'output', hot: highlight === 'main', title: `Result: ${label(recipe.output.name)}` })}
        {rows.map((r) => (
          <span key={r.role} style={{ display: 'contents' }}>
            {inputNode(r.role, r.start, r.lane)}
            {r.steps.map((s, j) => stepNode(s, `${r.role}-${j}`, r.start + 1 + j, r.lane))}
          </span>
        ))}
        {outs.map(({ o, col, lane }) => node(`out-${o.id}`, col, lane, <OpIcon op="output" size={13} color="#fff" />,
          highlight === o.id ? 'This dataset' : label(o.name), { color: OP_COLOR.output, kind: 'output', hot: highlight === o.id, title: `Output: ${label(o.name)}` }))}
      </div>
    </div>
  )
}
