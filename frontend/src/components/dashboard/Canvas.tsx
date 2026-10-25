import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SIZE, GRID_COLS, settle, type Box, type DashLink, type Widget, type WidgetType } from '../../dashboard'
import { SparkIcon } from '../Icons'
import { diffLinks } from './AiLinks'
import { Skeleton, TYPE_LABEL, WidgetIcon } from './Widgets'

export type Mode = 'view' | 'edit' | 'wire'

/** Drag payloads: a new object from the palette, or a column from the field list. */
export const WIDGET_MIME = 'application/x-flowbook-dash-widget'
export const FIELD_MIME = 'application/x-flowbook-dash-field'

const ROW = 36      // grid row height (px)
const GAP = 14      // gutter between cells (px)
const NARROW = 640  // below this width the viewer stacks objects in one column

interface Px { left: number; top: number; width: number; height: number }
type Drag = { id: string; kind: 'move' | 'resize'; x0: number; y0: number; start: Box; preview: Widget[]; live: Px }
type Connect = { source: string; x: number; y: number; over: string | null }
type DropHint = { box?: Box; target?: string; label: string }

export function DashCanvas({ widgets, links, mode, selectedId, selectedLink, canDrive, onSelect, onSelectLink, onLayout, onAdd, onFieldDrop, onConnect, renderBody, renderBadges, renderCaption, preview, onDuplicate, onRemove, onDescribe, popover, emptyState }: {
  widgets: Widget[]; links: DashLink[]; mode: Mode
  selectedId: string | null; selectedLink: string | null
  canDrive: (w: Widget) => boolean
  onSelect: (id: string | null) => void; onSelectLink: (id: string | null) => void
  onLayout: (widgets: Widget[]) => void
  onAdd: (type: WidgetType, box: Box) => void
  onFieldDrop: (field: string, target: string | null, box: Box) => void
  onConnect: (source: string, target: string) => void
  renderBody: (w: Widget) => ReactNode
  renderBadges?: (w: Widget) => ReactNode
  /** Edit mode: the duplicate and delete buttons on each object's title bar. */
  onDuplicate?: (id: string) => void; onRemove?: (id: string) => void
  /** Edit mode: open the describe-a-change composer in this object; omitted where it doesn't apply. */
  onDescribe?: (w: Widget) => (() => void) | undefined
  /** A panel floating just below one object (the describe box, for objects too small to hold it). */
  popover?: { id: string; content: ReactNode } | null
  /** A line under the object's body (its data source and filters); not shown on wireframes. */
  renderCaption?: (w: Widget) => ReactNode
  /** Proposed links under review: drawn as a diff against the current ones, not clickable. */
  preview?: { links: DashLink[] } | null
  emptyState: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [connect, setConnect] = useState<Connect | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  // Pointer-up handlers read the latest drag state from here (state updaters must stay side-effect free).
  const dragRef = useRef(drag)
  dragRef.current = drag
  const connectRef = useRef(connect)
  connectRef.current = connect

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const colW = Math.max(10, (width - GAP * (GRID_COLS - 1)) / GRID_COLS)
  const stacked = mode === 'view' && width > 0 && width < NARROW
  const toPx = (b: Box): Px => ({ left: b.x * (colW + GAP), top: b.y * (ROW + GAP), width: b.w * colW + (b.w - 1) * GAP, height: b.h * ROW + (b.h - 1) * GAP })
  const shown = drag?.preview ?? widgets
  const boxes = new Map<string, Box>()
  if (stacked) {
    let y = 0
    for (const w of [...shown].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) { boxes.set(w.id, { x: 0, y, w: GRID_COLS, h: w.box.h }); y += w.box.h }
  } else shown.forEach((w) => boxes.set(w.id, w.box))
  const bottom = Math.max(0, ...[...boxes.values()].map((b) => b.y + b.h), dropHint?.box ? dropHint.box.y + dropHint.box.h : 0)
  const height = Math.max(bottom * (ROW + GAP) + (mode === 'edit' ? 4 * (ROW + GAP) : 0), mode === 'view' ? 0 : 420)

  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const cellAt = (x: number, y: number, w: number, h: number): Box => ({
    x: Math.max(0, Math.min(GRID_COLS - w, Math.round(x / (colW + GAP) - w / 2))),
    y: Math.max(0, Math.round(y / (ROW + GAP) - 0.5)), w, h,
  })
  const widgetAt = (x: number, y: number) => shown.find((w) => {
    const p = toPx(boxes.get(w.id)!)
    return x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height
  })

  // ---- move / resize (edit mode)
  const startDrag = (e: React.PointerEvent, w: Widget, kind: Drag['kind']) => {
    if (mode !== 'edit' || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onSelect(w.id)
    setDrag({ id: w.id, kind, x0: e.clientX, y0: e.clientY, start: w.box, preview: widgets, live: toPx(w.box) })
  }
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0
      const s = drag.start, sp = toPx(s)
      let box: Box, live: Px
      if (drag.kind === 'move') {
        box = { ...s, x: Math.max(0, Math.min(GRID_COLS - s.w, Math.round(s.x + dx / (colW + GAP)))), y: Math.max(0, Math.round(s.y + dy / (ROW + GAP))) }
        live = { ...sp, left: sp.left + dx, top: sp.top + dy }
      } else {
        box = { ...s, w: Math.max(2, Math.min(GRID_COLS - s.x, Math.round(s.w + dx / (colW + GAP)))), h: Math.max(2, Math.round(s.h + dy / (ROW + GAP))) }
        live = { ...sp, width: Math.max(colW, sp.width + dx), height: Math.max(ROW, sp.height + dy) }
      }
      setDrag((d) => d && { ...d, live, preview: settle(widgets, { id: d.id, box }) })
    }
    const up = () => {
      const d = dragRef.current
      setDrag(null)
      if (d && JSON.stringify(d.preview.map((w) => w.box)) !== JSON.stringify(widgets.map((w) => w.box))) onLayout(settle(d.preview))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id, drag?.kind])

  // ---- connect (interactions mode): drag from an object's port onto another object
  const startConnect = (e: React.PointerEvent, w: Widget) => {
    e.preventDefault()
    e.stopPropagation()
    const p = local(e)
    setConnect({ source: w.id, x: p.x, y: p.y, over: null })
  }
  useEffect(() => {
    if (!connect) return
    const move = (e: PointerEvent) => {
      const p = local(e)
      const over = widgetAt(p.x, p.y)
      setConnect((c) => c && { ...c, x: p.x, y: p.y, over: over && over.id !== c.source ? over.id : null })
    }
    const up = () => {
      const c = connectRef.current
      setConnect(null)
      if (c?.over) onConnect(c.source, c.over)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect?.source])

  // ---- drops from the palette and the field list (edit mode)
  const dragOver = (e: React.DragEvent) => {
    if (mode !== 'edit') return
    const types = e.dataTransfer.types
    // The type travels in the payload's name too, since payload values can't be read until the drop.
    const widgetType = types.find((t) => t.startsWith(`${WIDGET_MIME}+`))?.slice(WIDGET_MIME.length + 1) as WidgetType | undefined
    const isField = types.includes(FIELD_MIME)
    if (!widgetType && !isField) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const p = local(e)
    const target = isField ? widgetAt(p.x, p.y) : undefined
    if (target) { setDropHint({ target: target.id, label: `Use in “${target.title || TYPE_LABEL[target.type]}”` }); return }
    const size = DEFAULT_SIZE[widgetType ?? 'chart']
    setDropHint({ box: cellAt(p.x, p.y, size.w, size.h), label: widgetType ? `New ${TYPE_LABEL[widgetType].toLowerCase()}` : 'New object' })
  }
  const drop = (e: React.DragEvent) => {
    const hint = dropHint
    setDropHint(null)
    if (mode !== 'edit' || !hint) return
    e.preventDefault()
    const type = e.dataTransfer.getData(WIDGET_MIME) as WidgetType
    const field = e.dataTransfer.getData(FIELD_MIME)
    const p = local(e)
    if (type) onAdd(type, hint.box ?? cellAt(p.x, p.y, DEFAULT_SIZE[type].w, DEFAULT_SIZE[type].h))
    else if (field) onFieldDrop(field, hint.target ?? null, hint.box ?? cellAt(p.x, p.y, 6, 8))
  }

  // ---- link geometry (interactions mode)
  const centerOf = (id: string) => { const p = toPx(boxes.get(id)!); return { x: p.left + p.width / 2, y: p.top + p.height / 2, p } }
  const edgePoint = (id: string, toward: { x: number; y: number }) => {
    const { x, y, p } = centerOf(id)
    const dx = toward.x - x, dy = toward.y - y
    const sx = dx === 0 ? Infinity : (p.width / 2) / Math.abs(dx)
    const sy = dy === 0 ? Infinity : (p.height / 2) / Math.abs(dy)
    const s = Math.min(sx, sy)
    return { x: x + dx * s, y: y + dy * s, horizontal: sx < sy }
  }
  const linkPath = (l: DashLink) => {
    const a = centerOf(l.source), b = centerOf(l.target)
    const reverse = drawn.some((o) => o.change !== 'removed' && o.source === l.target && o.target === l.source)
    const s = edgePoint(l.source, b), t = edgePoint(l.target, a)
    // Bend sideways so a pair of opposite links reads as two arrows, not one line.
    const nx = -(t.y - s.y), ny = t.x - s.x
    const len = Math.hypot(nx, ny) || 1
    const bend = reverse ? 26 : 14
    const mx = (s.x + t.x) / 2 + (nx / len) * bend, my = (s.y + t.y) / 2 + (ny / len) * bend
    return { d: `M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`, mid: { x: (s.x + 2 * mx + t.x) / 4, y: (s.y + 2 * my + t.y) / 4 } }
  }

  const focus = preview ? null : hover ?? selectedId
  const drawn = preview ? diffLinks(links, preview.links) : links.map((l) => ({ ...l, change: 'same' as const }))
  return (
    <div ref={host} className={`dash-canvas mode-${mode}${drag ? ' dragging' : ''}${connect ? ' connecting' : ''}`} style={{ height }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) { onSelect(null); onSelectLink(null) } }}
      onDragOver={dragOver} onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHint(null) }} onDrop={drop}>
      {mode === 'edit' && width > 0 && <div className="dash-gridlines" style={{ backgroundSize: `${colW + GAP}px ${ROW + GAP}px` }} />}
      {!widgets.length && mode !== 'view' && <div className="dash-empty">{emptyState}</div>}

      {drag && <div className="dash-ghost" style={toPx(drag.preview.find((w) => w.id === drag.id)!.box)} />}
      {dropHint?.box && <div className="dash-ghost drop" style={toPx(dropHint.box)}><span>{dropHint.label}</span></div>}

      {shown.map((w) => {
        const live = drag?.id === w.id && drag.kind === 'move' ? drag.live : null
        const px = live ?? toPx(boxes.get(w.id)!)
        const drives = canDrive(w)
        const related = mode === 'wire' && focus && (focus === w.id || links.some((l) => (l.source === focus && l.target === w.id) || (l.target === focus && l.source === w.id)))
        const cls = [
          'dash-frame', `t-${w.type}`, selectedId === w.id && mode !== 'view' ? 'selected' : '', live ? 'lifted' : '',
          dropHint?.target === w.id ? 'drop-target' : '', connect?.over === w.id ? 'connect-target' : '',
          connect?.source === w.id ? 'connect-source' : '', related ? 'related' : '', popover?.id === w.id ? 'describing' : '', mode === 'wire' && focus && !related ? 'faded' : '',
        ].filter(Boolean).join(' ')
        return (
          <div key={w.id} className={cls} style={px}
            onPointerDown={(e) => { if (mode !== 'view') { e.stopPropagation(); onSelect(w.id); onSelectLink(null) } }}
            onPointerEnter={() => mode === 'wire' && setHover(w.id)} onPointerLeave={() => mode === 'wire' && setHover(null)}>
            <div className="dash-frame-head" onPointerDown={(e) => startDrag(e, w, 'move')}>
              {mode === 'edit' && <span className="dash-grip" aria-hidden>⋮⋮</span>}
              {mode === 'wire' && <span className="wire-type"><WidgetIcon w={w} size={15} /></span>}
              <span className="dash-title ellipsis" title={w.title}>{w.title || <span className="faint">Untitled</span>}</span>
              <span className="spacer" />
              {renderBadges?.(w)}
              {mode === 'edit' && (
                <span className="frame-actions" onPointerDown={(e) => e.stopPropagation()}>
                  {(() => {
                    const describe = onDescribe?.(w)
                    return describe && (
                      <button className="ghost ai" onClick={describe} title="Describe a change (via your AI chatbot)" aria-label={`Describe a change to ${w.title || 'object'}`}><SparkIcon size={13} />AI</button>
                    )
                  })()}
                  {onDuplicate && (
                    <button className="ghost icon" onClick={() => onDuplicate(w.id)} title="Duplicate (Ctrl+D)" aria-label={`Duplicate ${w.title || 'object'}`}>
                      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 3.2V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.2" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                    </button>
                  )}
                  {onRemove && (
                    <button className="ghost icon danger" onClick={() => onRemove(w.id)} title="Delete (Del)" aria-label={`Delete ${w.title || 'object'}`}>✕</button>
                  )}
                </span>
              )}
            </div>
            <div className="dash-frame-body">{mode === 'wire' ? <Skeleton w={w} /> : renderBody(w)}</div>
            {mode !== 'wire' && renderCaption?.(w)}
            {mode === 'edit' && <div className="dash-resize" onPointerDown={(e) => startDrag(e, w, 'resize')} title="Drag to resize" />}
            {mode === 'wire' && drives && (
              <button className="dash-port" onPointerDown={(e) => startConnect(e, w)} title="Drag onto another object to connect" aria-label={`Connect ${w.title} to another object`}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
        )
      })}

      {popover && boxes.has(popover.id) && width > 0 && (() => {
        const px = toPx(boxes.get(popover.id)!)
        const w = Math.min(460, width)
        const left = Math.max(0, Math.min(px.left, width - w))
        const arrow = Math.max(16, Math.min(px.left + px.width / 2 - left, w - 16))
        return (
          <div className="dash-popover" style={{ left, top: px.top + px.height + 10, width: w, ['--arrow-x' as string]: `${arrow}px` }}
            onPointerDown={(e) => e.stopPropagation()}>
            {popover.content}
          </div>
        )
      })()}
      {mode === 'wire' && width > 0 && (
        <svg className="dash-links" width={width} height={height}>
          <defs>
            {(['filter', 'highlight', 'draft'] as const).map((k) => (
              <marker key={k} id={`dash-arrow-${k}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" className={`arrow ${k}`} />
              </marker>
            ))}
          </defs>
          {drawn.map((l) => {
            if (!boxes.has(l.source) || !boxes.has(l.target)) return null
            const { d, mid } = linkPath(l)
            const on = !preview && (selectedLink === l.id || (focus && (l.source === focus || l.target === focus)))
            return (
              <g key={`${l.id}-${l.change}`} className={`dash-link ${l.effect} change-${l.change}${preview ? ' previewing' : ''}${on ? ' on' : ''}${!preview && selectedLink === l.id ? ' selected' : ''}${focus && !on ? ' faded' : ''}`}
                onPointerDown={(e) => { if (preview) return; e.stopPropagation(); onSelectLink(l.id); onSelect(null) }}>
                <path d={d} className="hit" />
                <path d={d} className="line" markerEnd={`url(#dash-arrow-${l.effect})`} />
                {/* Labels only where they help: few links, or the ones around what's in focus. */}
                {(on || drawn.length <= 3 || (preview && l.change !== 'same')) && (
                  <foreignObject x={mid.x - 46} y={mid.y - 12} width="92" height="24">
                    <div className={`link-pill ${l.effect}`}>{l.change === 'removed' ? '✕ ' : l.change === 'added' ? '+ ' : ''}{l.effect === 'filter' ? '⏷ Filter' : '◐ Highlight'}</div>
                  </foreignObject>
                )}
              </g>
            )
          })}
          {connect && (() => {
            const s = edgePoint(connect.source, connect)
            const t = connect.over ? edgePoint(connect.over, centerOf(connect.source)) : connect
            return <path className="dash-link-draft" d={`M${s.x},${s.y} L${t.x},${t.y}`} markerEnd="url(#dash-arrow-draft)" />
          })()}
        </svg>
      )}
    </div>
  )
}
