import { useEffect, useState } from 'react'
import { api, qs } from '../api'
import type { RecipeOutput } from '../types'
import { FolderPicker } from './FolderPicker'
import { FileIcon } from './Icons'
import { Field } from './ui'

type Output = RecipeOutput

/** Fill {date}/{time} the way the backend does, for the live example. */
function exampleName(name: string) {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return name
    .replace(/\{date\}/g, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replace(/[^\w\-. ()]+/g, '_').trim() || 'output'
}

/** Where and how a workflow saves its result — stored with the workflow. */
export function OutputSettings({ output, onChange }: { output: Output; onChange: (o: Output) => void }) {
  const [picking, setPicking] = useState(false)
  const [typed, setTyped] = useState(output.folder ?? '')
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null)
  const set = (patch: Partial<Output>) => onChange({ ...output, ...patch })

  useEffect(() => { setTyped(output.folder ?? '') }, [output.folder])
  useEffect(() => {
    if (!output.folder) { setCheck(null); return }
    const t = setTimeout(() => {
      api.get<{ ok: boolean; message: string }>(`/api/fs/check-folder?${qs({ path: output.folder })}`).then(setCheck).catch(() => setCheck(null))
    }, 250)
    return () => clearTimeout(t)
  }, [output.folder])

  const insert = (token: string) => set({ name: output.name.includes(token) ? output.name : `${output.name} ${token}`.trim() })
  const example = exampleName(output.name)

  return (
    <div className="stack">
      <Field label="File name" help={<>Will be saved as <b className="mono">{example}.{output.formats[0] ?? 'xlsx'}</b></>}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input value={output.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Revenue by region {date}" />
          <button className="sm" title="Add today's date, e.g. 2026-10-22" onClick={() => insert('{date}')}>+ date</button>
          <button className="sm" title="Add the time, e.g. 1430" onClick={() => insert('{time}')}>+ time</button>
        </div>
      </Field>

      <div>
        <span className="label small" style={{ fontWeight: 600 }}>File types</span>
        <div className="stack" style={{ marginTop: 6 }}>
          {(['xlsx', 'csv'] as const).map((f) => (
            <label className="check" key={f}>
              <input type="checkbox" checked={output.formats.includes(f)}
                onChange={(e) => set({ formats: e.target.checked ? [...output.formats, f] : output.formats.filter((x) => x !== f) })} />
              <FileIcon kind={f === 'xlsx' ? 'excel' : 'csv'} size={18} /> {f === 'xlsx' ? 'Excel workbook (with a run summary sheet)' : 'CSV file'}
            </label>
          ))}
        </div>
      </div>

      <div className="output-folder">
        <span className="label small" style={{ fontWeight: 600 }}>Save to folder</span>
        {output.folder ? (
          <>
            <div className="row" style={{ flexWrap: 'nowrap', marginTop: 6 }}>
              <span aria-hidden>📁</span>
              <span className="mono small ellipsis" style={{ flex: 1 }} title={output.folder}>{output.folder}</span>
              <button className="sm" onClick={() => setPicking(true)}>Change…</button>
              <button className="sm ghost" onClick={() => set({ folder: null })} title="Only keep results in the app's run history">Remove</button>
            </div>
            {check && <div className={`small ${check.ok ? 'ok-text' : 'bad-text'}`} style={{ marginTop: 4 }}>{check.ok ? '✓' : '⚠'} {check.message}</div>}
            <Field label="If a file with that name is already there">
              <select value={output.if_exists ?? 'keep_both'} onChange={(e) => set({ if_exists: e.target.value as Output['if_exists'] })}>
                <option value="keep_both">Keep both — add a number, e.g. “(2)”</option>
                <option value="replace">Replace it</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <p className="faint small" style={{ margin: '4px 0 6px' }}>Not set — results are kept in the app's run history, where you can open or download them.</p>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="mono" style={{ fontSize: 12.5 }} placeholder="Paste a folder, e.g. S:\Finance\Reports" value={typed}
                onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) set({ folder: typed.trim() }) }}
                onBlur={() => typed.trim() && set({ folder: typed.trim() })} />
              <button className="sm" onClick={() => setPicking(true)}>Browse…</button>
            </div>
          </>
        )}
      </div>
      <label className="check library-toggle">
        <input type="checkbox" checked={output.save_to_library !== false} onChange={(e) => set({ save_to_library: e.target.checked })} />
        <span><b>Add to your Library</b><br /><span className="faint small">Use this table in other workflows. Every run updates it, and it shows which workflow made it.</span></span>
      </label>
      <p className="faint small" style={{ margin: 0 }}>These settings are saved with the workflow (Save Workflow).</p>
      {picking && <FolderPicker start={output.folder} onClose={() => setPicking(false)} onPick={(path) => { set({ folder: path }); setPicking(false) }} />}
    </div>
  )
}
