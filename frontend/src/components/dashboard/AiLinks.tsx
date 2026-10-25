import { useState } from 'react'
import { SparkIcon } from '../Icons'
import { api } from '../../api'
import type { DashboardSpec, DashLink, Widget } from '../../dashboard'
import { CopyButton, Spinner } from '../ui'
import { TYPE_LABEL, WidgetIcon } from './Widgets'

/** Links the chatbot proposed, validated, and the full set they would leave the dashboard with. */
export interface LinkProposal { links: DashLink[]; selectBy: Record<string, string>; notes: string[] }
interface LinksReply extends Omit<LinkProposal, 'links'> { links: DashLink[] | null; errors: string[]; warnings: string[]; corrective_prompt: string | null }

export type LinkChange = 'added' | 'removed' | 'changed' | 'same'
const pair = (l: DashLink) => `${l.source}\u0001${l.target}`

/** Each link in the proposal or the current set, marked with how applying would change it. */
export function diffLinks(current: DashLink[], proposed: DashLink[]): (DashLink & { change: LinkChange })[] {
  const before = new Map(current.map((l) => [pair(l), l]))
  const after = new Set(proposed.map(pair))
  return [
    ...proposed.map((l) => {
      const was = before.get(pair(l))
      return { ...l, change: (!was ? 'added' : was.effect !== l.effect ? 'changed' : 'same') as LinkChange }
    }),
    ...current.filter((l) => !after.has(pair(l))).map((l) => ({ ...l, change: 'removed' as LinkChange })),
  ]
}

const name = (w?: Widget) => (w ? w.title || TYPE_LABEL[w.type] : '?')
function Who({ w }: { w?: Widget }) {
  return <span className="who">{w && <WidgetIcon w={w} size={13} />}{name(w)}</span>
}
const CHANGE_LABEL: Record<LinkChange, string> = { added: 'New', removed: 'Removed', changed: 'Changed', same: 'Kept' }

/** Describe interactions in words → copy a prompt for the approved chatbot → paste its reply → preview → apply. */
export function AiLinksComposer({ dataset, spec, focus, onPreview, onApply, onClose }: {
  dataset: string; spec: DashboardSpec
  /** Only decide what clicking this object does. */
  focus?: Widget
  /** The proposal to draw on the canvas while it's being reviewed (null to stop). */
  onPreview: (p: LinkProposal | null) => void
  onApply: (p: LinkProposal) => void
  onClose: () => void
}) {
  const [request, setRequest] = useState('')
  const [prompt, setPrompt] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [result, setResult] = useState<LinksReply | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const byId = Object.fromEntries(spec.widgets.map((w) => [w.id, w]))
  const proposal = result?.links ? { links: result.links, selectBy: result.selectBy, notes: result.notes } : null

  const ideas = focus
    ? [`Clicking this filters everything else`, `Clicking this highlights the matching part in every chart`]
    : ['Clicking any chart or table filters everything else', 'The table only highlights; the charts filter each other']

  const buildPrompt = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.post<{ prompt: string }>('/api/dashboards/ai/links/prompt', { dataset, spec, request, focus: focus?.id ?? null })
      setPrompt(r.prompt)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const check = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.post<LinksReply>('/api/dashboards/ai/links/reply', { dataset, spec, text: reply, focus: focus?.id ?? null })
      setResult(r)
      onPreview(r.links ? { links: r.links, selectBy: r.selectBy, notes: r.notes } : null)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const close = () => { onPreview(null); onClose() }

  const changes = proposal ? diffLinks(spec.links, proposal.links).filter((l) => l.change !== 'same') : []
  // One line per source, effect and kind of change: "Sales by region filters Rows, Total Qty, …".
  const groups: { key: string; source: string; effect: string; change: LinkChange; targets: string[] }[] = []
  for (const l of changes) {
    const key = `${l.change}|${l.source}|${l.effect}`
    const g = groups.find((x) => x.key === key)
    if (g) g.targets.push(l.target)
    else groups.push({ key, source: l.source, effect: l.effect, change: l.change, targets: [l.target] })
  }
  const pickChanges = proposal ? Object.entries(proposal.selectBy).filter(([id, f]) => {
    const w = byId[id]
    return w && (w.type === 'chart' || w.type === 'table') && w.selectBy !== f
  }) : []

  return (
    <div className="ai-links">
      <div className="ai-head"><span className="ai-spark"><SparkIcon size={15} /></span>
        <b>{focus ? <>What clicking <Who w={focus} /> does</> : 'Describe the interactions'}</b>
        <span className="spacer" /><button className="ghost sm" onClick={close}>Close</button></div>
      {!prompt ? (
        <>
          <textarea className="ai-request" autoFocus value={request} onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && request.trim()) buildPrompt() }}
            placeholder={focus ? 'e.g. Filters the headlines and the table, and highlights the trend' : 'e.g. Clicking a region in any chart filters everything; the details table only highlights the trend'} />
          {!request && <div className="ai-ideas">{ideas.map((t) => <button key={t} className="ai-idea" onClick={() => setRequest(t)}>{t}</button>)}</div>}
          <p className="faint small" style={{ margin: 0 }}>Only object names, their fields and the current links are shared — no data values.</p>
          {error && <div className="alert bad small">{error}</div>}
          <button className="primary sm" onClick={buildPrompt} disabled={!request.trim() || busy}>{busy ? <Spinner /> : 'Build prompt →'}</button>
        </>
      ) : (
        <>
          <div className="ai-head small"><span className="ellipsis faint" title={request}>“{request}”</span><span className="spacer" />
            <button className="ghost sm" onClick={() => { setPrompt(null); setResult(null); onPreview(null) }}>Edit</button></div>
          <div className="ai-step"><span className="n">1</span><span>Copy the prompt into your approved AI chatbot</span><CopyButton text={prompt} label="Copy prompt" primary={!reply} /></div>
          <details className="ai-preview"><summary>See what will be shared</summary><pre className="prompt">{prompt}</pre></details>
          <div className="ai-step"><span className="n">2</span><span>Paste its reply here</span></div>
          <textarea className="ai-reply code" value={reply} onChange={(e) => { setReply(e.target.value); setResult(null); onPreview(null) }} placeholder='{"mode": "replace", "links": […]}' />
          {!proposal && <button className="primary sm" onClick={check} disabled={!reply.trim() || busy}>{busy ? <Spinner /> : 'Preview the changes'}</button>}
          {error && <div className="alert bad small">{error}</div>}
          {result && result.errors.length > 0 && (
            <div className="alert bad small ai-result">
              <b>The reply can’t be used yet</b>
              <ul>{[...result.errors, ...result.warnings].slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul>
              {result.corrective_prompt && <CopyButton text={result.corrective_prompt} label="Copy fix-up prompt" />}
            </div>
          )}
          {proposal && (
            <div className="link-review">
              <div className="row review-head">
                <span className="label-sm" style={{ margin: 0 }}>{changes.length || pickChanges.length ? 'If you apply this' : 'Nothing would change'}</span>
                <span className="spacer" />
                <button className="primary sm" onClick={() => { onApply(proposal); onPreview(null) }} disabled={!changes.length && !pickChanges.length}>Apply</button>
                <button className="sm" onClick={() => { setResult(null); onPreview(null) }}>Discard</button>
              </div>
              {groups.map((g) => (
                <div key={g.key} className={`sentence change-${g.change}`}>
                  <span className={`change-tag ${g.change}`}>{CHANGE_LABEL[g.change]}</span>
                  <Who w={byId[g.source]} /> {g.change === 'removed' ? 'no longer ' : ''}{g.effect === 'filter' ? 'filters' : 'highlights'}
                  {g.targets.map((t) => <span key={t} className="target"><Who w={byId[t]} /></span>)}
                </div>
              ))}
              {pickChanges.map(([id, f]) => (
                <div key={id} className="sentence"><span className="change-tag changed">Picks</span><Who w={byId[id]} /> picks by <b>{f}</b></div>
              ))}
              {result!.warnings.length > 0 && <div className="alert warn small"><ul>{result!.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
              {proposal.notes.length > 0 && (
                <div className="alert info small">
                  <b>Not supported yet</b> — the chatbot couldn’t do these with filter and highlight:
                  <ul>{proposal.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                </div>
              )}
              {result!.corrective_prompt && <div><CopyButton text={result!.corrective_prompt} label="Copy fix-up prompt" /></div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
