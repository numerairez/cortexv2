import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, uploadFile } from '../api'
import { AddDataModal, type UploadResult } from '../components/AddData'
import { DataTable } from '../components/DataTable'
import { FileIcon, OP_COLOR, OpIcon } from '../components/Icons'
import { OutputSettings } from '../components/OutputSettings'
import { ProfilePane, type ColumnProfile } from '../components/ProfilePane'
import { RunDialog } from '../components/RunDialog'
import { OP_LABEL, StepEditor, newStep, stepSummary } from '../components/StepEditor'
import { AIDraftModal, SaveModal } from '../components/StudioModals'
import { TemplateValuePicker } from '../components/Templates'
import { ErrorBox, Field, Loading, Spinner, useToast } from '../components/ui'
import { bindingId, bindingValue, useDatasets } from '../datasets'
import { groupOf, layoutMain, shiftOnDelete, shiftOnInsert } from '../groups'
import type { Cell, Collection, ColumnSchema, Recipe, RecipeDetail, Run, Selection, Source, Step, StepGroup, TransformPreview } from '../types'

const OP_HELP: Record<string, string> = {
  select_columns: 'Keep, drop or reorder columns',
  rename_columns: 'Give columns clearer names',
  filter_rows: 'Keep only the rows you need',
  sort_rows: 'Put rows in order',
  convert_types: 'Fix text that should be numbers or dates',
  derive_column: 'Add a column with a formula',
  deduplicate: 'Remove repeated rows',
  join: 'Look up columns from another table',
  append_rows: 'Stack tables that have the same columns',
  group_aggregate: 'Totals, averages and counts per group',
  pivot: 'Turn values into columns',
  unpivot: 'Turn columns into rows',
}
const CATALOG: { group: string; ops: string[] }[] = [
  { group: 'Clean', ops: ['filter_rows', 'select_columns', 'rename_columns', 'convert_types', 'derive_column', 'deduplicate', 'sort_rows'] },
  { group: 'Combine', ops: ['join', 'append_rows'] },
  { group: 'Summarise & reshape', ops: ['group_aggregate', 'pivot', 'unpivot'] },
]

const COL_W = 150
const LANE_H = 112
// Nodes are 124px wide and centred on their x, so this must exceed 62 or the first label clips.
const PAD_X = 74
const PAD_Y = 46

/** A selected node. Steps with `branch` belong to that input's own row (prepared before the main flow). */
type Sel = { kind: 'input'; role: string } | { kind: 'step'; i: number; branch?: string } | { kind: 'group'; id: string } | { kind: 'output' }
/** Where the add-step menu is open: insert position (+ branch) and the screen rectangle of the "+" button. */
type AddAt = { i: number; branch?: string; left: number; top: number; bottom: number } | null

// ---- resizable panel layout, remembered per browser
interface Layout { canvasH: number; midH: number; settingsW: number }
const LAYOUT_KEY = 'cw.studio.layout'
const DEFAULT_LAYOUT: Layout = { canvasH: 220, midH: 310, settingsW: 400 }
const LIMITS: Record<keyof Layout, [number, () => number]> = {
  canvasH: [120, () => window.innerHeight * 0.6],
  midH: [140, () => window.innerHeight * 0.7],
  settingsW: [280, () => window.innerWidth * 0.6],
}
// ---- canvas zoom
const ZOOM_MIN = 0.3
const ZOOM_MAX = 1.5
const ZOOM_KEY = 'cw.studio.zoom'
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100
function loadZoom(): number {
  try { return clampZoom(Number(localStorage.getItem(ZOOM_KEY)) || 1) } catch { return 1 }
}

function loadLayout(): Layout {
  try { return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') } } catch { return DEFAULT_LAYOUT }
}
type Preview = TransformPreview & { data?: TransformPreview['data'] & { profile: ColumnProfile[] } }
interface MacroInfo { not_translated: { macro_lines: string; what_it_does: string; why: string }[]; missing_data: { reference: string; why_needed: string }[] }
interface History { past: Recipe[]; present: Recipe; future: Recipe[] }

const emptyRecipe = (): Recipe => ({ schema_version: 1, inputs: [{ role: 'data' }], base: 'data', steps: [], output: { name: 'result', formats: ['xlsx'] } })

export function roleFrom(label: string, taken: string[]): string {
  let r = label.replace(/\.[a-z]{2,4}$/i, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/_+$/, '').toLowerCase().slice(0, 30) || 'input'
  const base = r
  let n = 2
  while (taken.includes(r)) r = `${base}_${n++}`
  return r
}

const bindingsKey = (id: string) => `cw.bindings.${id}`
function loadBindings(id: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(bindingsKey(id)) ?? '{}') } catch { return {} }
}
function storeBindings(id: string, b: Record<string, string>) {
  try { localStorage.setItem(bindingsKey(id), JSON.stringify(b)) } catch { /* ignore */ }
}
const extOf = (name?: string) => (name?.match(/\.[a-z0-9]+$/i)?.[0] ?? '')
/** "Mar 2026" for a pinned template file, "Mar 2026 · newest" when following the newest. */
function periodLabel(s: Selection, binding: string | undefined, resolved?: string | null) {
  const pinned = bindingValue(binding)
  const v = pinned ?? resolved ?? s.template?.matches[0]?.value
  const label = s.template?.matches.find((m) => m.value === v)?.label ?? v ?? 'no files'
  return pinned ? label : `${label} · newest`
}
const isDefaultRole = (r: string) => /^(data|input_\d+)$/.test(r)

/** Roles referenced by a step (join right side, appended inputs). */
function stepRefs(s: Step): string[] {
  if (s.op === 'join') return [String(s.right ?? '')].filter(Boolean)
  if (s.op === 'append_rows') return (s.inputs as string[]) ?? []
  return []
}

export default function Studio() {
  const { id: rawId } = useParams()
  const routeId = rawId === 'new' ? undefined : rawId
  const [params] = useSearchParams()
  const nav = useNavigate()
  const toast = useToast()
  // Datasets = sheet selections + data templates. Bindings may be "templateId@value" for a specific file.
  const { datasets: allSelections, byId: datasetById, add: addKnownDataset, reload: reloadDatasets } = useDatasets()
  const byId = useMemo(() => new Proxy(datasetById, { get: (t, k: string) => t[bindingId(k)] }) as Record<string, Selection>, [datasetById])

  // ---- recipe with undo/redo history
  const [hist, setHist] = useState<History>({ past: [], present: emptyRecipe(), future: [] })
  const recipe = hist.present
  const setRecipe = (r: Recipe) => setHist((h) => ({ past: [...h.past.slice(-99), h.present], present: r, future: [] }))
  const resetRecipe = (r: Recipe) => setHist({ past: [], present: r, future: [] })
  const undo = () => setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h))
  const redo = () => setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h))

  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [meta, setMeta] = useState<{ id?: string; name: string; description: string; version?: number }>({ name: '', description: '' })
  const [saved, setSaved] = useState<string>(JSON.stringify({ r: emptyRecipe(), n: '' }))
  const [origin, setOrigin] = useState<'manual' | 'ai'>('manual')
  const [macroInfo, setMacroInfo] = useState<MacroInfo | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sel, setSel] = useState<Sel>({ kind: 'output' })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [addData, setAddData] = useState<{ role?: string; presetSource?: Source } | null>(null)
  const [running, setRunning] = useState(false)
  const [runDialog, setRunDialog] = useState<{ id: string; title: string } | null>(null)
  const [addAt, setAddAt] = useState<AddAt>(null)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [zoom, setZoomState] = useState<number>(loadZoom)
  const canvasRef = useRef<HTMLDivElement>(null)
  // Drag-to-pan offset of the whole flow, on top of normal scrolling.
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const panDrag = useRef<{ id: number; x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const [dropping, setDropping] = useState(false)
  // Step groups: which are expanded (UI only), and a Shift+click range of main-flow steps to group.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  const [groupName, setGroupName] = useState('')
  const seq = useRef(0)

  const dirty = JSON.stringify({ r: recipe, n: meta.name }) !== saved && (recipe.steps.length > 0 || !!meta.id)

  // ---- initial load: saved workflow, AI/macro draft, collection, or a freshly dropped file
  useEffect(() => {
    if (!allSelections || loaded) return
    const recipeId = routeId ?? params.get('recipe')
    const fromRun = params.get('fromRun')
    const collectionId = params.get('collection')
    const sourceId = params.get('source')
    const done = () => setLoaded(true)
    if (recipeId) {
      api.get<RecipeDetail>(`/api/recipes/${recipeId}`).then((r) => {
        resetRecipe(r.version.definition)
        setMeta({ id: r.id, name: r.name, description: r.description, version: r.version.version })
        setSaved(JSON.stringify({ r: r.version.definition, n: r.name }))
        const prior = { ...r.last_bindings, ...loadBindings(r.id) }
        const auto: Record<string, string> = {}
        // Templates reopen on "always the newest" — the usual reason to rerun is that a new file arrived.
        for (const i of r.version.definition.inputs) {
          const b = prior[i.role]
          if (b && byId[b]) auto[i.role] = b.startsWith('tpl_') ? bindingId(b) : b
        }
        setBindings(auto)
        setSel(r.version.definition.inputs.some((i) => !auto[i.role]) ? { kind: 'input', role: r.version.definition.inputs.find((i) => !auto[i.role])!.role } : { kind: 'output' })
      }).catch((e: Error) => toast(e.message, true)).finally(done)
    } else if (fromRun) {
      api.get<Run>(`/api/runs/${fromRun}`).then((run) => {
        const r = (run.state.recipe ?? run.config.recipe) as Recipe | undefined
        if (r) resetRecipe({ ...emptyRecipe(), ...r })
        setBindings((run.config.bindings as Record<string, string>) ?? {})
        if (run.service_id !== 'transformation') setOrigin('ai')
        if (run.service_id === 'macro_to_workflow') {
          setMacroInfo({ not_translated: (run.state.not_translated as MacroInfo['not_translated']) ?? [], missing_data: (run.state.missing_data as MacroInfo['missing_data']) ?? [] })
          setMeta((m) => ({ ...m, name: `${String((run.config.options as Record<string, unknown>)?.macro_name || 'Macro')} (workflow)` }))
        }
      }).catch((e: Error) => toast(e.message, true)).finally(done)
    } else if (collectionId) {
      api.get<Collection>(`/api/collections/${collectionId}`).then((c) => {
        const items = (c.items ?? []).filter((i) => i.kind === 'sheet' && i.included && !i.removed)
        if (items.length) {
          const roles: string[] = []
          const b: Record<string, string> = {}
          for (const it of items) { const r = roleFrom(it.label, roles); roles.push(r); b[r] = it.selection_id }
          resetRecipe({ ...emptyRecipe(), inputs: roles.map((role) => ({ role })), base: roles[0] })
          setBindings(b)
        }
      }).finally(done)
    } else {
      setSel({ kind: 'input', role: 'data' })
      if (sourceId) api.get<Source>(`/api/sources/${sourceId}`).then((s) => setAddData({ role: 'data', presetSource: s })).catch(() => undefined)
      done()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSelections])

  const roles = recipe.inputs.map((i) => i.role)
  const err = preview?.error
  const rawCols = (r: string): ColumnSchema[] => byId[bindings[r]]?.schema ?? []
  // Columns an input offers to joins/appends: after its own steps, if it has any.
  const roleCols: Record<string, ColumnSchema[]> = Object.fromEntries(roles.map((r) => [r, preview?.branches?.[r]?.at(-1)?.columns ?? rawCols(r)]))
  const groups: StepGroup[] = recipe.groups ?? []
  const groupById = (id: string) => groups.find((g) => g.id === id)
  const toggleGroup = (id: string, open?: boolean) => setExpanded((cur) => {
    const next = new Set(cur)
    if (open ?? !next.has(id)) next.add(id)
    else next.delete(id)
    return next
  })
  const stepsOf = (branch?: string): Step[] => (branch ? recipe.inputs.find((i) => i.role === branch)?.steps ?? [] : recipe.steps)
  const reportOf = (i: number, branch?: string) => (branch ? preview?.branches?.[branch]?.[i] : preview?.steps[i])
  const isErrAt = (i: number, branch?: string) => !!err && err.step === i && (err.branch ?? undefined) === branch
  const allBound = roles.every((r) => bindings[r])
  const anyBound = roles.some((r) => bindings[r])

  const colsBefore = (i: number, branch?: string): ColumnSchema[] => {
    if (i === 0) return rawCols(branch ?? recipe.base)
    return reportOf(i - 1, branch)?.columns ?? colsBefore(i - 1, branch)
  }

  // ---- live preview of the selected node
  const upto = sel.kind === 'step' ? sel.i : sel.kind === 'group' ? groupById(sel.id)?.end ?? null
    : sel.kind === 'input' && sel.role === recipe.base ? -1 : null
  const viewRole = sel.kind === 'step' && sel.branch ? sel.branch : sel.kind === 'input' && sel.role !== recipe.base ? sel.role : null
  useEffect(() => {
    if (!loaded || !allBound) { setPreview(null); return }
    const n = ++seq.current
    setPreviewing(true)
    const t = setTimeout(() => {
      api.post<Preview>('/api/transform/preview', { recipe, bindings, upto, view_role: viewRole })
        .then((p) => { if (n === seq.current) { setPreview(p); setPreviewError(null) } })
        .catch((e: Error) => { if (n === seq.current) setPreviewError(e.message) })
        .finally(() => { if (n === seq.current) setPreviewing(false) })
    }, 350)
    return () => clearTimeout(t)
  }, [recipe, bindings, upto, viewRole, loaded, allBound])

  // ---- keep the selected node visible (e.g. a newly added input on a lower row)
  useEffect(() => {
    const t = setTimeout(() => document.querySelector('.prep-canvas .flow-node.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), 50)
    return () => clearTimeout(t)
  }, [sel, recipe.inputs.length])

  // ---- warn before leaving with unsaved changes
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ---- editing helpers (branch = an input's own row; undefined = main flow)
  const setSteps = (steps: Step[], branch?: string) => setRecipe(branch
    ? { ...recipe, inputs: recipe.inputs.map((i) => (i.role === branch ? { ...i, steps } : i)) }
    : { ...recipe, steps })
  const insertStep = (at: number, s: Step, branch?: string) => {
    const steps = [...stepsOf(branch)]
    steps.splice(at, 0, s)
    if (branch) setSteps(steps, branch)
    else setRecipe({ ...recipe, steps, groups: shiftOnInsert(groups, at) })
    setSel({ kind: 'step', i: at, branch })
    setAddAt(null)
    setRange(null)
  }
  const addStep = (op: string, at: number, branch?: string) => insertStep(at, newStep(op, colsBefore(at, branch), roles, recipe.base), branch)
  const moveStep = (i: number, d: number, branch?: string) => {
    const steps = [...stepsOf(branch)]
    const [s] = steps.splice(i, 1)
    steps.splice(i + d, 0, s)
    if (branch) setSteps(steps, branch)
    else setRecipe({ ...recipe, steps, groups: shiftOnInsert(shiftOnDelete(groups, i), i + d) })
    setSel({ kind: 'step', i: i + d, branch })
  }
  const deleteStep = (i: number, branch?: string) => {
    const steps = stepsOf(branch).filter((_, j) => j !== i)
    if (branch) setSteps(steps, branch)
    else setRecipe({ ...recipe, steps, groups: shiftOnDelete(groups, i) })
    setSel(i > 0 ? { kind: 'step', i: i - 1, branch } : { kind: 'input', role: branch ?? recipe.base })
    setRange(null)
  }

  // ---- grouping
  const clickStep = (i: number, branch: string | undefined, shift: boolean) => {
    if (shift && !branch && sel.kind === 'step' && !sel.branch && sel.i !== i) {
      const start = Math.min(sel.i, i)
      const end = Math.max(sel.i, i)
      if (groups.some((g) => !(g.end < start || g.start > end))) {
        toast('That range overlaps an existing group. Ungroup it first, or pick steps outside it.', true)
        return
      }
      setRange({ start, end })
      setGroupName('')
      return
    }
    setRange(null)
    setSel({ kind: 'step', i, branch })
  }
  const createGroup = () => {
    if (!range) return
    const id = `g${Date.now().toString(36)}`
    const name = groupName.trim() || `${range.end - range.start + 1} steps`
    setRecipe({ ...recipe, groups: [...groups, { id, name, start: range.start, end: range.end, kind: 'manual' as const }].sort((a, b) => a.start - b.start) })
    setRange(null)
    toggleGroup(id, false)
    setSel({ kind: 'group', id })
    toast(`Grouped as “${name}”. Double-click it to expand.`)
  }
  const updateGroup = (id: string, patch: Partial<StepGroup>) =>
    setRecipe({ ...recipe, groups: groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })
  const ungroup = (id: string) => {
    const g = groupById(id)
    setRecipe({ ...recipe, groups: groups.filter((x) => x.id !== id) })
    if (g) setSel({ kind: 'step', i: g.start })
  }

  // Selecting a step hidden inside a collapsed group opens the group.
  useEffect(() => {
    if (sel.kind !== 'step') return
    const g = sel.branch ? groups.find((x) => x.inputs?.includes(sel.branch!)) : groupOf(groups, sel.i)
    if (g && !expanded.has(g.id)) toggleGroup(g.id, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])
  const removeInput = (role: string) => {
    const rest = recipe.inputs.filter((i) => i.role !== role)
    const base = recipe.base === role ? rest[0].role : recipe.base
    setRecipe({ ...recipe, inputs: rest, base })
    setSel({ kind: 'input', role: base })
  }
  const renameRole = (old: string, raw: string, bindTo?: string) => {
    const role = raw.replace(/[^A-Za-z0-9_]/g, '_')
    const b = { ...bindings }
    if (bindTo) b[old] = bindTo
    if (!role || (role !== old && roles.includes(role))) { setBindings(b); return old }
    const swap = (v: unknown): unknown => (v === old ? role : Array.isArray(v) ? v.map(swap) : v)
    const steps = recipe.steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, ['right', 'inputs'].includes(k) ? swap(v) : v])) as Step)
    setRecipe({ ...recipe, inputs: recipe.inputs.map((i) => (i.role === old ? { ...i, role } : i)), base: recipe.base === old ? role : recipe.base, steps })
    if (b[old] && role !== old) { b[role] = b[old]; delete b[old] }
    setBindings(b)
    if (sel.kind === 'input' && sel.role === old) setSel({ kind: 'input', role })
    return role
  }

  /** Put a dataset into the workflow: fills `role` (or an empty start input), otherwise adds a new input. */
  const placeDataset = (s: Selection, role?: string) => {
    addKnownDataset(s)
    setAddData(null)
    const target = role ?? (bindings[recipe.base] ? undefined : recipe.base)
    if (target) {
      let r = target
      if (isDefaultRole(target)) r = renameRole(target, roleFrom(s.label, roles.filter((x) => x !== target)), s.id)
      else setBindings({ ...bindings, [target]: s.id })
      setSel({ kind: 'input', role: r })
    } else {
      const r = roleFrom(s.label, roles)
      const again = Object.values(bindings).map(bindingId).includes(s.id)
      setRecipe({ ...recipe, inputs: [...recipe.inputs, { role: r }] })
      setBindings({ ...bindings, [r]: s.id })
      setSel({ kind: 'input', role: r })
      toast(again
        ? `Added another copy of “${s.label}”. Give it its own steps with + on its row, then Join or Append it.`
        : `Added “${s.label}”. Use Join or Append to combine it.`)
    }
  }

  const dropFiles = async (files: File[]) => {
    setDropping(true)
    try {
      const r = await uploadFile<UploadResult>(files[0])
      if (!r.source || !['excel', 'csv'].includes(r.source.kind)) throw new Error('Drop an Excel (.xlsx/.xlsm) or CSV file.')
      setAddData({ presetSource: r.source })
    } catch (e) { toast((e as Error).message, true) } finally { setDropping(false) }
  }

  // Quick filter from a profile bar ("Keep only" / "Exclude"), inserted after the selected node.
  const quickFilter = (column: string, value: Cell, keep: boolean) => {
    const branch = viewRole ?? undefined
    const at = sel.kind === 'step' ? sel.i + 1 : sel.kind === 'output' ? recipe.steps.length : 0
    const operator = value === null ? (keep ? 'is_blank' : 'not_blank') : keep ? 'eq' : 'ne'
    insertStep(at, { op: 'filter_rows', match: 'all', conditions: [{ column, operator, value }] }, branch)
  }

  const withExpected = (): Recipe => ({
    ...recipe,
    inputs: recipe.inputs.map((i) => ({ ...i, expected_columns: (byId[bindings[i.role]]?.schema ?? i.expected_columns ?? []).map((c) => ({ name: c.name, type: c.type })) })),
  })

  const save = async (name: string, description: string, asNew: boolean) => {
    setSaving(true)
    try {
      const body = { name, description, definition: withExpected(), origin }
      const r = meta.id && !asNew ? await api.put<RecipeDetail>(`/api/recipes/${meta.id}`, body) : await api.post<RecipeDetail>('/api/recipes', body)
      setMeta({ id: r.id, name: r.name, description: r.description, version: r.version.version })
      setSaved(JSON.stringify({ r: recipe, n: r.name }))
      storeBindings(r.id, bindings)
      setSaveOpen(false)
      toast(`Saved “${r.name}” (version ${r.version.version})`)
      if (routeId !== r.id) nav(`/workflows/${r.id}`, { replace: true })
    } catch (e) { toast((e as Error).message, true) } finally { setSaving(false) }
  }
  const saveClick = () => {
    if (recipe.steps.length === 0) { toast('Add at least one step before saving', true); return }
    if (meta.id && meta.name.trim()) save(meta.name, meta.description, false)
    else setSaveOpen(true)
  }

  // Runs happen in the background; a dialog shows progress and then where the files were saved.
  const run = async () => {
    setRunning(true)
    try {
      if (meta.id) storeBindings(meta.id, bindings)
      const title = meta.name || recipe.output.name
      const r = await api.post<Run>('/api/transform/run', { recipe: withExpected(), bindings, recipe_id: meta.id, title, background: true })
      setRunDialog({ id: r.id, title })
    } catch (e) { toast((e as Error).message, true) } finally { setRunning(false) }
  }

  // ---- zoom: keeps the point under the pointer (or the canvas centre) in place
  const setZoom = (next: number, anchor?: { x: number; y: number }) => {
    const el = canvasRef.current
    setZoomState((cur) => {
      const z = clampZoom(next)
      if (el && z !== cur) {
        const ax = anchor?.x ?? el.clientWidth / 2
        const ay = anchor?.y ?? el.clientHeight / 2
        const left = ((el.scrollLeft + ax - pan.x) * z) / cur - ax + pan.x
        const top = ((el.scrollTop + ay - pan.y) * z) / cur - ay + pan.y
        requestAnimationFrame(() => el.scrollTo({ left, top }))
      }
      try { localStorage.setItem(ZOOM_KEY, String(z)) } catch { /* ignore */ }
      return z
    })
  }
  const zoomToFit = () => {
    const el = canvasRef.current
    const flow = el?.querySelector<HTMLElement>('.flow')
    if (!el || !flow) return
    const z = Math.min((el.clientWidth - 24) / flow.offsetWidth, (el.clientHeight - 12) / flow.offsetHeight, 1)
    setPan({ x: 0, y: 0 })
    setZoom(z)
    requestAnimationFrame(() => el.scrollTo({ left: 0, top: 0 }))
  }
  // ---- pan: drag empty canvas to move the whole flow (nodes, buttons and menus keep their clicks)
  const onPanDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('.flow-node, button, .flow-menu, input, select, textarea, a')) return
    panDrag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false }
  }
  const onPanMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = panDrag.current
    const el = canvasRef.current
    if (!d || d.id !== e.pointerId || !el) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return
      d.moved = true
      el.setPointerCapture(e.pointerId)
      el.classList.add('panning')
    }
    // Keep at least a strip of the flow on screen so it can't be lost off an edge.
    const flow = el.querySelector<HTMLElement>('.flow-zoom')
    const keep = 120
    const fw = flow?.offsetWidth ?? 0
    const fh = flow?.offsetHeight ?? 0
    setPan({
      x: Math.min(el.clientWidth - keep, Math.max(keep - fw, d.px + dx)),
      y: Math.min(el.clientHeight - keep / 2, Math.max(keep / 2 - fh, d.py + dy)),
    })
  }
  const onPanUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = panDrag.current
    if (!d || d.id !== e.pointerId) return
    panDrag.current = null
    canvasRef.current?.classList.remove('panning')
    if (canvasRef.current?.hasPointerCapture(e.pointerId)) canvasRef.current.releasePointerCapture(e.pointerId)
  }
  // Ctrl + mouse wheel (and trackpad pinch, which browsers report as Ctrl + wheel) zooms the canvas.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // ~15% per mouse-wheel notch; trackpad pinches send small deltas and stay smooth.
      setZoom(zoom * Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0012), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // ---- keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 's') { e.preventDefault(); saveClick() }
      else if (mod && e.key === 'Enter') { e.preventDefault(); if (allBound && !running && !preview?.error && recipe.output.formats.length) run() }
      else if (mod && k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if (mod && k === 'y' && !typing) { e.preventDefault(); redo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && sel.kind === 'step') { e.preventDefault(); deleteStep(sel.i, sel.branch) }
      else if (e.key === 'Escape') setAddAt(null)
      else if (!typing && !mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(zoom + 0.1) }
      else if (!typing && !mod && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1) }
      else if (!typing && !mod && e.key === '0') { e.preventDefault(); setZoom(1) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  // ---- draggable panel boundaries (double-click resets)
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
  }, [layout])
  const startDrag = (key: keyof Layout) => (e: React.MouseEvent) => {
    e.preventDefault()
    const horizontal = key === 'settingsW'
    const start = horizontal ? e.clientX : e.clientY
    const v0 = layout[key]
    const [min, max] = LIMITS[key]
    document.body.classList.add(horizontal ? 'resizing-x' : 'resizing-y')
    const move = (ev: MouseEvent) => {
      const v = v0 + (horizontal ? ev.clientX : ev.clientY) - start
      setLayout((l) => ({ ...l, [key]: Math.round(Math.max(min, Math.min(max(), v))) }))
    }
    const up = () => {
      document.body.classList.remove('resizing-x', 'resizing-y')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const resetSize = (key: keyof Layout) => () => setLayout((l) => ({ ...l, [key]: DEFAULT_LAYOUT[key] }))

  // ---- close the add-step menu on outside click, scroll or resize
  useEffect(() => {
    if (!addAt) return
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.flow-menu, .flow-add')) setAddAt(null) }
    const close = () => setAddAt(null)
    window.addEventListener('mousedown', down)
    window.addEventListener('resize', close)
    document.querySelector('.prep-canvas')?.addEventListener('scroll', close)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('resize', close)
      document.querySelector('.prep-canvas')?.removeEventListener('scroll', close)
    }
  }, [addAt])

  if (!allSelections || !loaded) return <Loading />

  const nodeTitle = sel.kind === 'output' ? `Result · ${recipe.output.name}` : sel.kind === 'input' ? `Input · ${sel.role}`
    : sel.kind === 'group' ? `Group · ${groupById(sel.id)?.name ?? ''} (its result)`
    : `${sel.branch ? `${sel.branch} · ` : ''}${sel.i + 1}. ${OP_LABEL[stepsOf(sel.branch)[sel.i]?.op] ?? ''}`
  // Until the first dataset is added the studio shows one focused "add your data" screen, nothing else.
  const empty = !anyBound
  const canRun = allBound && !running && !err && recipe.output.formats.length > 0
  const runBlocker = !allBound ? 'Connect every input to data first' : err ? 'Fix the highlighted step first'
    : recipe.output.formats.length === 0 ? 'Choose Excel and/or CSV on the Result node' : 'Running…'
  const nextHint = empty ? null : !allBound ? 'Connect the highlighted input to a dataset.'
    : recipe.steps.length === 0 ? 'Hover between the boxes above and click + to add your first step.' : null

  return (
    <div className="prep">
      {/* ---------- toolbar */}
      <div className="prep-toolbar">
        <Link to="/" className="btn ghost icon" title="All workflows">←</Link>
        <input className="title-input" value={meta.name} placeholder="Untitled workflow" aria-label="Workflow name"
          style={{ width: `${Math.min(48, Math.max(16, meta.name.length + 3))}ch` }}
          onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
        {meta.version && <span className="badge" title="Saved version">v{meta.version}</span>}
        {dirty ? <span className="badge warn" title="Press Ctrl+S to save">Unsaved</span> : meta.id ? <span className="badge ok">Saved</span> : null}
        <span className="spacer" />
        {!empty && <>
        {previewing && <Spinner />}
        <button className="ghost icon" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)">↶</button>
        <button className="ghost icon" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button onClick={() => setAiOpen(true)} disabled={!allBound} title="Describe the result and let your AI chatbot draft the steps">✨ AI Helper</button>
        </>}
      </div>
      {origin === 'ai' && !macroInfo && <div className="alert info prep-banner">These steps were drafted by an AI chatbot. Click each step to check it before running.</div>}
      {macroInfo && <MacroBanner info={macroInfo} onAddData={() => setAddData({})} />}
      {nextHint && !range && <div className="prep-hint">💡 {nextHint}</div>}
      {range && (
        <div className="prep-hint range-bar">
          <OpIcon op="group" size={16} />
          <b>{range.end - range.start + 1} steps selected</b>
          <input className="inline-input" style={{ width: 220 }} placeholder="Group name, e.g. Clean-up" value={groupName}
            onChange={(e) => setGroupName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createGroup() }} autoFocus />
          <button className="sm primary" onClick={createGroup}>Group</button>
          <button className="sm ghost" onClick={() => setRange(null)}>Cancel</button>
        </div>
      )}

      {/* ---------- flow canvas (Run sits in its top-right corner, outside the scrolling area) */}
      <div className={`prep-canvas-wrap${empty ? ' empty' : ''}`}>
      {!empty && (
        <button className="canvas-run" onClick={run} disabled={!canRun}
          title={canRun ? 'Run the workflow and create the files (Ctrl+Enter)' : runBlocker}>
          {running ? <Spinner /> : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
          )}
          <span className="canvas-run-label">{running ? 'Running…' : 'Run'}</span>
        </button>
      )}
      {!empty && (
        <div className="zoom-controls" role="group" aria-label="Zoom">
          <button className="ghost icon" onClick={() => setZoom(zoom - 0.1)} disabled={zoom <= ZOOM_MIN} title="Zoom out (−)">−</button>
          <button className="ghost zoom-level" onClick={() => setZoom(1)} title="Back to 100% (0)">{Math.round(zoom * 100)}%</button>
          <button className="ghost icon" onClick={() => setZoom(zoom + 0.1)} disabled={zoom >= ZOOM_MAX} title="Zoom in (+)">+</button>
          <span className="zoom-sep" />
          <button className="ghost zoom-fit" onClick={zoomToFit} title="Fit the whole workflow in view">Fit</button>
        </div>
      )}
      <div
        ref={canvasRef}
        className={`prep-canvas${dropping ? ' dropping' : ''}${empty ? ' empty' : ''}`}
        style={empty ? undefined : { height: layout.canvasH }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true) } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
        onDrop={(e) => { e.preventDefault(); setDropping(false); if (e.dataTransfer.files.length) dropFiles([...e.dataTransfer.files]) }}
        onClick={(e) => { if (e.target === e.currentTarget) setAddAt(null) }}
        onPointerDown={empty ? undefined : onPanDown} onPointerMove={onPanMove} onPointerUp={onPanUp} onPointerCancel={onPanUp}
      >
        {!anyBound ? (
          <div className="canvas-empty">
            <div className="row" style={{ justifyContent: 'center', gap: 8 }}><FileIcon kind="excel" size={44} /><FileIcon kind="csv" size={44} /></div>
            <h2 style={{ margin: '8px 0 0' }}>Start with your data</h2>
            <p className="muted" style={{ margin: 0 }}>Drop an Excel or CSV file anywhere here, or</p>
            <button className="primary" onClick={() => setAddData({ role: recipe.base })}>Choose data…</button>
            <Link to="/workflows/from-macro" className="small muted" style={{ marginTop: 12 }}>Already have an Excel macro that does this? Import it instead</Link>
          </div>
        ) : (
          <FlowCanvas recipe={recipe} bindings={bindings} byId={byId} preview={preview} sel={sel} setSel={setSel}
            addAt={addAt} setAddAt={setAddAt} onAdd={(op, a) => addStep(op, a.i, a.branch)}
            expanded={expanded} onToggleGroup={toggleGroup} range={range} onStepClick={clickStep} onConnect={(role) => setAddData({ role })} onAddData={() => setAddData({})}
            zoom={zoom} pan={pan} />
        )}
        {dropping && <div className="canvas-drop-overlay">Drop to add this file to the workflow</div>}
      </div>
      </div>

      {!empty && <>
      <div className="prep-splitter" onMouseDown={startDrag('canvasH')} onDoubleClick={resetSize('canvasH')} title="Drag to resize · double-click to reset" />

      {/* ---------- settings + profile */}
      <div className="prep-middle" style={{ height: layout.midH, gridTemplateColumns: `${layout.settingsW}px 6px minmax(0, 1fr)` }}>
        <div className="prep-settings">
          {sel.kind === 'input' && (() => {
            const inp = recipe.inputs.find((i) => i.role === sel.role)
            if (!inp) return null
            const s = byId[bindings[inp.role]]
            const p = preview?.inputs.find((x) => x.role === inp.role)
            return (
              <div className="stack">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  {s?.template
                    ? <span className="tpl-icon"><FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={30} /><span>📅</span></span>
                    : <FileIcon kind={s?.source_kind ?? 'excel'} ext={extOf(s?.source_name)} size={30} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h2 style={{ margin: 0 }}>{s ? s.label : 'Choose data for this input'} {s?.template && <span className="badge info" style={{ verticalAlign: 3 }}>data template</span>}</h2>
                    <div className="faint small ellipsis">{s ? `${s.template ? (p?.path?.split(/[\\/]/).pop() ?? s.source_name) : s.source_name} · ${s.config.sheet === '(csv)' ? 'CSV' : `sheet ${s.config.sheet}`} · headers on row ${s.config.header_row}${p ? ` · ${p.rows.toLocaleString()} rows` : ''}` : 'This workflow needs a table here.'}</div>
                  </div>
                </div>
                {s?.template && (
                  <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TemplateValuePicker template={s.template} value={bindingValue(bindings[inp.role])}
                        onChange={(v) => setBindings({ ...bindings, [inp.role]: v ? `${s.id}@${v}` : s.id })} />
                    </div>
                    <button className="ghost icon" title="Look for new files in the folder" onClick={() => reloadDatasets()} style={{ marginBottom: 2 }}>↻</button>
                  </div>
                )}
                <div className="row">
                  <button className={s ? '' : 'primary'} onClick={() => setAddData({ role: inp.role })}>{s ? 'Use different data…' : 'Choose data…'}</button>
                  {s && !s.template && <Link className="btn" to={`/sources/${s.source_id}`}>Open source</Link>}
                  {recipe.inputs.length > 1 && <button className="danger" onClick={() => removeInput(inp.role)}>Remove input</button>}
                </div>
                <Field label="Name in this workflow" help="Joins and appends refer to inputs by this name.">
                  <input className="mono" defaultValue={inp.role} key={inp.role} onBlur={(e) => e.target.value !== inp.role && renameRole(inp.role, e.target.value)} />
                </Field>
                {recipe.inputs.length > 1 && (
                  <label className="check small">
                    <input type="radio" checked={recipe.base === inp.role} onChange={() => setRecipe({ ...recipe, base: inp.role })} /> The main flow starts from this input
                  </label>
                )}
                {p && p.warnings.length > 0 && <div className="alert warn small"><ul>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {preview?.input_problems.filter((x) => x.includes(`'${inp.role}'`)).map((x) => <div key={x} className="alert warn small">{x}</div>)}
              </div>
            )
          })()}

          {sel.kind === 'step' && stepsOf(sel.branch)[sel.i] && (() => {
            const branch = sel.branch
            const steps = stepsOf(branch)
            const s = steps[sel.i]
            const rep = reportOf(sel.i, branch)
            const i = sel.i
            const update = (ns: Step) => setSteps(steps.map((x, j) => (j === i ? ns : x)), branch)
            return (
              <div className="stack">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span className="op-dot" style={{ background: OP_COLOR[s.op] }}><OpIcon op={s.op} size={16} color="#fff" /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ margin: 0 }}>{OP_LABEL[s.op]}</h2>
                    <div className="faint small">{branch && <><b>On “{branch}” only</b> · </>}{OP_HELP[s.op]}{rep ? ` · ${rep.rows_in.toLocaleString()} → ${rep.rows_out.toLocaleString()} rows` : ''}</div>
                  </div>
                  <button className="ghost icon" disabled={i === 0} onClick={() => moveStep(i, -1, branch)} title="Move earlier">←</button>
                  <button className="ghost icon" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1, branch)} title="Move later">→</button>
                  <button className="ghost icon" onClick={() => deleteStep(i, branch)} title="Delete step (Del)">🗑</button>
                </div>
                {typeof s.note === 'string' && s.note.startsWith('From macro') && <div className="alert info small">📜 {s.note}</div>}
                {isErrAt(i, branch) && <div className="alert bad small">{err!.message}</div>}
                {!branch && groupOf(groups, i) && (
                  <div className="faint small">In group <a href="#" onClick={(e) => { e.preventDefault(); setSel({ kind: 'group', id: groupOf(groups, i)!.id }) }}>{groupOf(groups, i)!.name}</a></div>
                )}
                <StepEditor step={s} cols={colsBefore(i, branch)} roleCols={roleCols} roles={roles} base={recipe.base} onChange={update} />
                {(s.op === 'join' || s.op === 'append_rows') && roles.length < 2 && (
                  <div className="alert info small">This step needs a second table. <a href="#" onClick={(e) => { e.preventDefault(); setAddData({}) }}>Add data</a></div>
                )}
                {rep && rep.warnings.length > 0 && <div className="alert warn small"><ul>{rep.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {rep && Object.keys(rep.details).length > 0 && (
                  <div className="faint small">{Object.entries(rep.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>
                )}
                {!(typeof s.note === 'string' && s.note.startsWith('From macro')) && (
                  <Field label="Note (optional)">
                    <input value={String(s.note ?? '')} onChange={(e) => update({ ...s, note: e.target.value || undefined })} placeholder="Why this step exists" />
                  </Field>
                )}
              </div>
            )
          })()}

          {sel.kind === 'group' && groupById(sel.id) && (() => {
            const g = groupById(sel.id)!
            const open = expanded.has(g.id)
            const last = preview?.steps[g.end]
            return (
              <div className="stack">
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span className="op-dot" style={{ background: OP_COLOR.group }}><OpIcon op="group" size={16} color="#fff" /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h2 style={{ margin: 0 }}>{g.kind === 'macro' ? '📜 ' : ''}{g.name}</h2>
                    <div className="faint small">{g.kind === 'macro' ? 'Translated Excel macro' : 'Step group'} · {g.end - g.start + 1} steps{last ? ` · ${preview!.steps[g.start]?.rows_in.toLocaleString()} → ${last.rows_out.toLocaleString()} rows` : ''}</div>
                  </div>
                </div>
                <Field label="Name"><input value={g.name} onChange={(e) => updateGroup(g.id, { name: e.target.value || g.name })} /></Field>
                <div>
                  <span className="label small" style={{ fontWeight: 600 }}>Steps inside</span>
                  <div className="group-steps">
                    {recipe.steps.slice(g.start, g.end + 1).map((st, k) => {
                      const i = g.start + k
                      return (
                        <button key={i} className={`ghost${isErrAt(i) ? ' bad-row' : ''}`} onClick={() => setSel({ kind: 'step', i })}>
                          <span className="op-dot sm" style={{ background: OP_COLOR[st.op] }}><OpIcon op={st.op} size={12} color="#fff" /></span>
                          <span className="ellipsis" style={{ flex: 1, textAlign: 'left' }}><b>{OP_LABEL[st.op]}</b> <span className="faint small">{stepSummary(st)}</span></span>
                          {preview?.steps[i] && <span className="faint small nowrap">{preview.steps[i].rows_out.toLocaleString()} rows</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                {g.inputs && g.inputs.length > 0 && <div className="faint small">Also includes the own steps of: {g.inputs.join(', ')}</div>}
                {g.source?.macro_name && <div className="faint small">From macro <b>{g.source.macro_name}</b>{g.source.modules ? ` (${g.source.modules})` : ''}</div>}
                <div className="row">
                  <button onClick={() => toggleGroup(g.id)}>{open ? '▸ Collapse' : '▾ Expand'}</button>
                  <button onClick={() => ungroup(g.id)} title="Keep the steps, remove the grouping">Ungroup</button>
                </div>
              </div>
            )
          })()}

          {sel.kind === 'output' && (
            <div className="stack">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="op-dot" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={16} color="#fff" /></span>
                <div>
                  <h2 style={{ margin: 0 }}>Result</h2>
                  <div className="faint small">{preview?.data ? `${preview.data.row_count.toLocaleString()} rows · ${preview.data.columns.length} columns` : 'The final table this workflow produces'}</div>
                </div>
              </div>
              <OutputSettings output={recipe.output} onChange={(output) => setRecipe({ ...recipe, output })} />
              {preview?.warnings && preview.warnings.length > 0 && (
                <details className="alert warn small"><summary style={{ cursor: 'pointer' }}>{preview.warnings.length} thing(s) to check</summary><ul>{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>
              )}
              <button className="primary" onClick={run} disabled={!allBound || running || !!err || recipe.output.formats.length === 0}>{running ? 'Running…' : '▶ Run and create files'}</button>
            </div>
          )}
        </div>

        <div className="prep-vsplit" onMouseDown={startDrag('settingsW')} onDoubleClick={resetSize('settingsW')} title="Drag to resize · double-click to reset" />
        <ProfilePane profile={preview?.data?.profile} loading={!preview && allBound && !previewError} canFilter={!viewRole} onFilter={quickFilter} />
      </div>

      {/* ---------- data grid */}
      <div className="prep-splitter" onMouseDown={startDrag('midH')} onDoubleClick={resetSize('midH')} title="Drag to resize · double-click to reset" />
      <div className="prep-grid">
        <div className="prep-grid-head">
          <b>{nodeTitle}</b>
          {preview?.data && <span className="muted small">{preview.data.row_count.toLocaleString()} rows · {preview.data.columns.length} columns{preview.data.row_count > preview.data.rows.length ? ` · showing first ${preview.data.rows.length}` : ''}</span>}
          <span className="spacer" />
          <span className="faint small kbd-hints">Ctrl+Enter run · Ctrl+Z undo · Ctrl+S save · Del removes a step · +/− zoom</span>
        </div>
        <ErrorBox error={previewError} />
        {err && !(sel.kind === 'step' && isErrAt(sel.i, sel.branch)) && (
          <div className="alert bad small" style={{ margin: 8 }}><b>{err.step !== null ? `${err.branch ? `“${err.branch}” step` : 'Step'} ${err.step + 1}` : 'Workflow'}:</b> {err.message}{err.step !== null && <> · <a href="#" onClick={(e) => { e.preventDefault(); setSel({ kind: 'step', i: err.step!, branch: err.branch ?? undefined }) }}>go to step</a></>}</div>
        )}
        {!allBound ? <div className="empty small">Your data will appear here.</div>
          : preview?.data ? <DataTable columns={preview.data.columns} rows={preview.data.rows} types={Object.fromEntries(preview.data.schema.map((c) => [c.name, c.type]))} maxHeight={10000} />
            : <Loading />}
        <div className="prep-grid-foot">
          <button className={dirty || !meta.id ? 'primary' : ''} onClick={saveClick} disabled={saving} title="Save (Ctrl+S)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" /><path d="M8 3v5h7V3M8 21v-7h8v7" />
            </svg>
            {saving ? 'Saving…' : 'Save Workflow'}
          </button>
          <span className="faint small">
            {dirty ? 'You have unsaved changes' : meta.id ? `Saved${meta.version ? ` · version ${meta.version}` : ''}` : 'Not saved yet'}
          </span>
        </div>
      </div>

      </>}

      {runDialog && (
        <RunDialog runId={runDialog.id} title={runDialog.title} onClose={() => setRunDialog(null)}
          onGoToStep={(i, branch) => { setRunDialog(null); setSel({ kind: 'step', i, branch }) }} />
      )}
      {saveOpen && <SaveModal meta={meta} saving={saving} onClose={() => setSaveOpen(false)} onSave={save} />}
      {aiOpen && <AIDraftModal bindings={bindings} roles={roles} onClose={() => setAiOpen(false)} />}
      {addData && (
        <AddDataModal
          title={addData.role && !bindings[addData.role] ? 'Choose data' : addData.role ? `Replace data for “${addData.role}”` : 'Add data to this workflow'}
          presetSource={addData.presetSource}
          onClose={() => setAddData(null)}
          onPick={(s) => placeDataset(s, addData.role)}
        />
      )}
    </div>
  )
}

function MacroBanner({ info, onAddData }: { info: MacroInfo; onAddData: () => void }) {
  return (
    <details className="alert info prep-banner" open={info.missing_data.length > 0}>
      <summary style={{ cursor: 'pointer' }}>
        <b>Translated from an Excel macro.</b> Click each step to see which macro lines it comes from.
        {info.not_translated.length > 0 && <> · {info.not_translated.length} part(s) not translated</>}
        {info.missing_data.length > 0 && <> · <span style={{ color: 'var(--bad)' }}>{info.missing_data.length} dataset(s) missing</span></>}
      </summary>
      {info.missing_data.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <b className="small">The AI says the macro also needs:</b>
          <ul className="small">{info.missing_data.map((m, i) => <li key={i}><b>{m.reference}</b> — {m.why_needed}</li>)}</ul>
          <button className="sm" onClick={onAddData}>Add data…</button>
        </div>
      )}
      {info.not_translated.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <b className="small">Not translated (review whether you still need these):</b>
          <ul className="small">{info.not_translated.map((m, i) => <li key={i}><span className="mono">{m.macro_lines}</span> — {m.what_it_does}{m.why ? ` (${m.why})` : ''}</li>)}</ul>
        </div>
      )}
    </details>
  )
}

// ======================================================================== flow canvas

function FlowCanvas({ recipe, bindings, byId, preview, sel, setSel, addAt, setAddAt, onAdd, onConnect, onAddData,
  expanded, onToggleGroup, range, onStepClick, zoom, pan }: {
  recipe: Recipe; bindings: Record<string, string>; byId: Record<string, Selection>; preview: Preview | null
  sel: Sel; setSel: (s: Sel) => void; addAt: AddAt; setAddAt: (a: AddAt) => void
  onAdd: (op: string, at: NonNullable<AddAt>) => void; onConnect: (role: string) => void; onAddData: () => void
  expanded: Set<string>; onToggleGroup: (id: string, open?: boolean) => void
  range: { start: number; end: number } | null; onStepClick: (i: number, branch: string | undefined, shift: boolean) => void
  zoom: number; pan: { x: number; y: number }
}) {
  const n = recipe.steps.length
  const pos = (col: number, lane: number) => ({ x: PAD_X + col * COL_W, y: PAD_Y + lane * LANE_H })
  const err = preview?.error
  const groups = recipe.groups ?? []
  // Main flow as drawn: a collapsed group is one item. colOf maps each step to its column.
  const { items, colOf } = layoutMain(n, groups, expanded)
  const resultCol = items.length + 1
  // Inputs whose own steps belong to a collapsed group feed straight into the group node.
  const folded = new Set(groups.filter((g) => !expanded.has(g.id)).flatMap((g) => g.inputs ?? []))

  // Each extra input gets its own row: input → its own steps → into the main step that uses it.
  const secondary = recipe.inputs.filter((i) => i.role !== recipe.base)
  const rows = secondary.map((inp, k) => {
    const steps = folded.has(inp.role) ? [] : inp.steps ?? []
    const target = recipe.steps.findIndex((s) => stepRefs(s).includes(inp.role))
    const tcol = target >= 0 ? colOf[target] : -1
    const start = tcol >= 0 ? Math.max(0, tcol - 1 - steps.length) : 0
    return { role: inp.role, steps, lane: k + 1, start, tcol, hiddenSteps: folded.has(inp.role) ? (inp.steps ?? []).length : 0 }
  })
  const rowEnd = (r: (typeof rows)[number]) => r.start + r.steps.length
  // "Add data" ghost: bottom-right, after anything already on the first lower row.
  const ghostCol = Math.max(resultCol, ...rows.filter((r) => r.lane === 1).map((r) => rowEnd(r) + 1))
  const lanes = Math.max(2, 1 + secondary.length)
  const maxCol = Math.max(ghostCol, resultCol, ...rows.map(rowEnd))
  // Extra room on the right and bottom so the floating Run button and zoom controls never cover a node.
  const width = Math.max(PAD_X * 2 + maxCol * COL_W + 70, 600)
  const height = PAD_Y + lanes * LANE_H + 30

  const edges: ReactNode[] = []
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }, key: string) => {
    const mx = (a.x + b.x) / 2
    edges.push(<path key={key} d={`M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`} className="flow-edge" />)
  }
  for (let c = 0; c <= items.length; c++) curve(pos(c, 0), pos(c + 1, 0), `m${c}`)
  for (const r of rows) {
    for (let c = r.start; c < rowEnd(r); c++) curve(pos(c, r.lane), pos(c + 1, r.lane), `b${r.role}${c}`)
    if (r.tcol >= 0) curve(pos(rowEnd(r), r.lane), pos(r.tcol, 0), `s${r.role}`)
  }

  const isSel = (s: Sel) => JSON.stringify(s) === JSON.stringify(sel)
  const inputNode = (role: string, col: number, lane: number, unused: boolean) => {
    const s = byId[bindings[role]]
    const p = preview?.inputs.find((x) => x.role === role)
    const { x, y } = pos(col, lane)
    return (
      <div key={`in-${role}`} className={`flow-node input${isSel({ kind: 'input', role }) ? ' selected' : ''}${s ? '' : ' unbound'}`} style={{ left: x, top: y }}
        onClick={() => { setSel({ kind: 'input', role }); if (!s) onConnect(role) }} title={s ? `${s.label}\n${s.source_name}` : 'Click to choose data'}>
        <div className="flow-shape">
          {s ? <FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={26} /> : <span style={{ fontSize: 20, color: 'var(--accent)' }}>+</span>}
          {s?.template && <span className="flow-flag tpl" title="Data template">📅</span>}
        </div>
        <div className="flow-label">
          <div className="ellipsis"><b>{lane > 0 ? role : s?.label ?? role}</b></div>
          {s?.template && <div className="ellipsis tpl-period">{periodLabel(s, bindings[role], p?.template_value)}</div>}
          <div className="faint ellipsis">{p ? `${p.rows.toLocaleString()} rows${unused ? ' · not used yet' : ''}` : s ? s.source_name : 'choose data'}</div>
        </div>
      </div>
    )
  }
  const stepNode = (s: Step, i: number, col: number, lane: number, branch?: string) => {
    const { x, y } = pos(col, lane)
    const rep = branch ? preview?.branches?.[branch]?.[i] : preview?.steps[i]
    const bad = !!err && err.step === i && (err.branch ?? undefined) === branch
    const me: Sel = { kind: 'step', i, branch }
    return (
      <div key={`${branch ?? 'main'}-${i}`} className={`flow-node step${branch ? ' branch' : ''}${isSel(me) ? ' selected' : ''}${bad ? ' errored' : ''}${!branch && range && range.start <= i && i <= range.end ? ' in-range' : ''}`} style={{ left: x, top: y }}
        onClick={(e) => onStepClick(i, branch, e.shiftKey)} title={`${branch ? `On “${branch}” only: ` : ''}${stepSummary(s)}${s.note ? `\n${s.note}` : ''}${branch ? '' : '\nShift+click another step to select a range to group'}`}>
        <div className="flow-shape" style={{ background: OP_COLOR[s.op] }}>
          <OpIcon op={s.op} size={branch ? 17 : 20} color="#fff" />
          {bad && <span className="flow-flag bad">!</span>}
          {!bad && rep && rep.warnings.length > 0 && <span className="flow-flag warn">{rep.warnings.length}</span>}
          {typeof s.note === 'string' && s.note.startsWith('From macro') && <span className="flow-flag macro" title={s.note}>📜</span>}
        </div>
        <div className="flow-label">
          <div className="ellipsis"><b>{OP_LABEL[s.op]}</b></div>
          <div className="faint ellipsis">{rep ? `${rep.rows_out.toLocaleString()} rows` : bad ? 'needs attention' : stepSummary(s)}</div>
        </div>
      </div>
    )
  }
  const groupNode = (g: StepGroup, col: number) => {
    const { x, y } = pos(col, 0)
    const last = preview?.steps[g.end]
    const memberBranches = (g.inputs ?? []).flatMap((r) => preview?.branches?.[r] ?? [])
    const warns = [...(preview?.steps.slice(g.start, g.end + 1) ?? []), ...memberBranches].reduce((t, r) => t + (r?.warnings.length ?? 0), 0)
    const bad = !!err && err.step !== null && (err.branch ? !!g.inputs?.includes(err.branch) : err.step >= g.start && err.step <= g.end)
    return (
      <div key={`grp-${g.id}`} className={`flow-node step group${isSel({ kind: 'group', id: g.id }) ? ' selected' : ''}${bad ? ' errored' : ''}`} style={{ left: x, top: y }}
        onClick={() => setSel({ kind: 'group', id: g.id })} onDoubleClick={() => onToggleGroup(g.id, true)}
        title={`${g.name} — ${g.end - g.start + 1} steps. Double-click to expand.`}>
        <div className="flow-shape" style={{ background: OP_COLOR.group }}>
          <OpIcon op="group" size={21} color="#fff" />
          {g.kind === 'macro' && <span className="flow-flag macro" title="Translated Excel macro">📜</span>}
          {bad && <span className="flow-flag bad">!</span>}
          {!bad && warns > 0 && <span className="flow-flag warn">{warns}</span>}
          <button className="group-toggle" title="Expand to see the steps inside" aria-label="Expand group" onClick={(e) => { e.stopPropagation(); onToggleGroup(g.id, true) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        <div className="flow-label">
          <div className="ellipsis"><b>{g.name}</b></div>
          <div className="faint ellipsis">{g.end - g.start + 1} steps{last ? ` · ${last.rows_out.toLocaleString()} rows` : bad ? ' · needs attention' : ''}</div>
        </div>
      </div>
    )
  }
  // Expanded groups: a labelled container drawn behind their steps.
  const groupBox = (g: StepGroup) => {
    const c0 = colOf[g.start]
    const c1 = colOf[g.end]
    return (
      <div key={`box-${g.id}`} className={`flow-group-box${g.kind === 'macro' ? ' macro' : ''}${isSel({ kind: 'group', id: g.id }) ? ' selected' : ''}`}
        style={{ left: pos(c0, 0).x - COL_W * 0.44, width: (c1 - c0) * COL_W + COL_W * 0.88, top: 14, height: PAD_Y + 50 }}>
        <div className="flow-group-head">
          <button className="ghost" onClick={() => setSel({ kind: 'group', id: g.id })} title="Select the group">
            {g.kind === 'macro' ? '📜' : <OpIcon op="group" size={12} />} <b>{g.name}</b>
          </button>
          <button className="ghost" onClick={() => onToggleGroup(g.id, false)} title="Collapse into one node">▸ collapse</button>
        </div>
      </div>
    )
  }

  const plus = (key: string, x: number, y: number, at: { i: number; branch?: string }, pulse = false) => (
    <button key={key} className={`flow-add${addAt && addAt.i === at.i && addAt.branch === at.branch ? ' open' : ''}${pulse ? ' pulse' : ''}`}
      style={{ left: x, top: y }} disabled={!bindings[at.branch ?? recipe.base]}
      title={at.branch ? `Add a step to “${at.branch}” only` : 'Add a step here'}
      onClick={(e) => {
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        const same = addAt && addAt.i === at.i && addAt.branch === at.branch
        setAddAt(same ? null : { ...at, left: r.left, top: r.top, bottom: r.bottom })
      }}>+</button>
  )

  return (
    // The flow is laid out at 100% and scaled; the outer box reserves the scaled size so scrolling stays right.
    <div className="flow-zoom" style={{ width: width * zoom, height: height * zoom, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
    <div className="flow" style={{ width, height, transform: `scale(${zoom})` }}>
      <svg className="flow-edges" width={width} height={height}>{edges}</svg>
      {groups.filter((g) => expanded.has(g.id) && colOf[g.start] !== undefined).map(groupBox)}
      {inputNode(recipe.base, 0, 0, false)}
      {items.map((it, k) => (it.kind === 'step' ? stepNode(recipe.steps[it.i], it.i, k + 1, 0) : groupNode(it.g, k + 1)))}
      {(() => {
        const { x, y } = pos(resultCol, 0)
        return (
          <div className={`flow-node step output${isSel({ kind: 'output' }) ? ' selected' : ''}`} style={{ left: x, top: y }} onClick={() => setSel({ kind: 'output' })}>
            <div className="flow-shape" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={20} color="#fff" /></div>
            <div className="flow-label"><div className="ellipsis"><b>Result</b></div><div className="faint ellipsis">{recipe.output.formats.join(' + ') || 'no format'}</div></div>
          </div>
        )
      })()}
      {Array.from({ length: items.length + 1 }, (_, k) => {
        const next = items[k]
        const at = !next ? n : next.kind === 'step' ? next.i : next.g.start
        return plus(`add${k}`, pos(k, 0).x + COL_W / 2, pos(k, 0).y, { i: at }, n === 0)
      })}

      {rows.map((r) => (
        <span key={r.role} style={{ display: 'contents' }}>
          {inputNode(r.role, r.start, r.lane, r.tcol < 0)}
          {r.steps.map((s, j) => stepNode(s, j, r.start + 1 + j, r.lane, r.role))}
          {!r.hiddenSteps && Array.from({ length: r.steps.length + 1 }, (_, j) => {
            const a = pos(r.start + j, r.lane)
            // The last "+" sits just after the row's last node, before it joins the main flow.
            return plus(`add-${r.role}-${j}`, a.x + COL_W / 2, a.y, { i: j, branch: r.role })
          })}
        </span>
      ))}

      {(() => {
        const { x, y } = pos(ghostCol, 1)
        return (
          <div className="flow-node input ghost" style={{ left: x, top: y }} onClick={onAddData} title="Add a table — or the same one again — to this workflow"
            role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onAddData() }}>
            <div className="flow-shape"><span className="ghost-plus">+</span></div>
            <div className="flow-label"><div className="ellipsis"><b>Add data</b></div><div className="faint ellipsis">Excel or CSV</div></div>
          </div>
        )
      })()}
      {addAt && <StepMenu at={addAt} onPick={(op) => onAdd(op, addAt)} />}
    </div>
    </div>
  )
}

/** The add-step menu floats above every panel, opening downward or upward to stay on screen. */
function StepMenu({ at, onPick }: { at: NonNullable<AddAt>; onPick: (op: string) => void }) {
  const W = 300
  const below = window.innerHeight - at.bottom - 12
  const above = at.top - 12
  const up = below < 360 && above > below
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(at.left - 12, window.innerWidth - W - 8)),
    ...(up ? { bottom: window.innerHeight - at.top + 6, maxHeight: above } : { top: at.bottom + 6, maxHeight: below }),
  }
  // An input's own row prepares that table; combining happens in the main flow.
  const groups = at.branch ? CATALOG.filter((g) => g.group !== 'Combine') : CATALOG
  return createPortal(
    <div className="flow-menu floating" style={style} role="menu">
      {at.branch && <div className="flow-menu-note">Steps here change <b>{at.branch}</b> only, before it is combined.</div>}
      {groups.map((g) => (
        <div key={g.group}>
          <div className="flow-menu-group">{g.group}</div>
          {g.ops.map((op) => (
            <button key={op} className="ghost" role="menuitem" onClick={() => onPick(op)}>
              <span className="op-dot sm" style={{ background: OP_COLOR[op] }}><OpIcon op={op} size={13} color="#fff" /></span>
              <span style={{ textAlign: 'left' }}><b>{OP_LABEL[op]}</b><br /><span className="faint small">{OP_HELP[op]}</span></span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}
