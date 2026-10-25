import { useMemo, useState } from 'react'
import { SparkIcon } from '../Icons'
import { api } from '../../api'
import { isCategory, isNumeric, type Widget } from '../../dashboard'
import type { ColumnSchema } from '../../types'
import { CopyButton, Spinner } from '../ui'
import { Skeleton } from './Widgets'

/** What a change request might look like for each kind of object. */
const CHANGE_EXAMPLE: Record<Widget['type'], string> = {
  headline: 'e.g. Show the average instead, only for Luzon',
  chart: 'e.g. Make it horizontal and only show the top 5',
  table: 'e.g. Make it a pivot with regions down and months across',
}

interface ReplyResult { widget: Widget | null; errors: string[]; warnings: string[]; corrective_prompt: string | null }

/** Example requests made from the dataset's own columns, so the first try is one click away. */
function examples(columns: ColumnSchema[]): string[] {
  const num = columns.find((c) => isNumeric(c.type) && !/(^|\b|_)(id|no|number|code|key)$/i.test(c.name))?.name
  const cats = columns.filter((c) => isCategory(c.type)).map((c) => c.name)
  const date = columns.find((c) => c.type === 'date')?.name
  const out: string[] = []
  if (num && date) out.push(`${num} per month as a line${cats[0] ? `, one line per ${cats[0]}` : ''}`)
  if (num && cats[0]) out.push(`Top 5 ${cats[0]} by total ${num}, largest first`)
  if (num && cats[0] && (cats[1] || date)) out.push(`Pivot of total ${num}: ${cats[0]} down, ${cats[1] ?? 'month'} across`)
  return out.slice(0, 3)
}

/** Describe an object in words → copy a prompt for the approved chatbot → paste its reply back. Shown inside the object's wireframe. */
export function AiComposer({ dataset, widget, columns, blank, onApply, onCancel }: {
  dataset: string; widget: Widget; columns: ColumnSchema[]
  /** A brand-new object with nothing set up yet (as opposed to changing an existing one). */
  blank: boolean
  onApply: (w: Widget, notes: string[]) => void
  onCancel: () => void
}) {
  const [request, setRequest] = useState('')
  const [samples, setSamples] = useState(false)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [result, setResult] = useState<ReplyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ideas = useMemo(() => examples(columns), [columns])

  const buildPrompt = async () => {
    setBusy(true); setError(null)
    try {
      const r = await api.post<{ prompt: string }>('/api/dashboards/ai/prompt', { dataset, request, widget: blank ? null : widget, include_samples: samples })
      setPrompt(r.prompt)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  // A hand-written Vega-Lite spec must also compile here, where it will be drawn.
  const compileProblem = async (w: Widget) => {
    if (w.type !== 'chart' || !w.vegaLite) return null
    try {
      const vl = await import('vega-lite')
      vl.compile({ ...w.vegaLite, data: { name: 'table' } } as never)
      return null
    } catch (e) { return `The Vega-Lite spec does not compile: ${(e as Error).message}` }
  }

  const check = async () => {
    setBusy(true); setError(null)
    try {
      let r = await api.post<ReplyResult>('/api/dashboards/ai/reply', { dataset, text: reply, widget })
      const problem = r.widget ? await compileProblem(r.widget) : null
      if (problem) {
        const fix = await api.post<{ prompt: string }>('/api/dashboards/ai/correction', { problems: [problem] })
        r = { widget: null, errors: [problem], warnings: [], corrective_prompt: fix.prompt }
      }
      if (r.widget && !r.warnings.length) onApply(r.widget, [])
      else setResult(r)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="ai-composer" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ai-backdrop" aria-hidden><Skeleton w={widget} /></div>
      <div className="ai-content">
        {!prompt ? (
          <>
            <div className="ai-head"><span className="ai-spark"><SparkIcon size={15} /></span><b>{blank ? 'Describe this chart' : 'Describe the change'}</b>
              <span className="spacer" /><button className="ghost sm" onClick={onCancel}>{blank ? 'Back' : 'Cancel'}</button></div>
            <textarea className="ai-request" autoFocus value={request} onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && request.trim()) buildPrompt() }}
              placeholder={blank ? 'e.g. Total quantity per region as columns, split by product, biggest first' : CHANGE_EXAMPLE[widget.type]} />
            {blank && ideas.length > 0 && !request && (
              <div className="ai-ideas">{ideas.map((t) => <button key={t} className="ai-idea" onClick={() => setRequest(t)}>{t}</button>)}</div>
            )}
            <label className="check small ai-samples" title="Only if your policy allows this data in the chatbot">
              <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} /> Include a few example values
            </label>
            {error && <div className="alert bad small">{error}</div>}
            <div className="row">
              <button className="primary sm" onClick={buildPrompt} disabled={!request.trim() || busy}>{busy ? <Spinner /> : 'Build prompt →'}</button>

            </div>
          </>
        ) : (
          <>
            <div className="ai-head"><span className="ai-spark"><SparkIcon size={15} /></span><b className="ellipsis" title={request}>“{request}”</b>
              <span className="spacer" /><button className="ghost sm" onClick={() => { setPrompt(null); setResult(null) }}>Edit</button>
              <button className="ghost sm" onClick={onCancel}>{blank ? 'Back' : 'Cancel'}</button></div>
            <div className="ai-step"><span className="n">1</span><span>Copy the prompt into your approved AI chatbot</span>
              <CopyButton text={prompt} label="Copy prompt" primary={!reply} /></div>
            <details className="ai-preview"><summary>See what will be shared</summary><pre className="prompt">{prompt}</pre></details>
            <div className="ai-step"><span className="n">2</span><span>Paste its reply here</span></div>
            <textarea className="ai-reply code" value={reply} onChange={(e) => { setReply(e.target.value); setResult(null) }} placeholder='{"type": "chart", …}' />
            {result && (result.errors.length > 0 || result.warnings.length > 0) && (
              <div className={`alert ${result.errors.length ? 'bad' : 'warn'} small ai-result`}>
                <b>{result.errors.length ? 'The reply can’t be used yet' : 'Usable, with notes'}</b>
                <ul>{[...result.errors, ...result.warnings].slice(0, 6).map((p, i) => <li key={i}>{p}</li>)}</ul>
                <div className="row">
                  {result.corrective_prompt && <CopyButton text={result.corrective_prompt} label="Copy fix-up prompt" />}
                  {result.widget && <button className="sm" onClick={() => onApply(result.widget!, result.warnings)}>Apply anyway</button>}
                </div>
              </div>
            )}
            {error && <div className="alert bad small">{error}</div>}
            <div className="row"><button className="primary sm" onClick={check} disabled={!reply.trim() || busy}>{busy ? <Spinner /> : 'Apply reply'}</button></div>
          </>
        )}
      </div>
    </div>
  )
}

/** What a new, blank chart's wireframe offers: set it up by hand, or describe it to the chatbot. */
export function BlankChartChoice({ w, onManual, onDescribe }: { w: Widget; onManual: () => void; onDescribe: () => void }) {
  return (
    <div className="ai-composer blank-choice" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ai-backdrop" aria-hidden><Skeleton w={w} /></div>
      <div className="ai-content choice">
        <b className="choice-title">How do you want to make this chart?</b>
        <button className="choice-btn" onClick={onManual}>
          <span className="choice-icon" aria-hidden>▦</span>
          <span><b>Set it up yourself</b><span className="faint small">Pick the chart type and fields on the right</span></span>
        </button>
        <button className="choice-btn ai" onClick={onDescribe}>
          <span className="choice-icon"><SparkIcon size={17} /></span>
          <span><b>Describe it with AI</b><span className="faint small">Say what you want; your approved chatbot designs it</span></span>
        </button>
      </div>
    </div>
  )
}
