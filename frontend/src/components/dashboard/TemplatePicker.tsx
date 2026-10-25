import { GRID_COLS } from '../../dashboard'
import { TEMPLATES, needsDate, previewWidget, type DashTemplate } from '../../dashboardTemplates'
import type { ColumnSchema } from '../../types'
import { Skeleton } from './Widgets'

/** A miniature of a template: each slot as a little wireframe in its grid position. */
export function TemplateThumb({ t }: { t: DashTemplate }) {
  const rows = Math.max(12, ...t.slots.map((s) => s.box.y + s.box.h))
  if (!t.slots.length) return <div className="tpl-thumb blank"><span>＋</span></div>
  return (
    <div className="tpl-thumb">
      {t.slots.map((s, i) => (
        <div key={i} className={`tpl-slot t-${previewWidget(s, i).type}`} style={{
          left: `${(s.box.x / GRID_COLS) * 100}%`, width: `${(s.box.w / GRID_COLS) * 100}%`,
          top: `${(s.box.y / rows) * 100}%`, height: `${(s.box.h / rows) * 100}%`,
        }}><Skeleton w={previewWidget(s, i)} /></div>
      ))}
    </div>
  )
}

/** The template gallery: pick a starting layout. */
export function TemplatePicker({ value, onChange, columns, compact }: {
  value: string; onChange: (id: string) => void
  /** The chosen dataset's columns, for hints like "works best with a date column". */
  columns?: ColumnSchema[]
  compact?: boolean
}) {
  const hasDate = !columns || columns.some((c) => c.type === 'date')
  return (
    <div className={`tpl-grid${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Layout templates">
      {TEMPLATES.map((t) => (
        <button key={t.id} role="radio" aria-checked={value === t.id} className={`tpl-card${value === t.id ? ' on' : ''}`} onClick={() => onChange(t.id)}
          title={t.description}>
          <TemplateThumb t={t} />
          <span className="tpl-name">{t.name}{t.interactive && <span className="badge info">Interactive</span>}</span>
          <span className="tpl-desc faint small">{t.description}</span>
          {!hasDate && needsDate(t) && <span className="tpl-hint small">No dates in this data — trends become breakdowns</span>}
        </button>
      ))}
    </div>
  )
}
