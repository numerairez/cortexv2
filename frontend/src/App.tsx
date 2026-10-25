import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import About from './pages/About'
import CollectionEditor from './pages/CollectionEditor'
import Contexts from './pages/Contexts'
import DashboardEditor from './pages/DashboardEditor'
import Dashboards from './pages/Dashboards'
import Library from './pages/Library'
import MacroImport from './pages/MacroImport'
import RunWorkspace from './pages/RunWorkspace'
import Runs from './pages/Runs'
import ServiceLaunch from './pages/ServiceLaunch'
import Services from './pages/Services'
import SettingsPage from './pages/Settings'
import SourceDetail from './pages/SourceDetail'
import Sources from './pages/Sources'
import Studio from './pages/Studio'
import Workflows from './pages/Workflows'

const I = {
  workflows: <><circle cx="5" cy="12" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M7.5 12h4l5-6M11.5 12l5 6" /></>,
  sources: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  contexts: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><path d="M17 14v6M14 17h6" /></>,
  dashboards: <><rect x="3" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="3" y="10" width="18" height="11" rx="1.5" /><path d="M7 17v-2M11 17v-4M15 17v-3" /></>,
  services: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>,
  runs: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  library: <path d="M4 4h5v16H4zM10 4h5v16h-5zM16 5l4 1-3 14-4-1" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
}

function Icon({ d }: { d: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
}

const NAV: { to: string; label: string; icon: React.ReactNode; end?: boolean; section?: string }[] = [
  { to: '/', label: 'Workflows', icon: I.workflows, end: true },
  { to: '/dashboards', label: 'Dashboards', icon: I.dashboards },
  { to: '/sources', label: 'My data', icon: I.sources },
  { to: '/runs', label: 'History', icon: I.runs },
  { to: '/library', label: 'Output files', icon: I.library },
  { to: '/services', label: 'Knowledge bases', icon: I.services, section: 'More tools' },
  { to: '/contexts', label: 'Context collections', icon: I.contexts },
  { to: '/settings', label: 'Settings', icon: I.settings, section: ' ' },
  { to: '/about', label: 'About', icon: I.about },
]

/** Old /transform links → the studio, keeping their query string. */
function LegacyTransform() {
  const { search } = useLocation()
  return <Navigate to={`/workflows/new${search}`} replace />
}

export default function App() {
  const { pathname } = useLocation()
  const inWorkflows = pathname === '/' || pathname.startsWith('/workflows')
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" width="28" height="28" />
          Flowbook
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <span key={n.to} style={{ display: 'contents' }}>
              {n.section && <div className="nav-section">{n.section}</div>}
              <NavLink to={n.to} end={n.end} className={({ isActive }) => (isActive || (n.to === '/' && inWorkflows) ? 'active' : '')} title={n.label}>
                <Icon d={n.icon} /><span className="label">{n.label}</span>
              </NavLink>
            </span>
          ))}
        </nav>
        <div className="foot">Runs only on this PC.<br />Nothing is sent anywhere unless you copy it.</div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Workflows />} />
          <Route path="/workflows/from-macro" element={<MacroImport />} />
          <Route path="/workflows/from-python" element={<MacroImport key="python" language="python" />} />
          <Route path="/workflows/:id" element={<Studio />} />
          <Route path="/dashboards" element={<Dashboards />} />
          <Route path="/dashboards/:id" element={<DashboardEditor />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/sources/:id" element={<SourceDetail />} />
          <Route path="/contexts" element={<Contexts />} />
          <Route path="/contexts/new" element={<CollectionEditor />} />
          <Route path="/contexts/:id" element={<CollectionEditor />} />
          <Route path="/services" element={<Services />} />
          <Route path="/services/:id" element={<ServiceLaunch />} />
          <Route path="/transform" element={<LegacyTransform />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunWorkspace />} />
          <Route path="/library" element={<Library />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
