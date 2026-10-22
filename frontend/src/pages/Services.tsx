import { Link } from 'react-router-dom'
import { api } from '../api'
import { ErrorBox, Loading, ModeBadge, useLoad } from '../components/ui'
import type { ServiceDef } from '../types'

const COMING = [
  { name: 'Dashboard Builder', description: 'Pick metrics, dimensions, and charts from your tables. Every number is computed locally; refresh from new workbooks.', milestone: 'Milestone 4' },
]

export default function Services() {
  const { data, error, loading } = useLoad(() => api.get<ServiceDef[]>('/api/services'), [])
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Services</h1>
          <p className="sub">Ready-made workflows. “Runs locally” services never use AI. AI services only see what you copy into your approved chatbot.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : (
        <div className="grid three">
          {data?.map((s) => (
            <div className="card service-card" key={s.id}>
              <div className="row"><ModeBadge mode={s.mode} /></div>
              <h2 style={{ margin: 0 }}>{s.name}</h2>
              <p className="desc">{s.description}</p>
              <div className="faint small">Produces: {s.outputs.join(', ')}</div>
              <div><Link className="btn primary" to={s.builder_route ?? `/services/${s.id}`}>Start</Link></div>
            </div>
          ))}
          {COMING.map((s) => (
            <div className="card service-card" key={s.name} style={{ opacity: 0.7 }}>
              <div className="row"><span className="badge">{s.milestone}</span></div>
              <h2 style={{ margin: 0 }}>{s.name}</h2>
              <p className="desc">{s.description}</p>
              <div><button disabled>Coming soon</button></div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
