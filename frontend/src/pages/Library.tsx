import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { ArtifactList } from '../components/Artifacts'
import { Empty, ErrorBox, Loading, useLoad } from '../components/ui'
import type { Artifact } from '../types'

export default function Library() {
  const [tab, setTab] = useState<'files' | 'kb'>('files')
  const artifacts = useLoad(() => api.get<Artifact[]>('/api/artifacts'), [])
  const isKb = (a: Artifact) => a.service_id === 'knowledge_base'
  const kbs = (artifacts.data ?? []).filter((a) => isKb(a) && a.kind === 'html')
  const files = (artifacts.data ?? []).filter((a) => !isKb(a))

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Output files</h1>
          <p className="sub">Everything your workflows and tools have produced, newest first.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>Workflow results</button>
        <button className={tab === 'kb' ? 'active' : ''} onClick={() => setTab('kb')}>Knowledge bases</button>
      </div>
      <ErrorBox error={artifacts.error} />
      {artifacts.loading && !artifacts.data ? <Loading /> : (
        <div className="card">
          {tab === 'files'
            ? files.length === 0 ? <Empty title="No result files yet"><p>Run a <Link to="/">workflow</Link> to create Excel or CSV files.</p></Empty> : <ArtifactList artifacts={files} showRun />
            : kbs.length === 0 ? <Empty title="No knowledge bases yet"><p><Link to="/services/knowledge_base">Build one</Link> from a context collection.</p></Empty> : <ArtifactList artifacts={kbs} showRun />}
        </div>
      )}
    </>
  )
}
