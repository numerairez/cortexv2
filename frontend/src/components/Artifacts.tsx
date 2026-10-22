import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Artifact, Cell } from '../types'
import { DataTable } from './DataTable'
import { FileIcon } from './Icons'
import { ErrorBox, Loading, Modal, fmtBytes, fmtDate } from './ui'

const KIND_LABEL: Record<Artifact['kind'], string> = {
  xlsx: 'Excel', csv: 'CSV', markdown: 'Markdown', html: 'Web page', json: 'JSON',
}

export function ArtifactList({ artifacts, showRun }: { artifacts: Artifact[]; showRun?: boolean }) {
  const [viewing, setViewing] = useState<Artifact | null>(null)
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>File</th><th>Type</th>{showRun && <th>From run</th>}<th>Size</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {artifacts.map((a) => (
              <tr key={a.id}>
                <td style={{ fontWeight: 600 }} className="break"><span className="row" style={{ flexWrap: 'nowrap' }}><FileIcon kind={a.kind} size={22} />{a.name}</span></td>
                <td><span className="badge">{KIND_LABEL[a.kind]}</span></td>
                {showRun && <td className="small"><a href={`/runs/${a.run_id}`}>{a.run_title ?? a.run_id}</a></td>}
                <td className="small muted nowrap">{fmtBytes(a.size)}</td>
                <td className="small muted nowrap">{fmtDate(a.created_at)}</td>
                <td className="nowrap">
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    {a.kind === 'html'
                      ? <a className="btn sm" href={`/api/artifacts/${a.id}/view`} target="_blank" rel="noopener">Open ↗</a>
                      : <button className="sm" onClick={() => setViewing(a)}>Preview</button>}
                    <a className="btn sm" href={`/api/artifacts/${a.id}/download`}>Download</a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {viewing && <ArtifactPreview artifact={viewing} onClose={() => setViewing(null)} />}
    </>
  )
}

export function ArtifactPreview({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [state, setState] = useState<{ text?: string; table?: { columns: string[]; rows: Cell[][]; truncated: boolean; row_count: number }; error?: string } | null>(null)
  useEffect(() => {
    const url = `/api/artifacts/${artifact.id}/view`
    if (artifact.kind === 'xlsx' || artifact.kind === 'csv') {
      api.get<{ columns: string[]; rows: Cell[][]; truncated: boolean; row_count: number }>(url)
        .then((t) => setState({ table: t })).catch((e: Error) => setState({ error: e.message }))
    } else {
      fetch(url).then((r) => r.text()).then((t) => setState({ text: t })).catch((e: Error) => setState({ error: e.message }))
    }
  }, [artifact.id, artifact.kind])
  return (
    <Modal title={artifact.name} wide onClose={onClose} footer={<>
      <a className="btn" href={`/api/artifacts/${artifact.id}/download`}>Download</a>
      <button onClick={onClose}>Close</button>
    </>}>
      {!state ? <Loading /> : state.error ? <ErrorBox error={state.error} /> : state.table ? (
        <>
          {state.table.truncated && <p className="muted small">Showing the first {state.table.rows.length} of {state.table.row_count?.toLocaleString()} rows.</p>}
          <DataTable columns={state.table.columns} rows={state.table.rows} maxHeight={520} />
        </>
      ) : <pre className="prompt" style={{ maxHeight: 520 }}>{state.text}</pre>}
    </Modal>
  )
}
