import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Artifact, Cell, Run } from '../types'
import { DataTable } from './DataTable'
import { FileIcon } from './Icons'
import { CopyButton, Modal, Spinner, fmtBytes, useToast } from './ui'

const DONE = ['completed', 'failed']

function seconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
}

/**
 * Tableau Prep-style run window: live progress while the workflow runs in the background,
 * then the result — where each file was saved, with Open / Show in folder / Download.
 */
export function RunDialog({ runId, title, onClose, onGoToStep }: {
  runId: string
  title: string
  onClose: () => void
  onGoToStep: (step: number, branch?: string) => void
}) {
  const [run, setRun] = useState<Run | null>(null)
  const [now, setNow] = useState(Date.now())
  const [table, setTable] = useState<{ columns: string[]; rows: Cell[][]; truncated: boolean; row_count: number } | null>(null)
  const toast = useToast()

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const r = await api.get<Run>(`/api/runs/${runId}`)
        if (!alive) return
        setRun(r)
        if (!DONE.includes(r.status)) timer = setTimeout(poll, 400)
      } catch {
        if (alive) timer = setTimeout(poll, 1000)
      }
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [runId])

  const finished = run && DONE.includes(run.status)
  // Once done, load a preview of the result table.
  const mainFiles = run?.artifacts.filter((a) => (a.metadata.output ?? 'main') === 'main') ?? []
  const resultFile = run?.status === 'completed' ? mainFiles.find((a) => a.kind === 'xlsx') ?? mainFiles.find((a) => a.kind === 'csv') : undefined
  useEffect(() => {
    if (!resultFile) return
    api.get<typeof table>(`/api/artifacts/${resultFile.id}/view`).then(setTable).catch(() => setTable(null))
  }, [resultFile?.id])
  useEffect(() => {
    if (finished) return
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [finished])

  const p = run?.state.progress
  const elapsed = run?.summary.duration_ms as number | undefined ?? (p ? Math.max(0, now - p.started * 1000) : 0)
  const pct = !p ? 2
    : p.stage === 'done' || run?.status === 'completed' ? 100
      : p.stage === 'write' ? 92
        : p.stage === 'steps' ? 25 + 65 * (p.total ? p.done / p.total : 1)
          : p.stage === 'read' ? 5 + 20 * ((p.inputs_done ?? 0) / Math.max(1, p.inputs_total ?? 1))
            : 2

  const stageState = (stage: 'read' | 'steps' | 'write') => {
    const order = ['queued', 'read', 'steps', 'write', 'done']
    if (run?.status === 'completed') return 'done'
    const cur = order.indexOf(p?.stage ?? 'queued')
    const mine = order.indexOf(stage)
    if (run?.status === 'failed') return cur > mine ? 'done' : cur === mine ? 'failed' : 'todo'
    return cur > mine ? 'done' : cur === mine ? 'active' : 'todo'
  }
  const Mark = ({ s }: { s: string }) => (
    s === 'done' ? <span className="rd-mark ok">✓</span> : s === 'active' ? <Spinner /> : s === 'failed' ? <span className="rd-mark bad">✕</span> : <span className="rd-mark todo" />
  )

  const desktop = async (a: Artifact, action: 'open' | 'reveal', copy = false) => {
    try { await api.post(`/api/artifacts/${a.id}/${action}${copy ? '?copy=true' : ''}`) } catch (e) { toast((e as Error).message, true) }
  }

  const summary = (run?.summary ?? {}) as {
    output_rows?: number; output_columns?: number; warnings?: string[]; failed_step?: number | null; failed_branch?: string | null
    saved_to?: string[]; output_folder?: string | null; save_error?: string | null
    outputs?: { id: string; name: string; rows: number; columns: number; files: string[]; dataset_id?: string }[]
  }
  // More than one output: list each with its files and whether it went to the Library.
  const outputs = summary.outputs ?? []
  const status = run?.status
  const folder = run?.artifacts[0]?.file_path?.replace(/[\\/][^\\/]+$/, '')

  return (
    <Modal wide title={status === 'completed' ? 'Workflow finished' : status === 'failed' ? 'Workflow stopped' : 'Running workflow'} onClose={onClose}
      footer={<>
        <Link className="btn ghost" to={`/runs/${runId}`}>View run details</Link>
        <span className="spacer" />
        <button className={finished ? 'primary' : ''} onClick={onClose}>{finished ? 'Close' : 'Hide — keep running'}</button>
      </>}>
      <div className="run-dialog">
        <div className="rd-head">
          {status === 'completed' ? <span className="rd-big ok">✓</span> : status === 'failed' ? <span className="rd-big bad">✕</span> : <span className="rd-big run"><Spinner /></span>}
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0 }} className="ellipsis">{title}</h2>
            <div className="muted small">
              {status === 'completed'
                ? `${(summary.output_rows ?? 0).toLocaleString()} rows × ${summary.output_columns ?? '?'} columns · finished in ${seconds(elapsed)}`
                : status === 'failed' ? `Stopped after ${seconds(elapsed)}` : `${p?.message || 'Starting…'} · ${seconds(elapsed)}`}
            </div>
          </div>
        </div>

        <div className={`rd-bar${status === 'failed' ? ' bad' : status === 'completed' ? ' ok' : ''}`}><div style={{ width: `${pct}%` }} /></div>

        {status !== 'completed' && (
        <ul className="rd-stages">
          <li><Mark s={stageState('read')} /> Read {p?.inputs_total ?? ''} input file{(p?.inputs_total ?? 0) === 1 ? '' : 's'}
            {stageState('read') === 'active' && <span className="faint"> — {p?.message}</span>}</li>
          <li><Mark s={stageState('steps')} /> Run {p?.total ?? 0} step{p?.total === 1 ? '' : 's'}
            {stageState('steps') === 'active' && <span className="faint"> — {Math.min((p?.done ?? 0) + 1, p?.total ?? 0)} of {p?.total}: {p?.message}</span>}</li>
          <li><Mark s={stageState('write')} /> Write output files
            {stageState('write') === 'active' && <span className="faint"> — {p?.message}</span>}</li>
        </ul>
        )}

        {status === 'failed' && (
          <div className="alert bad">
            <b>What went wrong:</b> {run!.errors.at(-1)}
            {summary.failed_step !== undefined && summary.failed_step !== null && (
              <div style={{ marginTop: 8 }}>
                <button className="sm" onClick={() => onGoToStep(summary.failed_step!, summary.failed_branch ?? undefined)}>Go to the step →</button>
              </div>
            )}
          </div>
        )}

        {status === 'completed' && (
          <>
            <div className="rd-section">
              <div className="row between">
                <h3 style={{ margin: 0 }}>Preview</h3>
                {table && <span className="faint small">{table.truncated ? `First ${table.rows.length.toLocaleString()} of ${(table.row_count ?? 0).toLocaleString()} rows` : `${table.rows.length.toLocaleString()} rows`}</span>}
              </div>
              <div className="rd-preview">
                {table ? <DataTable columns={table.columns} rows={table.rows} maxHeight={260} /> : <div className="empty small"><Spinner /></div>}
              </div>
            </div>

            {outputs.length > 1 && (
              <div className="rd-section">
                <h3 style={{ margin: 0 }}>{outputs.length} outputs</h3>
                <div className="rd-outputs">
                  {outputs.map((o) => (
                    <div key={o.id} className="rd-output">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <b className="ellipsis">{o.name}</b>
                        <div className="faint small">{o.rows.toLocaleString()} rows × {o.columns} columns{o.id === 'main' ? ' · main result' : ''}</div>
                      </div>
                      {o.dataset_id && <span className="badge ok" title="Kept in your Library as a dataset; updated on every run">In your Library</span>}
                      {run!.artifacts.filter((a) => (a.metadata.output ?? 'main') === o.id && (a.kind === 'xlsx' || a.kind === 'csv')).map((a) => (
                        <a key={a.id} className="btn sm" href={`/api/artifacts/${a.id}/download`} title={a.name}>
                          <FileIcon kind={a.kind === 'xlsx' ? 'excel' : 'csv'} size={14} /> {a.kind === 'xlsx' ? 'Excel' : 'CSV'}
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {outputs.length === 1 && outputs[0].dataset_id && (
              <div className="alert ok small">Added to your Library as <b>{outputs[0].name}</b>. Every run updates it.</div>
            )}

            <div className="rd-section">
              <h3 style={{ margin: 0 }}>{outputs.length > 1 ? 'Download the main result' : 'Download'}</h3>
              <div className="row">
                <a className="btn primary" href={`/api/runs/${runId}/download/xlsx`}><FileIcon kind="excel" size={18} /> Excel (.xlsx)</a>
                <a className="btn" href={`/api/runs/${runId}/download/csv`}><FileIcon kind="csv" size={18} /> CSV</a>
              </div>
            </div>

            {summary.save_error && <div className="alert bad small">{summary.save_error}</div>}
            {(summary.saved_to?.length ?? 0) > 0 && (
              <div className="rd-section rd-saved rd-folder">
                <h3 style={{ margin: 0 }}>Saved to your folder</h3>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span aria-hidden>📁</span>
                  <span className="mono small ellipsis" style={{ flex: 1 }} title={summary.output_folder ?? ''}>{summary.output_folder}</span>
                  <CopyButton text={summary.output_folder ?? ''} label="Copy path" />
                </div>
                <div className="rd-files-inline">
                  {run!.artifacts.filter((a) => a.metadata.saved_to).map((a) => (
                    <span key={a.id} className="rd-file-chip">
                      <FileIcon kind={a.kind === 'xlsx' ? 'excel' : 'csv'} size={16} />
                      <span className="ellipsis" title={String(a.metadata.saved_to)}>{String(a.metadata.saved_to).split(/[\\/]/).pop()}</span>
                      <button className="ghost sm" onClick={() => desktop(a, 'open', true)}>Open</button>
                      <button className="ghost sm" onClick={() => desktop(a, 'reveal', true)}>Show in folder</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className={`rd-section rd-saved${summary.saved_to?.length ? ' secondary' : ''}`}>
              <h3 style={{ margin: 0 }}>{summary.saved_to?.length ? 'Also kept in the run history' : 'Saved on this PC'}</h3>
              {folder && (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span className="mono small ellipsis" style={{ flex: 1 }} title={folder}>{folder}</span>
                  <button className="sm" onClick={() => resultFile && desktop(resultFile, 'reveal')}>Show in folder</button>
                  <CopyButton text={folder} label="Copy path" />
                </div>
              )}
              <div className="rd-files-inline">
                {run!.artifacts.filter((a) => a.kind === 'xlsx' || a.kind === 'csv').map((a) => (
                  <span key={a.id} className="rd-file-chip">
                    <FileIcon kind={a.kind === 'xlsx' ? 'excel' : 'csv'} size={16} />
                    <span className="ellipsis">{a.name}</span>
                    <span className="faint">{fmtBytes(a.size)}</span>
                    <button className="ghost sm" onClick={() => desktop(a, 'open')} title={a.kind === 'xlsx' ? 'Open in Excel' : 'Open with the default app'}>Open</button>
                  </span>
                ))}
              </div>
            </div>

            {(summary.warnings?.length ?? 0) > 0 && (
              <details className="alert warn small">
                <summary style={{ cursor: 'pointer' }}>{summary.warnings!.length} thing(s) to check in this run</summary>
                <ul>{summary.warnings!.map((w) => <li key={w}>{w}</li>)}</ul>
              </details>
            )}
          </>
        )}
        {!finished && <p className="faint small" style={{ margin: 0 }}>You can hide this window and keep working — the run continues and appears in History.</p>}
      </div>
    </Modal>
  )
}
