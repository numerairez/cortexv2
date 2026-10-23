import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { ArtifactList } from '../components/Artifacts'
import { OP_COLOR, OpIcon } from '../components/Icons'
import { OP_LABEL, stepSummary } from '../components/StepEditor'
import { CopyButton, ErrorBox, Loading, StatusBadge, fmtDate, useLoad, useToast } from '../components/ui'
import type { Run, StepReport } from '../types'

const SERVICE_NAMES: Record<string, string> = {
  knowledge_base: 'Synthesized Knowledge Base',
  transformation: 'Data Transformation Studio',
  transformation_ai: 'AI-drafted workflow',
  macro_to_workflow: 'Excel macro → workflow',
  python_to_workflow: 'Python script → workflow',
}

export default function RunWorkspace() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { data: run, error, setData } = useLoad(() => api.get<Run>(`/api/runs/${id}`), [id])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  if (error) return <ErrorBox error={error} />
  if (!run) return <Loading />

  const isAI = run.service_id !== 'transformation'
  const submit = async () => {
    setBusy(true); setSubmitError(null)
    try {
      const r = await api.post<Run>(`/api/runs/${run.id}/response`, { text: reply })
      setData({ ...run, ...r })
      if (r.status === 'completed') { setReply(''); toast('Reply accepted') }
    } catch (e) { setSubmitError((e as Error).message) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!confirm('Delete this run and its output files?')) return
    await api.del(`/api/runs/${run.id}`)
    nav('/runs')
  }

  const latestArtifacts = run.artifacts.filter((a) => (a.metadata.attempt ?? run.state.attempt) === run.state.attempt || run.service_id === 'transformation')
  const olderArtifacts = run.artifacts.filter((a) => !latestArtifacts.includes(a))
  const stage = run.status === 'completed' ? 3 : run.status === 'invalid_response' ? 2 : 1

  return (
    <>
      <div className="crumbs"><Link to="/runs">Runs</Link> /</div>
      <div className="page-head">
        <div>
          <h1>{run.title}</h1>
          <p className="sub">{SERVICE_NAMES[run.service_id] ?? run.service_id} · started {fmtDate(run.created_at)}</p>
        </div>
        <div className="row">
          <StatusBadge status={run.status} />
          <button className="danger" onClick={remove}>Delete run</button>
        </div>
      </div>

      {isAI && (
        <div className="steps-indicator">
          <div className={`s ${stage > 1 || run.exchanges.some((e) => e.kind === 'response') ? 'done' : 'current'}`}><span className="n">1</span> Copy prompt to chatbot</div>
          <span className="sep">›</span>
          <div className={`s ${stage === 3 ? 'done' : 'current'}`}><span className="n">2</span> Paste the reply</div>
          <span className="sep">›</span>
          <div className={`s ${stage === 3 ? 'current' : ''}`}><span className="n">3</span> Review results</div>
        </div>
      )}

      {isAI && run.status !== 'completed' && (
        <div className="grid two">
          <div className="card stack">
            <div className="card-head">
              <h2>1. Copy this prompt</h2>
              {run.state.prompt && <CopyButton text={run.state.prompt} label="Copy prompt" primary />}
            </div>
            {run.state.prompt ? (
              <>
                <p className="muted small">About {run.state.estimated_tokens?.toLocaleString()} tokens. Paste it into your approved chatbot as a new conversation.</p>
                <pre className="prompt">{run.state.prompt}</pre>
              </>
            ) : <p className="muted">The prompt was not retained (see Settings → Data handling).</p>}
          </div>
          <div className="card stack">
            <h2>2. Paste the chatbot’s full reply</h2>
            {run.status === 'invalid_response' && (
              <div className="alert bad">
                <b>The last reply could not be used:</b>
                <ul>{run.errors.slice(0, 12).map((e) => <li key={e}>{e}</li>)}</ul>
                {run.errors.length > 12 && <div className="small">…and {run.errors.length - 12} more</div>}
              </div>
            )}
            {run.status === 'invalid_response' && run.state.corrective_prompt && (
              <div className="alert info">
                <div className="row between"><b>Ask the chatbot to fix it</b><CopyButton text={run.state.corrective_prompt} label="Copy follow-up" /></div>
                <p className="small muted" style={{ marginTop: 6 }}>Send this in the same chat, then paste the new reply below.</p>
              </div>
            )}
            <textarea className="code" rows={16} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Paste the reply here (Ctrl+V)…" />
            <ErrorBox error={submitError} />
            <div className="row">
              <span className="faint small">{reply.length.toLocaleString()} characters</span>
              <span className="spacer" />
              <button className="primary" disabled={!reply.trim() || busy} onClick={submit}>{busy ? 'Checking…' : 'Check & use reply'}</button>
            </div>
          </div>
        </div>
      )}

      {run.status === 'completed' && run.service_id === 'knowledge_base' && <KnowledgeBaseResult run={run} />}
      {run.status === 'completed' && ['transformation_ai', 'macro_to_workflow', 'python_to_workflow'].includes(run.service_id) && <RecipeDraftResult run={run} />}
      {run.service_id === 'transformation' && <TransformationResult run={run} />}

      {run.status === 'completed' && isAI && (run.state.warnings?.length ?? 0) > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Things to review ({run.state.warnings!.length})</h2>
            {run.state.corrective_prompt && <CopyButton text={run.state.corrective_prompt} label="Copy follow-up to fix these" />}
          </div>
          <div className="alert warn small"><ul>{run.state.warnings!.slice(0, 30).map((w) => <li key={w}>{w}</li>)}</ul></div>
          <p className="muted small" style={{ marginTop: 8 }}>You can send the follow-up and paste an improved reply below; a new version of the outputs will be created.</p>
          <textarea className="code" rows={6} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Paste an improved reply (optional)…" />
          <div className="row" style={{ marginTop: 8 }}>
            <span className="spacer" />
            <button disabled={!reply.trim() || busy} onClick={submit}>{busy ? 'Checking…' : 'Use improved reply'}</button>
          </div>
        </div>
      )}

      {latestArtifacts.length > 0 && (
        <div className="card">
          <h2>Outputs</h2>
          <ArtifactList artifacts={latestArtifacts} />
          {olderArtifacts.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>Earlier versions ({olderArtifacts.length})</summary>
              <ArtifactList artifacts={olderArtifacts} />
            </details>
          )}
        </div>
      )}

      <RunProvenance run={run} />
    </>
  )
}

function KnowledgeBaseResult({ run }: { run: Run }) {
  const s = run.summary as Record<string, number>
  const html = run.artifacts.filter((a) => a.kind === 'html').at(-1)
  return (
    <div className="card">
      <div className="card-head">
        <h2>Knowledge base ready</h2>
        {html && <a className="btn primary" href={`/api/artifacts/${html.id}/view`} target="_blank" rel="noopener">Open knowledge base ↗</a>}
      </div>
      <div className="grid three">
        <Stat label="Sections" value={s.sections} />
        <Stat label="Claims" value={s.claims} />
        <Stat label="Flagged for review" value={s.flagged_claims} tone={s.flagged_claims ? 'warn' : 'ok'} />
        <Stat label="Invalid citations" value={s.invalid_citations} tone={s.invalid_citations ? 'bad' : 'ok'} />
        <Stat label="Contradictions" value={s.contradictions} />
        <Stat label="Open questions" value={s.open_questions} />
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>Citation anchors were checked to exist. Whether a source really supports a claim is not verified automatically — spot-check flagged and important claims.</p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone?: string }) {
  return (
    <div style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 650, color: tone ? `var(--${tone})` : undefined }}>{value ?? 0}</div>
    </div>
  )
}

function RecipeDraftResult({ run }: { run: Run }) {
  const recipe = run.state.recipe
  if (!recipe) return null
  const notTranslated = (run.state.not_translated as { macro_lines: string; what_it_does: string; why: string }[] | undefined) ?? []
  const missing = (run.state.missing_data as { reference: string; why_needed: string }[] | undefined) ?? []
  const noun = run.service_id === 'python_to_workflow' ? 'script' : 'macro'
  return (
    <div className="card">
      <div className="card-head">
        <h2>Workflow draft received: {recipe.steps.length} step{recipe.steps.length === 1 ? '' : 's'}</h2>
        <Link className="btn primary" to={`/workflows/new?fromRun=${run.id}`}>Open in Workflow Studio →</Link>
      </div>
      <ol className="draft-steps">
        {recipe.steps.map((s, i) => (
          <li key={i}>
            <span className="op-dot sm" style={{ background: OP_COLOR[s.op] }}><OpIcon op={s.op} size={12} color="#fff" /></span>
            <b>{OP_LABEL[s.op] ?? s.op}</b> <span className="muted small">{stepSummary(s)}</span>
            {s.note && <div className="faint small" style={{ marginLeft: 28 }}>{s.note}</div>}
          </li>
        ))}
      </ol>
      {missing.length > 0 && (
        <div className="alert bad small" style={{ marginTop: 12 }}>
          <b>The AI says the {noun} also needs data you haven’t connected:</b>
          <ul>{missing.map((m, i) => <li key={i}><b>{m.reference}</b> — {m.why_needed}</li>)}</ul>
          Add it in the studio (Add data), or start the {noun} import again and connect it.
        </div>
      )}
      {notTranslated.length > 0 && (
        <div className="alert warn small" style={{ marginTop: 12 }}>
          <b>Parts of the {noun} that were not translated:</b>
          <ul>{notTranslated.map((m, i) => <li key={i}><span className="mono">{m.macro_lines}</span> — {m.what_it_does}{m.why ? ` (${m.why})` : ''}</li>)}</ul>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 12 }}>Nothing has been run yet. In the studio, click each step to check it against your data; it runs with the same checks as a workflow you build by hand.</p>
    </div>
  )
}

function TransformationResult({ run }: { run: Run }) {
  const steps = (run.state.steps ?? []) as StepReport[]
  const warnings = (run.summary.warnings as string[] | undefined) ?? []
  return (
    <div className="card">
      <h2>{run.status === 'completed' ? `Result: ${(run.summary.output_rows as number)?.toLocaleString()} rows` : 'Run failed'}</h2>
      {run.errors.length > 0 && <div className="alert bad"><ul>{run.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {warnings.length > 0 && <div className="alert warn small"><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      {steps.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>#</th><th>Step</th><th>Rows in</th><th>Rows out</th><th>Details</th></tr></thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.index}><td>{s.index + 1}</td><td><code>{s.op}</code></td><td>{s.rows_in.toLocaleString()}</td><td>{s.rows_out.toLocaleString()}</td>
                <td className="small muted">{Object.entries(s.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {run.config.recipe !== undefined && (
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="btn" to={`/workflows/new?fromRun=${run.id}`}>Open this recipe in the builder</Link>
        </div>
      )}
    </div>
  )
}

function RunProvenance({ run }: { run: Run }) {
  const m = run.snapshot?.manifest
  const inputs = run.state.inputs ?? (m?.inputs as Run['state']['inputs'])
  return (
    <div className="card">
      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Provenance & history</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          {m && <div className="muted small">Sources resolved at {fmtDate(m.retrieved_at)} · snapshot <span className="mono">{run.snapshot?.id}</span></div>}
          {m && m.items.length > 0 && (
            <table>
              <thead><tr><th>Ref</th><th>Source</th><th>Version</th><th>Passages</th></tr></thead>
              <tbody>
                {m.items.map((i) => (
                  <tr key={i.ref}><td className="mono">{i.ref}</td><td><div>{i.label}</div><div className="mono small faint break">{i.location}</div>{i.error && <div className="small" style={{ color: 'var(--bad)' }}>{i.error}</div>}</td><td className="mono small">{i.version}</td><td>{i.anchors.length}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {inputs && inputs.length > 0 && (
            <table>
              <thead><tr><th>Input</th><th>File</th><th>Sheet / header</th><th>Rows</th></tr></thead>
              <tbody>
                {inputs.map((i) => (
                  <tr key={i.role}><td>{i.role}</td><td className="mono small break">{i.path ?? i.label}</td><td>{i.sheet} {i.header_row && `/ row ${i.header_row}`}</td><td>{i.rows}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {run.exchanges.length > 0 && (
            <>
              <h3>Prompt / reply history</h3>
              {run.exchanges.map((e, i) => (
                <details key={i} className="segment">
                  <summary style={{ cursor: 'pointer' }} className="small">
                    <b>{e.kind === 'prompt' ? 'Prompt' : e.kind === 'response' ? `Reply #${e.attempt}` : 'Follow-up prompt'}</b>
                    {' '}· {fmtDate(e.at)} · {e.chars.toLocaleString()} chars
                    {e.kind === 'response' && <> · {e.accepted ? <span className="badge ok">accepted</span> : <span className="badge bad">rejected</span>}</>}
                  </summary>
                  {e.text ? <pre className="prompt" style={{ marginTop: 6 }}>{e.text}</pre> : <p className="faint small">Text not retained.</p>}
                </details>
              ))}
            </>
          )}
        </div>
      </details>
    </div>
  )
}
