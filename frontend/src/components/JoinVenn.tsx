import { useId } from 'react'

export type JoinHow = 'inner' | 'left' | 'right' | 'outer'

const TYPES: { how: JoinHow; label: string; help: (l: string, r: string) => string }[] = [
  { how: 'inner', label: 'Inner', help: (l, r) => `Only rows that match in both ${l} and ${r}` },
  { how: 'left', label: 'Left', help: (l, r) => `Every row of ${l}, plus matching columns from ${r}` },
  { how: 'right', label: 'Right', help: (l, r) => `Every row of ${r}, plus matching columns from ${l}` },
  { how: 'outer', label: 'Full outer', help: (l, r) => `Every row of both ${l} and ${r}, matched where possible` },
]

/** Which parts of the two circles a join keeps: left-only, the overlap (always), right-only. */
const keeps = (how: JoinHow) => ({ left: how === 'left' || how === 'outer', right: how === 'right' || how === 'outer' })

/** Two overlapping circles with the kept parts filled, as in Tableau's join picker. */
function Venn({ how, size = 64 }: { how: JoinHow; size?: number }) {
  const id = useId().replace(/:/g, '')
  const k = keeps(how)
  const L = { cx: 25, cy: 20, r: 14 }
  const R = { cx: 39, cy: 20, r: 14 }
  return (
    <svg width={size} height={(size * 40) / 64} viewBox="0 0 64 40" aria-hidden className="venn">
      <defs>
        <clipPath id={`${id}-l`}><circle {...L} /></clipPath>
        <mask id={`${id}-nl`}><rect width="64" height="40" fill="#fff" /><circle {...L} fill="#000" /></mask>
        <mask id={`${id}-nr`}><rect width="64" height="40" fill="#fff" /><circle {...R} fill="#000" /></mask>
      </defs>
      <circle {...L} mask={`url(#${id}-nr)`} className={k.left ? 'on' : 'off'} />
      <circle {...R} mask={`url(#${id}-nl)`} className={k.right ? 'on' : 'off'} />
      <circle {...R} clipPath={`url(#${id}-l)`} className="on" />
      <circle {...L} className="ring" />
      <circle {...R} className="ring" />
    </svg>
  )
}

/** Join type picker: four Venn diagrams (inner, left, right, full outer) and what the choice means. */
export function JoinVenn({ how, onChange, leftLabel, rightLabel, stats }: {
  how: JoinHow; onChange: (how: JoinHow) => void; leftLabel: string; rightLabel: string
  /** Match counts from the last preview of this step, when there is one. */
  stats?: { matched?: number; unmatched_left?: number; unmatched_right?: number }
}) {
  const current = TYPES.find((t) => t.how === how) ?? TYPES[1]
  const parts = stats && [
    stats.matched !== undefined && `${stats.matched.toLocaleString()} matched`,
    stats.unmatched_left ? `${stats.unmatched_left.toLocaleString()} only in ${leftLabel}` : '',
    stats.unmatched_right ? `${stats.unmatched_right.toLocaleString()} only in ${rightLabel}` : '',
  ].filter(Boolean)
  return (
    <div className="join-venn">
      <div className="join-venn-types" role="radiogroup" aria-label="Join type">
        {TYPES.map((t) => (
          <button key={t.how} role="radio" aria-checked={t.how === how} className={`join-venn-type${t.how === how ? ' active' : ''}`}
            onClick={() => onChange(t.how)} title={t.help(leftLabel, rightLabel)}>
            <Venn how={t.how} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="join-venn-legend">
        <span className="ellipsis" title={leftLabel}><b>Left</b> {leftLabel}</span>
        <span className="ellipsis" title={rightLabel}><b>Right</b> {rightLabel}</span>
      </div>
      <div className="small join-venn-help">{current.help(leftLabel, rightLabel)}.{parts && parts.length > 0 && <span className="faint"> Last preview: {parts.join(' · ')}.</span>}</div>
    </div>
  )
}
