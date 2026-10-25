import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Cell, Run } from '../types'
import { DataTable } from './DataTable'
import { ErrorBox, Field, Loading, Modal } from './ui'

export function SaveModal({ meta, saving, onClose, onSave }: {
  meta: { id?: string; name: string; description: string }; saving: boolean; onClose: () => void
  onSave: (name: string, description: string, asNew: boolean) => void
}) {
  const [name, setName] = useState(meta.name)
  const [description, setDescription] = useState(meta.description)
  return (
    <Modal title={meta.id ? 'Save workflow' : 'Save workflow'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      {meta.id && <button disabled={!name.trim() || saving} onClick={() => onSave(name, description, true)}>Save as a copy</button>}
      <button className="primary" disabled={!name.trim() || saving} onClick={() => onSave(name, description, false)}>{meta.id ? 'Save new version' : 'Save'}</button>
    </>}>
      <div className="stack">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Monthly revenue by region" /></Field>
        <Field label="Description (optional)"><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <p className="muted small">The workflow remembers the columns each input should have, so next month you can connect new files and it will tell you if anything changed.</p>
      </div>
    </Modal>
  )
}

/** Leaving the studio with an unsaved workflow: save it (so it can be reopened from Workflows), discard, or stay. */
export function LeaveModal({ meta, saving, isNew, onStay, onDiscard, onSave }: {
  meta: { name: string; description: string }; saving: boolean; isNew: boolean
  onStay: () => void; onDiscard: () => void; onSave: (name: string, description: string) => void
}) {
  const [name, setName] = useState(meta.name)
  return (
    <Modal title={isNew ? 'Save this workflow before you go?' : 'Save your changes before you go?'} onClose={onStay} footer={<>
      <button className="ghost danger" onClick={onDiscard} disabled={saving} style={{ marginRight: 'auto' }}>{isNew ? 'Leave without saving' : 'Discard changes'}</button>
      <button onClick={onStay} disabled={saving}>Keep editing</button>
      <button className="primary" disabled={!name.trim() || saving} onClick={() => onSave(name, meta.description)}>{saving ? 'Saving…' : 'Save and leave'}</button>
    </>}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          {isNew
            ? 'This workflow isn’t saved yet. Save it to come back to it later from Workflows, or to run it again next month.'
            : 'You have changes that aren’t saved. Save them as a new version, or they will be lost.'}
        </p>
        {isNew && (
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Monthly revenue by region"
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name, meta.description) }} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

interface AIContext { inputs: { role: string; label: string; rows: number; columns: { name: string; type: string; nulls: number; distinct: number }[]; sample?: { columns: string[]; rows: Cell[][] } }[] }

export function AIDraftModal({ bindings, roles, onClose }: { bindings: Record<string, string>; roles: string[]; onClose: () => void }) {
  const [goal, setGoal] = useState('')
  const [includeSamples, setIncludeSamples] = useState(false)
  const [sampleRows, setSampleRows] = useState(5)
  const [ctx, setCtx] = useState<AIContext | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const nav = useNavigate()
  const b = Object.fromEntries(roles.map((r) => [r, bindings[r]]))

  useEffect(() => {
    api.post<AIContext>('/api/transform/ai-preview', { bindings: b, options: { include_samples: includeSamples, sample_rows: sampleRows } })
      .then(setCtx).catch((e: Error) => setError(e.message))
    setConfirmed(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeSamples, sampleRows])

  const start = async () => {
    setBusy(true); setError(null)
    try {
      const run = await api.post<Run>('/api/runs', { service_id: 'transformation_ai', bindings: b, title: `Recipe draft: ${goal.slice(0, 60)}`, options: { goal, include_samples: includeSamples, sample_rows: sampleRows } })
      nav(`/runs/${run.id}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Ask your AI chatbot to draft the steps" wide onClose={onClose} footer={step === 1 ? <>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!goal.trim()} onClick={() => setStep(2)}>Next →</button>
    </> : <>
      <button onClick={() => setStep(1)}>← Back</button>
      <button className="primary" disabled={!goal.trim() || !confirmed || busy} onClick={start}>{busy ? 'Building prompt…' : 'Generate prompt →'}</button>
    </>}>
      {step === 1 ? (
        <div className="stack">
          <Field label="Describe the result you want" help="e.g. “Combine January and February, add product category from the product list, and total revenue (qty × price) by region and category.”">
            <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />
          </Field>
          <div className="row">
            <label className="check"><input type="checkbox" checked={includeSamples} onChange={(e) => setIncludeSamples(e.target.checked)} /> Include sample rows</label>
            {includeSamples && <input type="number" className="inline-input" style={{ width: 80 }} min={1} max={20} value={sampleRows} onChange={(e) => setSampleRows(Number(e.target.value))} aria-label="Sample rows" />}
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">Review what will be sent to the chatbot.{includeSamples ? '' : ' Without samples, only column names, types, and counts are sent.'}</p>
          <ErrorBox error={error} />
          {!ctx ? <Loading /> : ctx.inputs.map((i) => (
            <div key={i.role} className="segment">
              <b className="mono">{i.role}</b> <span className="muted small">{i.rows.toLocaleString()} rows</span>
              <div className="small muted" style={{ marginTop: 4 }}>{i.columns.map((c) => `${c.name} (${c.type})`).join(', ')}</div>
              {i.sample && <div style={{ marginTop: 6 }}><DataTable columns={i.sample.columns} rows={i.sample.rows} maxHeight={180} /></div>}
            </div>
          ))}
          <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm this information may be shared with the approved chatbot.</label>
        </div>
      )}
    </Modal>
  )
}
