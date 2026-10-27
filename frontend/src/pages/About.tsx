import { Link } from 'react-router-dom'
import { api } from '../api'
import { FileIcon, OP_COLOR, OpIcon } from '../components/Icons'
import { CopyButton, Loading, useLoad } from '../components/ui'
import { showTour } from '../components/Welcome'
import { CodeBadge } from './MacroImport'

interface Env {
  python: string; platform: string; app_version: string
  packages: Record<string, string | null>; data_dir: string; artifact_dir: string
}

const FEATURES = [
  {
    icon: <span className="op-dot" style={{ background: OP_COLOR.join }}><OpIcon op="join" size={16} color="#fff" /></span>,
    title: 'Visual workflows',
    text: 'Clean, combine, calculate and summarise spreadsheets step by step, see the data after every step, and rerun next month with one click.',
    to: '/', cta: 'Your workflows',
  },
  {
    icon: <span className="macro-badge sm"><FileIcon kind="excel" size={26} /><span>VBA</span></span>,
    title: 'Macros → workflows',
    text: 'Import an Excel macro. Flowbook reads it (never runs it), finds every file it uses, and your approved AI chatbot translates it into steps you can check.',
    to: '/workflows/from-macro', cta: 'Import a macro',
  },
  {
    icon: <CodeBadge language="python" size={26} small />,
    title: 'Python scripts → workflows',
    text: 'Import a pandas script or notebook. Flowbook reads it (never runs it), finds every file it uses, and your approved AI chatbot translates it into steps you can check.',
    to: '/workflows/from-python', cta: 'Import a script',
  },
  {
    icon: <CodeBadge language="doc" size={26} small />,
    title: 'Process documents → workflows',
    text: 'Import a written procedure (Word or PDF). Your approved AI chatbot turns the steps into a workflow you can check; any screenshots or flowcharts are picked out for you to attach.',
    to: '/workflows/from-document', cta: 'Import a document',
  },
  {
    icon: <span className="tpl-icon"><FileIcon kind="excel" size={26} /><span>📅</span></span>,
    title: 'Data templates',
    text: 'Point at files that arrive every month (sales_2026_01.xlsx, sales_2026_02.xlsx …) and pick which period to use each time you run.',
    to: '/sources', cta: 'My data',
  },
  {
    icon: <FileIcon kind="markdown" size={26} />,
    title: 'Cited knowledge bases',
    text: 'Turn documents and Confluence pages into a structured knowledge base whose every claim links back to its source.',
    to: '/services/knowledge_base', cta: 'Knowledge bases',
  },
]

const PRINCIPLES = [
  ['Runs only on this PC', 'Flowbook is a private app on your computer (127.0.0.1). There is no shared server and no account.'],
  ['You decide what leaves', 'Nothing is sent to an AI service automatically. You preview, redact and copy a prompt yourself into the chatbot your company approves.'],
  ['AI suggests, Flowbook checks', 'AI replies are only accepted as workflow steps from a fixed list. They are validated against your real data and never run as code.'],
  ['Macros are read, never run', 'Imported VBA is only analysed. Anything a workflow cannot do (emails, deleting files…) is listed, not dropped silently.'],
  ['Traceable results', 'Every run records which files, sheets and versions it used. Exported files never contain live formulas from your data.'],
]

const SHORTCUTS = [
  ['Ctrl + Enter', 'Run the workflow'],
  ['Ctrl + S', 'Save the workflow'],
  ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
  ['Delete', 'Remove the selected step'],
  ['Shift + click', 'Select a range of steps to group'],
  ['Double-click a group', 'Expand it'],
  ['+ / −', 'Zoom the workflow in / out'],
  ['0', 'Zoom back to 100%'],
  ['Ctrl + scroll', 'Zoom around the pointer'],
  ['Esc', 'Close menus and dialogs'],
]

const LIBRARIES: { name: string; pkg?: string; license: string; role: string }[] = [
  { name: 'FastAPI', pkg: 'fastapi', license: 'MIT', role: 'local web server' },
  { name: 'Uvicorn', pkg: 'uvicorn', license: 'BSD-3-Clause', role: 'runs the server' },
  { name: 'Pydantic', pkg: 'pydantic', license: 'MIT', role: 'validates workflows and AI replies' },
  { name: 'pandas', pkg: 'pandas', license: 'BSD-3-Clause', role: 'data processing' },
  { name: 'NumPy', pkg: 'numpy', license: 'BSD-3-Clause', role: 'numbers' },
  { name: 'openpyxl', pkg: 'openpyxl', license: 'MIT', role: 'reads and writes Excel' },
  { name: 'pypdf', pkg: 'pypdf', license: 'BSD-3-Clause', role: 'reads PDFs' },
  { name: 'pypdfium2', pkg: 'pypdfium2', license: 'Apache-2.0 / BSD-3-Clause', role: 'shows PDF pages as pictures' },
  { name: 'python-docx', pkg: 'python-docx', license: 'MIT', role: 'reads Word documents' },
  { name: 'HTTPX', pkg: 'httpx', license: 'BSD-3-Clause', role: 'Confluence connection' },
  { name: 'olefile', pkg: 'olefile', license: 'BSD-2-Clause', role: 'reads Excel macro storage' },
  { name: 'React', license: 'MIT', role: 'user interface' },
  { name: 'React Router', license: 'MIT', role: 'page navigation' },
  { name: 'Vite', license: 'MIT', role: 'builds the interface' },
]

export default function About() {
  const { data: env } = useLoad(() => api.get<Env>('/api/env'), [])

  return (
    <div className="about">
      <div className="about-hero">
        <img src="/logo.svg" alt="" width="72" height="72" />
        <div>
          <h1 style={{ fontSize: 28 }}>Flowbook</h1>
          <p className="about-tagline">Repeatable spreadsheet workflows — no macros needed.</p>
          <div className="row">
            <span className="badge info">Version {env?.app_version ?? '…'}</span>
            <span className="badge ok">Runs only on this PC</span>
            <button className="sm" onClick={showTour}>▶ Take the tour</button>
          </div>
        </div>
      </div>

      <h2 className="about-h">What you can do</h2>
      <div className="about-features">
        {FEATURES.map((f) => (
          <div key={f.title} className="card about-feature">
            <div className="about-feature-icon">{f.icon}</div>
            <h3 style={{ margin: 0 }}>{f.title}</h3>
            <p className="muted small" style={{ flex: 1, margin: 0 }}>{f.text}</p>
            <Link to={f.to} className="small">{f.cta} →</Link>
          </div>
        ))}
      </div>

      <div className="grid two" style={{ marginTop: 24 }}>
        <div className="card">
          <h2>How your data is handled</h2>
          <ul className="about-principles">
            {PRINCIPLES.map(([t, d]) => <li key={t}><b>{t}.</b> <span className="muted">{d}</span></li>)}
          </ul>
        </div>
        <div className="card">
          <h2>Keyboard shortcuts</h2>
          <table className="about-keys">
            <tbody>
              {SHORTCUTS.map(([k, d]) => (
                <tr key={k}><td>{k.split(' / ').map((part, i) => (
                  <span key={i}>{i > 0 && ' / '}{part.split(' + ').map((key, j) => <span key={j}>{j > 0 && ' + '}{/click|scroll/i.test(key) ? <i>{key}</i> : <kbd>{key}</kbd>}</span>)}</span>
                ))}</td><td className="muted">{d}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>This installation</h2>
          {!env ? <Loading /> : (
            <dl className="kv">
              <dt>Version</dt><dd>{env.app_version}</dd>
              <dt>Python</dt><dd>{env.python} ({env.platform})</dd>
              <dt>Your data</dt>
              <dd><div className="row" style={{ flexWrap: 'nowrap' }}><span className="mono small break">{env.data_dir}</span><CopyButton text={env.data_dir} label="Copy" /></div></dd>
              <dt>Run outputs</dt><dd className="mono small break">{env.artifact_dir}</dd>
            </dl>
          )}
          <p className="faint small" style={{ marginTop: 12, marginBottom: 0 }}>Your data folder is separate from the app, so updating Flowbook never touches your workflows. See <Link to="/settings">Settings</Link> for the full environment check.</p>
        </div>
        <div className="card">
          <h2>Built with open source</h2>
          <table className="about-libs">
            <tbody>
              {LIBRARIES.map((l) => (
                <tr key={l.name}>
                  <td><b>{l.name}</b>{l.pkg && env?.packages[l.pkg] && <span className="faint small"> {env.packages[l.pkg]}</span>}</td>
                  <td className="muted small">{l.role}</td>
                  <td><span className="badge">{l.license}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="faint small" style={{ textAlign: 'center', marginTop: 24 }}>Flowbook · version {env?.app_version ?? ''} · made for colleagues who live in Excel</p>
    </div>
  )
}
