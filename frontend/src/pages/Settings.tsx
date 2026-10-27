import { useEffect, useState } from 'react'
import { api } from '../api'
import { FolderPicker } from '../components/FolderPicker'
import { ErrorBox, Field, Loading, useLoad, useToast } from '../components/ui'
import type { Settings } from '../types'

interface Env {
  python: string; python_ok: boolean; min_python: string; platform: string
  packages: Record<string, string | null>; data_dir: string; data_dir_writable: boolean; artifact_dir: string; app_version: string
}

export default function SettingsPage() {
  const env = useLoad(() => api.get<Env>('/api/env'), [])
  const settings = useLoad(() => api.get<Settings>('/api/settings'), [])
  const [form, setForm] = useState<Settings | null>(null)
  const [token, setToken] = useState('')
  const [testPage, setTestPage] = useState('')
  const [picking, setPicking] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; title?: string; version?: number } | null>(null)
  const toast = useToast()

  useEffect(() => { if (settings.data) setForm(settings.data) }, [settings.data])

  const save = async () => {
    if (!form) return
    try {
      const s = await api.put<Settings>('/api/settings', {
        confluence_base_url: form.confluence_base_url.trim(), retain_prompts: form.retain_prompts,
        prompt_token_budget: form.prompt_token_budget, chatbot_name: form.chatbot_name,
      })
      settings.setData(s)
      toast('Settings saved')
    } catch (e) { toast((e as Error).message, true) }
  }
  const saveFolder = async (save_folder: string | null) => {
    setPicking(false)
    try {
      const s = await api.put<Settings>('/api/settings', { save_folder })
      settings.setData(s)
      toast(save_folder ? 'Files will be saved there' : 'Save folder cleared')
    } catch (e) { toast((e as Error).message, true) }
  }
  const saveToken = async () => {
    await api.post('/api/confluence/token', { token })
    setToken('')
    settings.reload()
    toast('Token stored for this session only')
  }
  const clearToken = async () => { await api.del('/api/confluence/token'); settings.reload() }
  const test = async () => setTestResult(await api.post('/api/confluence/test', { page: testPage }))

  return (
    <>
      <div className="page-head">
        <div><h1>Settings</h1><p className="sub">Environment, data handling, and connections for this PC.</p></div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>Environment check</h2>
          <ErrorBox error={env.error} />
          {!env.data ? <Loading /> : (
            <dl className="kv">
              <dt>App version</dt><dd>{env.data.app_version}</dd>
              <dt>Python</dt><dd>{env.data.python} {env.data.python_ok ? <span className="badge ok">OK</span> : <span className="badge bad">needs {env.data.min_python}+</span>}</dd>
              {Object.entries(env.data.packages).map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? <span className="badge bad">missing</span>}</dd></span>
              ))}
              <dt>Data folder</dt><dd className="mono small break">{env.data.data_dir} {!env.data.data_dir_writable && <span className="badge bad">not writable</span>}</dd>
              <dt>Output files</dt><dd className="mono small break">{env.data.artifact_dir}</dd>
            </dl>
          )}
        </div>

        <div className="card stack">
          <h2>Data handling</h2>
          {!form ? <Loading /> : (
            <>
              <div>
                <span className="label small" style={{ fontWeight: 600 }}>Save files to</span>
                <div className="row" style={{ flexWrap: 'nowrap', marginTop: 6 }}>
                  <span aria-hidden>📁</span>
                  <span className={`small ellipsis${settings.data?.save_folder ? ' mono' : ' faint'}`} style={{ flex: 1 }} title={settings.data?.save_folder ?? ''}>
                    {settings.data?.save_folder ?? 'Not set — results stay in History'}
                  </span>
                  <button className="sm" onClick={() => setPicking(true)}>Change…</button>
                  {settings.data?.save_folder && <button className="sm ghost" onClick={() => saveFolder(null)}>Clear</button>}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>Used by workflows that don't have their own output folder.</div>
              </div>
              <Field label="Name of your approved AI chatbot" help="Shown in confirmations, e.g. “Copilot (company tenant)”.">
                <input value={form.chatbot_name} onChange={(e) => setForm({ ...form, chatbot_name: e.target.value })} />
              </Field>
              <div>
                <label className="check"><input type="checkbox" checked={form.retain_prompts} onChange={(e) => setForm({ ...form, retain_prompts: e.target.checked })} /> Keep prompts and replies in run history</label>
                <div className="muted small" style={{ marginLeft: 24 }}>When off, only sizes and fingerprints are stored once a run completes, and knowledge bases omit source excerpts.</div>
              </div>
              <Field label="Prompt size warning (tokens)" help="Prompts estimated above this size are flagged as unlikely to fit your chatbot.">
                <input type="number" min={1000} step={1000} value={form.prompt_token_budget} onChange={(e) => setForm({ ...form, prompt_token_budget: Number(e.target.value) })} />
              </Field>
              <div><button className="primary" onClick={save}>Save settings</button></div>
            </>
          )}
        </div>

        <div className="card stack" style={{ gridColumn: '1 / -1' }}>
          <h2>Confluence connection</h2>
          <p className="muted small">Read-only. Uses a personal access token you create in Confluence (Profile → Personal Access Tokens). The token is kept in memory for this session only and is never saved to disk.</p>
          {form && (
            <div className="grid two">
              <Field label="Confluence address" help="e.g. https://confluence.yourbank.local">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input value={form.confluence_base_url} onChange={(e) => setForm({ ...form, confluence_base_url: e.target.value })} placeholder="https://" />
                  <button onClick={save}>Save</button>
                </div>
              </Field>
              <Field label={`Personal access token ${settings.data?.confluence_token_set ? '(set for this session)' : ''}`}>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
                  <button onClick={saveToken} disabled={!token}>Use</button>
                  {settings.data?.confluence_token_set && <button onClick={clearToken}>Forget</button>}
                </div>
              </Field>
              <Field label="Test with a page URL or ID">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input value={testPage} onChange={(e) => setTestPage(e.target.value)} />
                  <button onClick={test} disabled={!testPage}>Test</button>
                </div>
              </Field>
              <div>
                {testResult && (testResult.ok
                  ? <div className="alert ok">Connected: “{testResult.title}” (version {testResult.version})</div>
                  : <div className="alert bad">{testResult.error}</div>)}
              </div>
            </div>
          )}
        </div>
      </div>
      {picking && <FolderPicker title="Save files to…" start={settings.data?.save_folder} onClose={() => setPicking(false)} onPick={saveFolder} />}
    </>
  )
}
