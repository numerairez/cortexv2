import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Empty, ErrorBox, Loading, fmtDate, useLoad } from '../components/ui'
import type { Collection } from '../types'

export default function Contexts() {
  const { data, error, loading } = useLoad(() => api.get<Collection[]>('/api/collections'), [])
  const nav = useNavigate()
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Contexts</h1>
          <p className="sub">Reusable sets of sheets, documents, and pages. Collections store references, so they can be refreshed later.</p>
        </div>
        <Link className="btn primary" to="/contexts/new">+ New collection</Link>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && data.length === 0 ? (
        <div className="card">
          <Empty title="No collections yet">
            <p>A collection groups the selections you want to use together, e.g. “Q1 sales pack” or “Refund policies”.</p>
            <Link className="btn primary" to="/contexts/new">Create a collection</Link>
          </Empty>
        </div>
      ) : (
        <div className="card flush">
          <table>
            <thead><tr><th>Name</th><th>Items</th><th>Description</th><th>Updated</th></tr></thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/contexts/${c.id}`)}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>{c.item_count}</td>
                  <td className="muted">{c.description}</td>
                  <td className="nowrap small muted">{fmtDate(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
