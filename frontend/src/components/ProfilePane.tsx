import { useEffect, useState } from 'react'
import type { Cell } from '../types'
import { fmt } from './DataTable'
import { TypeGlyph } from './Icons'
import { Loading } from './ui'

export interface ColumnProfile {
  name: string; type: string; nulls: number; distinct: number; count: number
  top?: { value: Cell; count: number }[]; other?: number
  bins?: { from: number | string; to: number | string; count: number }[]
}

/** Tableau Prep-style column cards: distribution bars; click a value to keep/exclude it. */
export function ProfilePane({ profile, loading, canFilter, onFilter }: {
  profile?: ColumnProfile[]; loading: boolean; canFilter: boolean; onFilter: (col: string, v: Cell, keep: boolean) => void
}) {
  const [picked, setPicked] = useState<{ col: string; value: Cell } | null>(null)
  useEffect(() => setPicked(null), [profile])
  if (!profile) return <div className="prep-profile">{loading ? <Loading text="Profiling…" /> : <div className="empty small">Column profiles appear here.</div>}</div>
  const range = (v: number | string) => (typeof v === 'number' ? fmt(Number(v.toPrecision(4))) : v)
  return (
    <div className="prep-profile">
      {profile.map((c) => {
        const bars = c.top
          ? [...c.top.map((t) => ({ label: t.value === null ? '(blank)' : fmt(t.value), value: t.value, count: t.count, pickable: true })),
            ...(c.other ? [{ label: `+ ${c.distinct - (c.top?.length ?? 0)} more`, value: null as Cell, count: c.other, pickable: false }] : [])]
          : (c.bins ?? []).map((b) => ({ label: `${range(b.from)} – ${range(b.to)}`, value: null as Cell, count: b.count, pickable: false }))
        if (c.top && c.nulls) bars.push({ label: '(blank)', value: null, count: c.nulls, pickable: true })
        const max = Math.max(1, ...bars.map((b) => b.count))
        const pick = picked?.col === c.name ? picked : null
        return (
          <div className="profile-card" key={c.name}>
            <div className="profile-head">
              <TypeGlyph type={c.type} />
              <span className="ellipsis" title={c.name}>{c.name}</span>
            </div>
            <div className="profile-stats faint">{c.distinct.toLocaleString()} distinct{c.nulls ? ` · ${c.nulls.toLocaleString()} blank` : ''}</div>
            {pick && canFilter && (
              <div className="profile-actions">
                <button className="sm" onClick={() => onFilter(c.name, pick.value, true)}>Keep only</button>
                <button className="sm" onClick={() => onFilter(c.name, pick.value, false)}>Exclude</button>
              </div>
            )}
            <div className="profile-bars">
              {bars.map((b, k) => (
                <div key={k} className={`profile-bar${b.pickable ? ' pickable' : ''}${pick && pick.value === b.value && b.pickable ? ' picked' : ''}`}
                  onClick={() => b.pickable && setPicked(pick && pick.value === b.value ? null : { col: c.name, value: b.value })}
                  title={`${b.label}: ${b.count.toLocaleString()}`}>
                  <div className="fill" style={{ width: `${(b.count / max) * 100}%` }} />
                  <span className="lbl ellipsis">{b.label}</span>
                  <span className="cnt">{b.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
