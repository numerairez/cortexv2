import { useEffect, useState } from 'react'
import { api } from '../api'
import { templateAsDataset } from '../datasets'
import type { DataTemplate, Selection, TemplateMatch, TemplateSuggestion } from '../types'
import { FileIcon } from './Icons'
import { ErrorBox, Field, Loading, Spinner } from './ui'

interface SuggestResult { folder: string; filename: string; suggestions: TemplateSuggestion[]; formats: string[] }

/** Ask the backend whether a file looks like part of a dated series. Returns the best suggestion or null. */
export async function suggestTemplate(path: string): Promise<(TemplateSuggestion & { folder: string; formats: string[] }) | null> {
  try {
    const r = await api.post<SuggestResult>('/api/templates/suggest', { path })
    const best = r.suggestions[0]
    return best && best.matches.length >= 2 ? { ...best, folder: r.folder, formats: r.formats } : null
  } catch {
    return null
  }
}

const FORMAT_HELP: Record<string, string> = {
  text: 'any text (newest by file date)',
}

function niceName(pattern: string, format: string) {
  const base = pattern.replace(/\.[a-z0-9]+$/i, '').replace('{date}', '').replace(/[_\-.\s]+/g, ' ').trim()
  const cadence = /DD/.test(format) ? 'daily' : /MM/.test(format) ? 'monthly' : format === 'YYYY' ? 'yearly' : 'recurring'
  return `${base.charAt(0).toUpperCase()}${base.slice(1)} (${cadence})`
}

/**
 * "This file is part of a series" — confirm/adjust the filename pattern, see which files match,
 * and save it as a data template. Calls onDone with the template (as a dataset) or null for "just this file".
 */
export function TemplateOffer({ selection, suggestion, onDone, compact }: {
  selection: Selection
  suggestion: TemplateSuggestion & { folder: string; formats: string[] }
  onDone: (dataset: Selection | null) => void
  compact?: boolean
}) {
  const [name, setName] = useState(niceName(suggestion.pattern, suggestion.format))
  const [pattern, setPattern] = useState(suggestion.pattern)
  const [format, setFormat] = useState(suggestion.format)
  const [matches, setMatches] = useState<TemplateMatch[] | null>(suggestion.matches)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (pattern === suggestion.pattern && format === suggestion.format) { setMatches(suggestion.matches); setError(null); return }
    setMatches(null)
    const t = setTimeout(() => {
      api.post<{ matches: TemplateMatch[] }>('/api/templates/preview', { folder: suggestion.folder, pattern, format })
        .then((r) => { setMatches(r.matches); setError(null) })
        .catch((e: Error) => { setMatches([]); setError(e.message) })
    }, 300)
    return () => clearTimeout(t)
  }, [pattern, format, suggestion])

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const t = await api.post<DataTemplate>('/api/templates', { name, selection_id: selection.id, pattern, format })
      onDone(templateAsDataset(t))
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <span className="tpl-icon"><FileIcon kind={selection.source_kind ?? 'excel'} size={30} /><span>📅</span></span>
        <div>
          <h2 style={{ margin: 0 }}>This looks like a recurring file</h2>
          <p className="muted" style={{ margin: 0 }}>
            We found <b>{suggestion.matches.length} files</b> with the same name pattern in this folder. Save it as a <b>data template</b> and you can
            pick which {/DD/.test(format) ? 'day' : /MM/.test(format) ? 'month' : 'period'} to use each time you run a workflow — new files dropped in the folder appear automatically.
          </p>
        </div>
      </div>
      <div className="grid two">
        <Field label="Template name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="File name pattern" help={<>The part that changes is <code>{'{date}'}</code>. Sheet <b>{selection.config.sheet === '(csv)' ? 'CSV' : selection.config.sheet}</b>, headers on row <b>{selection.config.header_row}</b> apply to every file.</>}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
            <select className="inline-input" value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Date format">
              {suggestion.formats.map((f) => <option key={f} value={f}>{FORMAT_HELP[f] ?? f}</option>)}
            </select>
          </div>
        </Field>
      </div>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="row between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
          <b className="small">Matching files in <span className="mono">{suggestion.folder}</span></b>
          {matches ? <span className="badge info">{matches.length} file{matches.length === 1 ? '' : 's'}</span> : <Spinner />}
        </div>
        <div style={{ maxHeight: compact ? 160 : 220, overflow: 'auto' }}>
          {!matches ? <Loading /> : matches.length === 0 ? <div className="empty small">No files match this pattern.</div> : matches.map((m, i) => (
            <div key={m.path} className="list-item" style={{ padding: '6px 12px' }}>
              <span className="badge" style={{ minWidth: 76, justifyContent: 'center' }}>{m.label}</span>
              <span className="grow ellipsis small mono">{m.filename}</span>
              {i === 0 && <span className="badge ok">newest</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="row">
        <button onClick={() => onDone(null)}>Just use this one file</button>
        <span className="spacer" />
        <button className="primary" disabled={saving || !matches?.length || !name.trim()} onClick={save}>{saving ? 'Saving…' : 'Use as a data template'}</button>
      </div>
    </div>
  )
}

/** Dropdown to choose which file of a template to use; "" means always the newest. */
export function TemplateValuePicker({ template, value, onChange }: {
  template: DataTemplate; value: string | null; onChange: (value: string | null) => void
}) {
  const newest = template.matches[0]
  const missing = value && !template.matches.some((m) => m.value.toLowerCase() === value.toLowerCase())
  return (
    <Field label="Which file" help={<>From <span className="mono">{template.folder}</span> · pattern <span className="mono">{template.pattern}</span></>}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Always the newest{newest ? ` (currently ${newest.label})` : ''}</option>
        {missing && <option value={value!}>{value} — file not found</option>}
        {template.matches.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.filename}</option>)}
      </select>
    </Field>
  )
}
