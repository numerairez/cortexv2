import { useState } from 'react'
import { SparkIcon } from '../Icons'
import {
  canDrive, canHighlight, defaultSelectBy, gestureText, newId, selectableFields,
  type ColType, type DashLink, type Effect, type Widget,
} from '../../dashboard'
import { AiLinksComposer, type LinkProposal } from './AiLinks'
import { selectInfo } from './vegaSpec'
import { TYPE_LABEL, WidgetIcon } from './Widgets'

const name = (w: Widget | undefined) => (w ? w.title || TYPE_LABEL[w.type] : '?')

function Who({ w }: { w: Widget | undefined }) {
  return <span className="who">{w && <WidgetIcon w={w} size={13} />}{name(w)}</span>
}

const EFFECT_HELP: Record<Effect, string> = {
  filter: 'shows only the matching data',
  highlight: 'keeps all data and emphasises the matching part',
}

/** How the viewer's pick shows up in a sentence: "filters" / "highlights". */
const verb = (e: Effect) => (e === 'filter' ? 'filters' : 'highlights')

export function InteractionsPanel({ dataset, widgets, links, types, selectedId, selectedLink, onLinks, onWidget, onSelect, onSelectLink, onTry, onPreview, onApplyProposal }: {
  dataset: string
  widgets: Widget[]; links: DashLink[]; types: Record<string, ColType>
  /** Draw a chatbot proposal on the canvas while it's reviewed; apply it. */
  onPreview: (p: LinkProposal | null) => void; onApplyProposal: (p: LinkProposal) => void
  selectedId: string | null; selectedLink: string | null
  onLinks: (links: DashLink[]) => void; onWidget: (w: Widget) => void
  onSelect: (id: string | null) => void; onSelectLink: (id: string | null) => void
  onTry: () => void
}) {
  const byId = Object.fromEntries(widgets.map((w) => [w.id, w]))
  /** The describe-the-interactions composer: for the whole dashboard, or one object's clicks. */
  const [composer, setComposer] = useState<{ focus?: string } | null>(null)
  const link = links.find((l) => l.id === selectedLink)
  const sel = selectedId ? byId[selectedId] : undefined

  const setLink = (source: string, target: string, effect: Effect | null) => {
    const existing = links.find((l) => l.source === source && l.target === target)
    const rest = links.filter((l) => l !== existing)
    onLinks(effect ? [...rest, { id: existing?.id ?? newId('l'), source, target, effect }] : rest)
  }
  const driveAll = (source: Widget) => {
    const rest = links.filter((l) => l.source !== source.id)
    onLinks([...rest, ...widgets.filter((w) => w.id !== source.id).map((w) => ({ id: newId('l'), source: source.id, target: w.id, effect: 'filter' as const }))])
  }

  return (
    <div className="wire-panel">
      {composer ? (
        <AiLinksComposer dataset={dataset} spec={{ widgets, links }} focus={composer.focus ? byId[composer.focus] : undefined}
          onPreview={onPreview} onApply={(p) => { onApplyProposal(p); setComposer(null) }} onClose={() => setComposer(null)} />
      ) : link ? <LinkEditor key={link.id} link={link} byId={byId} types={types} setLink={setLink} onWidget={onWidget} onLinks={onLinks} links={links} onSelect={onSelect} onSelectLink={onSelectLink} />
        : sel ? (
          <div className="stack">
            <div className="inspector-head">
              <span className={`type-chip t-${sel.type}`}><WidgetIcon w={sel} size={16} />{name(sel)}</span>
              <span className="spacer" />
              <button className="ghost sm" onClick={() => onSelect(null)}>Done</button>
            </div>
            {canDrive(sel) ? (
              <>
                <p className="wire-lead">When someone <b>{gestureText(sel, types)}</b> this {TYPE_LABEL[sel.type].toLowerCase()}…</p>
                <SelectBy w={sel} types={types} onWidget={onWidget} />
                <div className="target-list">
                  {widgets.filter((w) => w.id !== sel.id).map((w) => {
                    const cur = links.find((l) => l.source === sel.id && l.target === w.id)?.effect ?? null
                    const hl = canHighlight(w)
                    return (
                      <div key={w.id} className={`target-row${cur ? ' on' : ''}`}>
                        <Who w={w} />
                        <div className="seg-control tiny" role="radiogroup" aria-label={`Effect on ${name(w)}`}>
                          <button className={!cur ? 'on' : ''} onClick={() => setLink(sel.id, w.id, null)}>Off</button>
                          <button className={cur === 'filter' ? 'on' : ''} onClick={() => setLink(sel.id, w.id, 'filter')} title={`${name(w)} ${EFFECT_HELP.filter}`}>Filter</button>
                          <button className={cur === 'highlight' ? 'on' : ''} disabled={!hl} onClick={() => setLink(sel.id, w.id, 'highlight')}
                            title={hl ? `${name(w)} ${EFFECT_HELP.highlight}` : 'Donut, heatmap and custom charts can only be filtered'}>Highlight</button>
                        </div>
                      </div>
                    )
                  })}
                  {widgets.length < 2 && <p className="muted small">Add another object to connect it to.</p>}
                </div>
                <div className="row">
                  <button className="sm" onClick={() => driveAll(sel)} disabled={widgets.length < 2}>Filter everything</button>
                  <button className="sm ghost" onClick={() => onLinks(links.filter((l) => l.source !== sel.id))} disabled={!links.some((l) => l.source === sel.id)}>Turn all off</button>
                </div>
                <button className="ai-describe" onClick={() => setComposer({ focus: sel.id })} disabled={widgets.length < 2}>
                  <SparkIcon /> Describe what clicking this does<span className="faint small">via your AI chatbot</span>
                </button>
              </>
            ) : (
              <p className="muted small">Headlines don’t drive other objects, but they follow any chart or table connected to them, showing the filtered or highlighted figure.</p>
            )}
            <Incoming w={sel} links={links} byId={byId} onSelectLink={onSelectLink} onLinks={onLinks} />
          </div>
        ) : (
          <>
            {widgets.length > 1 && (
              <button className="ai-describe" style={{ marginBottom: 12 }} onClick={() => setComposer({})}>
                <SparkIcon /> Describe the interactions<span className="faint small">via your AI chatbot</span>
              </button>
            )}
            <Overview widgets={widgets} links={links} byId={byId} types={types} driveAll={driveAll} onSelect={onSelect} onSelectLink={onSelectLink} onLinks={onLinks} />
          </>
        )}
      <div className="wire-foot">
        <button className="primary" onClick={onTry} disabled={!links.length}>Try it out ▸</button>
      </div>
    </div>
  )
}

function SelectBy({ w, types, onWidget }: { w: Widget; types: Record<string, ColType>; onWidget: (w: Widget) => void }) {
  if (w.type === 'headline') return null
  if (w.type === 'table' && w.mode === 'pivot') {
    return <p className="faint small">A cell picks its row and column together; a row or column heading picks just that. Ctrl/Shift-click to pick several.</p>
  }
  const info = w.type === 'chart' ? selectInfo(w, types, defaultSelectBy(w, types)) : null
  if (w.type === 'chart' && (w.vegaLite || info?.kind === 'interval' || w.chart === 'heatmap')) {
    return info ? <p className="faint small">Picks by {info.fields.join(' and ') || 'the chart’s own selection'}.</p>
      : <div className="alert warn small">{w.type === 'chart' && w.vegaLite ? 'This custom chart has no parameter named “sel”, so clicking it does nothing yet.' : 'Choose the chart’s fields first.'}</div>
  }
  const options = selectableFields(w, types)
  if (!options.length) return <div className="alert warn small">{w.type === 'table' ? 'Show at least one text column to pick rows by.' : 'Pick a text column for this chart’s categories first.'}</div>
  const value = defaultSelectBy(w, types)
  return (
    <label className="select-by">
      <span>Picks by</span>
      <select value={value} onChange={(e) => onWidget({ ...w, selectBy: e.target.value })}>
        {options.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
      {options.length === 1 && <span className="faint small">the value in the clicked {w.type === 'table' ? 'row' : 'mark'}</span>}
    </label>
  )
}

function Incoming({ w, links, byId, onSelectLink, onLinks }: {
  w: Widget; links: DashLink[]; byId: Record<string, Widget>; onSelectLink: (id: string) => void; onLinks: (l: DashLink[]) => void
}) {
  const inc = links.filter((l) => l.target === w.id)
  if (!inc.length) return null
  return (
    <div>
      <span className="label-sm">Listens to</span>
      {inc.map((l) => (
        <div key={l.id} className="sentence" onClick={() => onSelectLink(l.id)}>
          <span className={`effect-dot ${l.effect}`} /> <Who w={byId[l.source]} /> {verb(l.effect)} this
          <span className="spacer" />
          <button className="ghost icon sm" aria-label="Remove" onClick={(e) => { e.stopPropagation(); onLinks(links.filter((x) => x !== l)) }}>✕</button>
        </div>
      ))}
    </div>
  )
}

function LinkEditor({ link, links, byId, types, setLink, onWidget, onLinks, onSelect, onSelectLink }: {
  link: DashLink; links: DashLink[]; byId: Record<string, Widget>; types: Record<string, ColType>
  setLink: (s: string, t: string, e: Effect | null) => void; onWidget: (w: Widget) => void; onLinks: (l: DashLink[]) => void
  onSelect: (id: string | null) => void; onSelectLink: (id: string | null) => void
}) {
  const src = byId[link.source], tgt = byId[link.target]
  const reversible = canDrive(tgt) && !links.some((l) => l.source === link.target && l.target === link.source)
  return (
    <div className="stack">
      <div className="inspector-head">
        <span className="type-chip t-link">Interaction</span>
        <span className="spacer" />
        <button className="ghost sm" onClick={() => onSelectLink(null)}>Done</button>
      </div>
      <p className="wire-lead">When someone <b>{gestureText(src, types)}</b> <Who w={src} />, it <b>{verb(link.effect)}</b> <Who w={tgt} />.</p>
      <div>
        <span className="label-sm">Effect</span>
        <div className="effect-cards">
          {(['filter', 'highlight'] as Effect[]).map((e) => {
            const disabled = e === 'highlight' && !canHighlight(tgt)
            return (
              <button key={e} className={`effect-card ${e}${link.effect === e ? ' on' : ''}`} disabled={disabled} onClick={() => setLink(src.id, tgt.id, e)}>
                <EffectPicture effect={e} />
                <b>{e === 'filter' ? 'Filter' : 'Highlight'}</b>
                <span>{disabled ? 'Not available for this chart type' : EFFECT_HELP[e]}</span>
              </button>
            )
          })}
        </div>
      </div>
      <SelectBy w={src} types={types} onWidget={onWidget} />
      <div className="row">
        <button className="sm" onClick={() => { onSelectLink(null); onSelect(src.id) }}>All of {name(src)}’s connections</button>
        {reversible && <button className="sm ghost" onClick={() => onLinks(links.map((l) => (l.id === link.id ? { ...l, source: l.target, target: l.source, effect: canHighlight(src) ? l.effect : 'filter' } : l)))}>⇄ Reverse</button>}
        <span className="spacer" />
        <button className="sm ghost danger" onClick={() => { onLinks(links.filter((l) => l.id !== link.id)); onSelectLink(null) }}>Remove</button>
      </div>
    </div>
  )
}

function EffectPicture({ effect }: { effect: Effect }) {
  const bars = [30, 46, 22, 38]
  return (
    <svg viewBox="0 0 64 50" width="64" height="50" aria-hidden className="effect-pic">
      {bars.map((h, i) => effect === 'filter'
        ? i === 1 ? <rect key={i} x={20} y={50 - h} width="12" height={h} rx="2" className="bar on" /> : null
        : <g key={i}><rect x={4 + i * 15} y={50 - h} width="11" height={h} rx="2" className="bar dim" /><rect x={4 + i * 15} y={50 - h * 0.45} width="11" height={h * 0.45} rx="2" className="bar on" /></g>)}
    </svg>
  )
}

function Overview({ widgets, links, byId, types, driveAll, onSelect, onSelectLink, onLinks }: {
  widgets: Widget[]; links: DashLink[]; byId: Record<string, Widget>; types: Record<string, ColType>
  driveAll: (w: Widget) => void; onSelect: (id: string) => void; onSelectLink: (id: string) => void; onLinks: (l: DashLink[]) => void
}) {
  const drivers = widgets.filter(canDrive)
  if (!links.length) {
    return (
      <div className="stack">
        <div className="wire-empty">
          <svg viewBox="0 0 120 64" width="120" height="64" aria-hidden>
            <rect x="4" y="12" width="40" height="40" rx="6" className="box" />
            <rect x="76" y="4" width="40" height="24" rx="6" className="box" />
            <rect x="76" y="36" width="40" height="24" rx="6" className="box" />
            <path d="M46 30 C60 30 60 16 72 16M46 34 C60 34 60 48 72 48" className="wire" />
          </svg>
          <h3>This dashboard is static</h3>
          <p>Every object shows all the data, and clicking does nothing. That’s often all you need.</p>
          <p>To let viewers explore, connect objects: <b>select one</b> and choose what it filters, or drag its <span className="port-inline">→</span> handle onto another object.</p>
        </div>
        {drivers.length > 0 && widgets.length > 1 && (
          <div>
            <span className="label-sm">Quick start</span>
            {drivers.slice(0, 4).map((w) => (
              <button key={w.id} className="quick" onClick={() => driveAll(w)}>
                <WidgetIcon w={w} size={16} /><span>Clicking <b>{name(w)}</b> filters everything else</span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>Select an object or an arrow to change it. Viewers see these in <b>View</b> mode.</p>
      {drivers.filter((w) => links.some((l) => l.source === w.id)).map((w) => (
        <div key={w.id} className="driver-group">
          <div className="driver-head" onClick={() => onSelect(w.id)}>When someone <b>{gestureText(w, types)}</b> <Who w={w} /></div>
          {links.filter((l) => l.source === w.id).map((l) => (
            <div key={l.id} className="sentence" onClick={() => onSelectLink(l.id)}>
              <span className={`effect-dot ${l.effect}`} />{verb(l.effect)} <Who w={byId[l.target]} />
            </div>
          ))}
        </div>
      ))}
      <button className="sm ghost danger" onClick={() => { if (confirm('Remove every interaction? The dashboard becomes static again.')) onLinks([]) }}>Remove all interactions</button>
    </div>
  )
}
