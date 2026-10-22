import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Empty, ErrorBox, Loading, StatusBadge, fmtDate, useLoad } from '../components/ui'
import type { Run } from '../types'

const SERVICE: Record<string, string> = {
  knowledge_base: 'Knowledge base', transformation: 'Transformation', transformation_ai: 'AI recipe draft',
}

export default function Runs() {
  const { data, error, loading } = useLoad(() => api.get<Run[]>('/api/runs'), [])
  const nav = useNavigate()
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="sub">Every execution is kept as its own record, with the sources, prompts, replies, and outputs it used.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data?.length === 0 ? (
        <div className="card"><Empty title="No runs yet"><p>Start one from Services.</p></Empty></div>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Title</th><th>Service</th><th>Status</th><th>Collection</th><th>Outputs</th><th>Started</th></tr></thead>
              <tbody>
                {data?.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/runs/${r.id}`)}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td>{SERVICE[r.service_id] ?? r.service_id}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="muted">{r.collection_name ?? '—'}</td>
                    <td>{r.artifact_count}</td>
                    <td className="nowrap small muted">{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
