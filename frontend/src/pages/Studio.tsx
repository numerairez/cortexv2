import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, uploadFile } from '../api'
import { AddDataModal, type UploadResult } from '../components/AddData'
import { DATASET_MIME, FILE_PREFIX, LibraryPanel } from '../components/LibraryPanel'
import { DataTable } from '../components/DataTable'
import { FileIcon, OP_COLOR, OpIcon } from '../components/Icons'
import { OutputSettings } from '../components/OutputSettings'
import { ProfilePane, type ColumnProfile } from '../components/ProfilePane'
import { RunDialog } from '../components/RunDialog'
import { OP_LABEL, StepEditor, newStep, stepSummary } from '../components/StepEditor'
import { AIDraftModal, LeaveModal, SaveModal } from '../components/StudioModals'
import { TemplateValuePicker } from '../components/Templates'
import { ErrorBox, Field, Loading, Spinner, useToast } from '../components/ui'
import { bindingId, bindingValue, useDatasets, useUnpreparedFiles } from '../datasets'
import { groupOf, layoutMain, shiftOnDelete, shiftOnInsert } from '../groups'
import type { Cell, Collection, ColumnSchema, ColumnValues, ExtraOutput, Recipe, RecipeDetail, Run, Selection, Source, Step, StepGroup, TransformPreview } from '../types'

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

/** A step on the main flow (no branch) or on an input's own row. */
type StepRef = { i: number; branch?: string }

/** Pseudo-operation in the add menu: take the table at that point as an extra output. */
const OUTPUT_OP = '__output'

const COL_W = 150
const LANE_H = 112
// Nodes are 124px wide and centred on their x, so this must exceed 62 or the first label clips.
const PAD_X = 74
const PAD_Y = 46

/** A selected node. Steps with `branch` belong to that input's own row (prepared before the main flow). */
type Sel = { kind: 'input'; role: string } | { kind: 'step'; i: number; branch?: string } | { kind: 'group'; id: string }
  | { kind: 'output'; id?: string }   // no id: the main Result; otherwise an extra output
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
interface MacroInfo { language: 'vba' | 'python' | 'doc'; not_translated: { macro_lines: string; what_it_does: string; why: string }[]; missing_data: { reference: string; why_needed: string }[] }
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

/** The recipe with input `old` renamed to `role`, including the joins/appends and outputs that refer to it. */
function withRoleRenamed(recipe: Recipe, old: string, role: string): Recipe {
  const swap = (v: unknown): unknown => (v === old ? role : Array.isArray(v) ? v.map(swap) : v)
  const fix = (steps: Step[]) => steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, ['right', 'inputs'].includes(k) ? swap(v) : v])) as Step)
  return {
    ...recipe,
    inputs: recipe.inputs.map((i) => ({ ...i, role: i.role === old ? role : i.role, ...(i.steps ? { steps: fix(i.steps) } : {}) })),
    base: recipe.base === old ? role : recipe.base,
    steps: fix(recipe.steps),
    extra_outputs: recipe.extra_outputs?.map((o) => (o.branch === old ? { ...o, branch: role } : o)),
  }
}

/** Keep extra outputs on the same step when steps of `branch` (undefined = main flow) are inserted, moved or deleted. */
function withOutputsMoved(recipe: Recipe, branch: string | undefined, move: (after: number) => number): Recipe {
  if (!recipe.extra_outputs?.length) return recipe
  return { ...recipe, extra_outputs: recipe.extra_outputs.map((o) => ((o.branch ?? undefined) === branch ? { ...o, after: move(o.after) } : o)) }
}

/** A short name for an output, as the backend names its Library dataset. */
const outputLabel = (name: string) => name.replace(/\{(date|time)\}/g, '').trim().replace(/^[-_ ]+|[-_ ]+$/g, '') || name

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
  const newFiles = useUnpreparedFiles()
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
  const [addData, setAddData] = useState<{ role?: string; presetSource?: Source; tab?: 'file'; step?: StepRef } | null>(null)
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
  // What is being dragged over the canvas: files from the PC, or a table from the library.
  const [dragKind, setDragKind] = useState<'file' | 'dataset'>('file')
  // The Join/Append box a library table is being dragged over, highlighted as the drop target.
  const [dropStep, setDropStep] = useState<string | null>(null)
  // Bumped to open and highlight the library when the user asks to choose data.
  const [libraryNudge, setLibraryNudge] = useState(0)
  const nudgeLibrary = () => setLibraryNudge((n) => n + 1)
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
        // A run of a saved workflow reopens that workflow, not an unsaved copy of it.
        if (run.recipe_id && run.service_id === 'transformation') { nav(`/workflows/${run.recipe_id}`, { replace: true }); return }
        const r = (run.state.recipe ?? run.config.recipe) as Recipe | undefined
        if (r) resetRecipe({ ...emptyRecipe(), ...r })
        setBindings((run.config.bindings as Record<string, string>) ?? {})
        if (run.service_id !== 'transformation') setOrigin('ai')
        if (run.service_id in SOURCE_TEXT) {
          const language = SOURCE_TEXT[run.service_id]
          setMacroInfo({ language, not_translated: (run.state.not_translated as MacroInfo['not_translated']) ?? [], missing_data: (run.state.missing_data as MacroInfo['missing_data']) ?? [] })
          setMeta((m) => ({ ...m, name: `${String((run.config.options as Record<string, unknown>)?.macro_name || SOURCE_LABEL[language].Noun)} (workflow)` }))
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
  }, [allSelections, routeId])

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
  const selOut = sel.kind === 'output' && sel.id ? recipe.extra_outputs?.find((o) => o.id === sel.id) : undefined
  const upto = selOut ? selOut.after : sel.kind === 'step' ? sel.i : sel.kind === 'group' ? groupById(sel.id)?.end ?? null
    : sel.kind === 'input' && sel.role === recipe.base ? -1 : null
  const viewRole = selOut ? (selOut.branch && selOut.branch !== recipe.base ? selOut.branch : null)
    : sel.kind === 'step' && sel.branch ? sel.branch : sel.kind === 'input' && sel.role !== recipe.base ? sel.role : null
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

  // ---- before leaving: offer to save a workflow that has data in it but isn't saved (or has changes)
  const needsSave = dirty || (!meta.id && recipe.inputs.some((i) => bindings[i.role]))
  const leaving = useRef(false)   // set for the studio's own navigation (e.g. to the saved workflow's URL)
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    needsSave && !leaving.current && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (!needsSave) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [needsSave])

  // ---- editing helpers (branch = an input's own row; undefined = main flow)
  const withSteps = (steps: Step[], branch?: string): Recipe => (branch
    ? { ...recipe, inputs: recipe.inputs.map((i) => (i.role === branch ? { ...i, steps } : i)) }
    : { ...recipe, steps })
  const setSteps = (steps: Step[], branch?: string) => setRecipe(withSteps(steps, branch))
  const insertStep = (at: number, s: Step, branch?: string) => {
    const steps = [...stepsOf(branch)]
    steps.splice(at, 0, s)
    const next = branch ? withSteps(steps, branch) : { ...recipe, steps, groups: shiftOnInsert(groups, at) }
    setRecipe(withOutputsMoved(next, branch, (a) => (a >= at ? a + 1 : a)))
    setSel({ kind: 'step', i: at, branch })
    setAddAt(null)
    setRange(null)
  }
  // Inputs a step can join or append: on an input's own row, never itself or an input that already uses it (a loop).
  const refsOf = (role: string) => (recipe.inputs.find((i) => i.role === role)?.steps ?? []).flatMap(stepRefs)
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    from === to || (!seen.has(from) && (seen.add(from), refsOf(from).some((r) => reaches(r, to, seen))))
  const combinable = (branch?: string) => (branch ? roles.filter((r) => r !== branch && !reaches(r, branch)) : roles.filter((r) => r !== recipe.base))
  const addStep = (op: string, at: number, branch?: string) =>
    insertStep(at, newStep(op, colsBefore(at, branch), [branch ?? recipe.base, ...combinable(branch)], branch ?? recipe.base), branch)
  const moveStep = (i: number, d: number, branch?: string) => {
    const steps = [...stepsOf(branch)]
    const [s] = steps.splice(i, 1)
    steps.splice(i + d, 0, s)
    const next = branch ? withSteps(steps, branch) : { ...recipe, steps, groups: shiftOnInsert(shiftOnDelete(groups, i), i + d) }
    setRecipe(withOutputsMoved(next, branch, (a) => (a === i ? i + d : a === i + d ? i : a)))
    setSel({ kind: 'step', i: i + d, branch })
  }
  const deleteStep = (i: number, branch?: string) => {
    const steps = stepsOf(branch).filter((_, j) => j !== i)
    const next = branch ? withSteps(steps, branch) : { ...recipe, steps, groups: shiftOnDelete(groups, i) }
    // An output on the deleted step moves to the step before it.
    setRecipe(withOutputsMoved(next, branch, (a) => (a >= i ? a - 1 : a)))
    setSel(i > 0 ? { kind: 'step', i: i - 1, branch } : { kind: 'input', role: branch ?? recipe.base })
    setRange(null)
  }

  // ---- extra outputs: results taken part-way through the flow
  const extraOutputs: ExtraOutput[] = recipe.extra_outputs ?? []
  const addOutput = (branch: string | undefined, after: number) => {
    const step = after >= 0 ? stepsOf(branch)[after] : undefined
    const stem = step ? `${branch ? `${branch} ` : ''}after ${OP_LABEL[step.op]?.toLowerCase() ?? 'step'}` : branch ?? recipe.base
    const taken = [recipe.output.name, ...extraOutputs.map((o) => o.name)].map((n) => n.toLowerCase())
    let name = stem
    for (let n = 2; taken.includes(name.toLowerCase()); n++) name = `${stem} ${n}`
    const o: ExtraOutput = { id: `o${Date.now().toString(36)}`, name, formats: ['xlsx'], save_to_library: true, branch: branch ?? null, after }
    setRecipe({ ...recipe, extra_outputs: [...extraOutputs, o] })
    setSel({ kind: 'output', id: o.id })
    setAddAt(null)
  }
  const updateOutput = (o: ExtraOutput) => setRecipe({ ...recipe, extra_outputs: extraOutputs.map((x) => (x.id === o.id ? o : x)) })
  const removeOutput = (id: string) => {
    setRecipe({ ...recipe, extra_outputs: extraOutputs.filter((x) => x.id !== id) })
    setSel({ kind: 'output' })
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
    setRecipe({ ...recipe, inputs: rest, base, extra_outputs: recipe.extra_outputs?.filter((o) => o.branch !== role) })
    setSel({ kind: 'input', role: base })
  }
  const renameRole = (old: string, raw: string, bindTo?: string) => {
    const role = raw.replace(/[^A-Za-z0-9_]/g, '_')
    const b = { ...bindings }
    if (bindTo) b[old] = bindTo
    if (!role || (role !== old && roles.includes(role))) { setBindings(b); return old }
    setRecipe(withRoleRenamed(recipe, old, role))
    if (b[old] && role !== old) { b[role] = b[old]; delete b[old] }
    setBindings(b)
    if (sel.kind === 'input' && sel.role === old) setSel({ kind: 'input', role })
    return role
  }

  /** Put several datasets in at once: the first fills `role` (or the empty start input), the rest become new inputs. */
  const placeDatasets = (list: Selection[], role?: string) => {
    if (list.length < 2) { if (list[0]) placeDataset(list[0], role); return }
    list.forEach(addKnownDataset)
    setAddData(null)
    let next = recipe
    const b = { ...bindings }
    let first: string | undefined
    let queue = list
    const target = role ?? (bindings[recipe.base] ? undefined : recipe.base)
    if (target) {
      const r = isDefaultRole(target) ? roleFrom(list[0].label, roles.filter((x) => x !== target)) : target
      if (r !== target) { next = withRoleRenamed(next, target, r); delete b[target] }
      b[r] = list[0].id
      first = r
      queue = list.slice(1)
    }
    for (const s of queue) {
      const r = roleFrom(s.label, next.inputs.map((i) => i.role))
      next = { ...next, inputs: [...next.inputs, { role: r }] }
      b[r] = s.id
      first ??= r
    }
    setRecipe(next)
    setBindings(b)
    setSel({ kind: 'input', role: first! })
    toast(`Added ${list.length} tables. Use Join or Append to combine them.`)
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

  /** A library table dropped on the canvas: fills the empty input it lands on, otherwise joins the workflow. */
  const dropDataset = (id: string, target: HTMLElement) => {
    const step = combineStepAt(target)
    const role = target.closest<HTMLElement>('[data-role]')?.dataset.role
    const into = role && !bindings[role] ? role : undefined
    if (id.startsWith(FILE_PREFIX)) {
      const f = newFiles.find((x) => x.id === id.slice(FILE_PREFIX.length))
      if (f) setAddData({ role: step ? undefined : into, presetSource: f, step: step ?? undefined })
      return
    }
    const s = (allSelections ?? []).find((x) => x.id === id)
    if (s && step) attachToStep(s, step)
    else if (s) placeDataset(s, into)
  }

  /** The Join or Append box under the pointer, if any. */
  const combineStepAt = (target: HTMLElement): StepRef | null => {
    const el = target.closest<HTMLElement>('[data-step]')
    if (!el) return null
    const branch = el.dataset.branch || undefined
    const i = Number(el.dataset.step)
    const op = stepsOf(branch)[i]?.op
    return op === 'join' || op === 'append_rows' ? { i, branch } : null
  }

  /** A library table dropped on a Join/Append box: use it as that step's other table. */
  const attachToStep = (s: Selection, at: StepRef) => {
    addKnownDataset(s)
    setAddData(null)
    const step = stepsOf(at.branch)[at.i]
    if (!step) return
    // Reuse an input already bound to this table when it can be combined here; otherwise add one.
    const allowed = combinable(at.branch)
    let role = roles.find((r) => bindingId(bindings[r]) === s.id && allowed.includes(r))
    let next = recipe
    const b = { ...bindings }
    if (!role) {
      role = roleFrom(s.label, roles)
      next = { ...next, inputs: [...next.inputs, { role }] }
      b[role] = s.id
    }
    let changed: Step
    if (step.op === 'join') {
      // Match on the first column name both tables share, as a starting point.
      const left = colsBefore(at.i, at.branch).map((c) => c.name)
      const key = (s.schema ?? []).map((c) => c.name).find((c) => left.includes(c)) ?? ''
      changed = { ...step, right: role, left_on: [key], right_on: [key], right_columns: undefined }
    } else {
      const list = (step.inputs as string[]) ?? []
      changed = { ...step, inputs: list.includes(role) ? list : [...list, role] }
    }
    const steps = stepsOf(at.branch).map((x, j) => (j === at.i ? changed : x))
    next = at.branch ? { ...next, inputs: next.inputs.map((inp) => (inp.role === at.branch ? { ...inp, steps } : inp)) } : { ...next, steps }
    setRecipe(next)
    setBindings(b)
    setSel({ kind: 'step', i: at.i, branch: at.branch })
    toast(step.op === 'join' ? `Joining with “${s.label}”. Check the matching columns.` : `Appending “${s.label}”.`)
  }

  // Quick filter from a profile bar ("Keep only" / "Exclude"), inserted after the selected node.
  const quickFilter = (column: string, value: Cell, keep: boolean) => {
    const branch = viewRole ?? undefined
    const at = sel.kind === 'step' ? sel.i + 1 : sel.kind === 'output' ? recipe.steps.length : 0
    insertStep(at, { op: 'filter_rows', match: 'all', conditions: [{ column, operator: keep ? 'in' : 'not_in', value: [value] }] }, branch)
  }

  const withExpected = (): Recipe => ({
    ...recipe,
    inputs: recipe.inputs.map((i) => ({ ...i, expected_columns: (byId[bindings[i.role]]?.schema ?? i.expected_columns ?? []).map((c) => ({ name: c.name, type: c.type })) })),
  })

  /** Save; returns whether it worked. `stay` false leaves the URL alone (we're about to navigate elsewhere). */
  const save = async (name: string, description: string, asNew: boolean, stay = true): Promise<boolean> => {
    setSaving(true)
    try {
      const body = { name, description, definition: withExpected(), origin }
      const r = meta.id && !asNew ? await api.put<RecipeDetail>(`/api/recipes/${meta.id}`, body) : await api.post<RecipeDetail>('/api/recipes', body)
      setMeta({ id: r.id, name: r.name, description: r.description, version: r.version.version })
      setSaved(JSON.stringify({ r: recipe, n: r.name }))
      storeBindings(r.id, bindings)
      setSaveOpen(false)
      toast(`Saved “${r.name}” (version ${r.version.version})`)
      if (stay && routeId !== r.id) {
        leaving.current = true
        nav(`/workflows/${r.id}`, { replace: true })
        leaving.current = false
      }
      return true
    } catch (e) { toast((e as Error).message, true); return false } finally { setSaving(false) }
  }
  const saveClick = () => {
    if (!anyBound) { toast('Add some data before saving', true); return }
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

  const nodeTitle = selOut ? `Output · ${selOut.name}` : sel.kind === 'output' ? `Result · ${recipe.output.name}` : sel.kind === 'input' ? `Input · ${sel.role}`
    : sel.kind === 'group' ? `Group · ${groupById(sel.id)?.name ?? ''} (its result)`
    : `${sel.branch ? `${sel.branch} · ` : ''}${sel.i + 1}. ${OP_LABEL[stepsOf(sel.branch)[sel.i]?.op] ?? ''}`
  // Until the first dataset is added the studio shows one focused "add your data" screen, nothing else.
  const empty = !anyBound
  const canRun = allBound && !running && !err && recipe.output.formats.length > 0
  const runBlocker = !allBound ? 'Connect every input to data first' : err ? 'Fix the highlighted step first'
    : recipe.output.formats.length === 0 ? 'Choose Excel and/or CSV on the Result node' : 'Running…'
  const nextHint = empty ? 'Drag tables from the Library on the left onto the canvas, or drop Excel/CSV files here.'
    : !allBound ? 'Connect the highlighted input to a dataset.'
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
        </>}
      </div>
      <div className="prep-body">
      <LibraryPanel nudge={libraryNudge} datasets={allSelections} files={newFiles} onSetUp={(f) => setAddData({ presetSource: f })} used={Object.values(bindings).map(bindingId)}
        onAdd={(s) => placeDataset(s)} onAddFile={() => setAddData({ tab: 'file' })} />
      <div className="prep-main">
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

      {/* ---------- flow canvas (AI helper and Run sit in its top-right corner, outside the scrolling area) */}
      <div className={`prep-canvas-wrap${empty ? ' empty' : ''}`}>
      {!empty && (
        <div className="canvas-actions">
        <button className="canvas-run canvas-ai" onClick={() => setAiOpen(true)} disabled={!allBound}
          title={allBound ? 'AI helper: describe the result and let your AI chatbot draft the steps' : 'Connect every input to data first'} aria-label="AI helper">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M10 4c.6 4 2.5 6 6.5 6.5-4 .6-5.9 2.5-6.5 6.5-.6-4-2.5-5.9-6.5-6.5 4-.5 5.9-2.5 6.5-6.5z" /><path d="M18 2.5c.3 1.8 1 2.5 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.3 2.5-1 2.8-2.8z" /><path d="M18 15c.4 2.2 1.3 3.1 3.5 3.5-2.2.4-3.1 1.3-3.5 3.5-.4-2.2-1.3-3.1-3.5-3.5 2.2-.4 3.1-1.3 3.5-3.5z" /></svg>
        </button>
        <button className="canvas-run" onClick={run} disabled={!canRun}
          title={canRun ? 'Run the workflow and create the files (Ctrl+Enter)' : runBlocker}>
          {running ? <Spinner /> : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
          )}
          <span className="canvas-run-label">{running ? 'Running…' : 'Run'}</span>
        </button>
        </div>
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
        onDragOver={(e) => {
          const kind = e.dataTransfer.types.includes(DATASET_MIME) ? 'dataset' : e.dataTransfer.types.includes('Files') ? 'file' : null
          if (!kind) return
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragKind(kind); setDropping(true)
          const at = kind === 'dataset' ? combineStepAt(e.target as HTMLElement) : null
          setDropStep(at ? `${at.branch ?? ''}:${at.i}` : null)
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDropping(false); setDropStep(null) } }}
        onDrop={(e) => {
          e.preventDefault(); setDropping(false); setDropStep(null)
          const id = e.dataTransfer.getData(DATASET_MIME)
          if (id) dropDataset(id, e.target as HTMLElement)
          else if (e.dataTransfer.files.length) dropFiles([...e.dataTransfer.files])
        }}
        onClick={(e) => { if (e.target === e.currentTarget) setAddAt(null) }}
        onPointerDown={onPanDown} onPointerMove={onPanMove} onPointerUp={onPanUp} onPointerCancel={onPanUp}
      >
          <FlowCanvas recipe={recipe} bindings={bindings} byId={byId} preview={preview} sel={sel} setSel={setSel}
            addAt={addAt} setAddAt={setAddAt} onAdd={(op, a) => (op === OUTPUT_OP ? addOutput(a.branch, a.i - 1) : addStep(op, a.i, a.branch))}
            expanded={expanded} onToggleGroup={toggleGroup} range={range} onStepClick={clickStep} onConnect={nudgeLibrary}
            zoom={zoom} pan={pan} dropStep={dropStep} />
        {dropping && <div className={`canvas-drop-overlay${dropStep ? ' on-step' : ''}`}>{dragKind === 'file' ? 'Drop to add this file to the workflow'
          : dropStep ? 'Drop to use this table in the highlighted step' : 'Drop to add this table — or drop it on a Join or Append box'}</div>}
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
                  <button className={s ? '' : 'primary'} onClick={() => (s ? setAddData({ role: inp.role }) : nudgeLibrary())}>{s ? 'Use different data…' : 'Choose data…'}</button>
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
                {isCodeNote(s.note) && <div className="alert info small">📜 {s.note}</div>}
                {isErrAt(i, branch) && <div className="alert bad small">{err!.message}</div>}
                {!branch && groupOf(groups, i) && (
                  <div className="faint small">In group <a href="#" onClick={(e) => { e.preventDefault(); setSel({ kind: 'group', id: groupOf(groups, i)!.id }) }}>{groupOf(groups, i)!.name}</a></div>
                )}
                <StepEditor step={s} cols={colsBefore(i, branch)} roleCols={roleCols} roles={[branch ?? recipe.base, ...combinable(branch)]} base={branch ?? recipe.base} onChange={update}
                  details={rep?.details}
                  datasets={{
                    label: (r) => byId[bindings[r]]?.label ?? r,
                    library: (allSelections ?? []).filter((x) => !Object.values(bindings).map(bindingId).includes(x.id)),
                    onPick: (x) => attachToStep(x, { i, branch }),
                  }}
                  columnValues={allBound ? (column) => api.post<ColumnValues>('/api/transform/column-values', { recipe, bindings, column, before: i, branch }) : undefined} />
                {(s.op === 'join' || s.op === 'append_rows') && combinable(branch).length === 0 && (
                  <div className="alert info small">This step needs a second table. <a href="#" onClick={(e) => { e.preventDefault(); setAddData({}) }}>Add data</a></div>
                )}
                {rep && rep.warnings.length > 0 && <div className="alert warn small"><ul>{rep.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {rep && Object.keys(rep.details).length > 0 && (
                  <div className="faint small">{Object.entries(rep.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>
                )}
                <button className="sm output-from-step" onClick={() => addOutput(branch, i)} title="Write the table as it is after this step to its own file, and to your Library">
                  <OpIcon op="output" size={13} /> Save this step's result as an output
                </button>
                {!(isCodeNote(s.note)) && (
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
                    <div className="faint small">{g.kind === 'macro' ? translatedLabel(g) : 'Step group'} · {g.end - g.start + 1} steps{last ? ` · ${preview!.steps[g.start]?.rows_in.toLocaleString()} → ${last.rows_out.toLocaleString()} rows` : ''}</div>
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
                {g.source?.macro_name && <div className="faint small">From {(SOURCE_LABEL[g.source.language as MacroInfo['language']] ?? SOURCE_LABEL.vba).noun} <b>{g.source.macro_name}</b>{g.source.modules ? ` (${g.source.modules})` : ''}</div>}
                <div className="row">
                  <button onClick={() => toggleGroup(g.id)}>{open ? '▸ Collapse' : '▾ Expand'}</button>
                  <button onClick={() => ungroup(g.id)} title="Keep the steps, remove the grouping">Ungroup</button>
                </div>
              </div>
            )
          })()}

          {selOut && (
            <div className="stack">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="op-dot" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={16} color="#fff" /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 style={{ margin: 0 }} className="ellipsis">{outputLabel(selOut.name)}</h2>
                  <div className="faint small">
                    Extra output · taken {selOut.after < 0 ? `straight from “${selOut.branch ?? recipe.base}”` : <>after step {selOut.after + 1}, <b>{OP_LABEL[stepsOf(selOut.branch ?? undefined)[selOut.after]?.op]}</b>{selOut.branch ? ` on “${selOut.branch}”` : ''}</>}
                    {preview?.data ? ` · ${preview.data.row_count.toLocaleString()} rows` : ''}
                  </div>
                </div>
                <button className="ghost icon" onClick={() => removeOutput(selOut.id)} title="Remove this output">🗑</button>
              </div>
              <OutputSettings output={selOut} onChange={(o) => updateOutput({ ...selOut, ...o })} />
            </div>
          )}

          {sel.kind === 'output' && !selOut && (
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
      </div>
      </div>

      {runDialog && (
        <RunDialog runId={runDialog.id} title={runDialog.title} onClose={() => setRunDialog(null)}
          onGoToStep={(i, branch) => { setRunDialog(null); setSel({ kind: 'step', i, branch }) }} />
      )}
      {saveOpen && <SaveModal meta={meta} saving={saving} onClose={() => setSaveOpen(false)} onSave={save} />}
      {blocker.state === 'blocked' && (
        <LeaveModal meta={meta} saving={saving} isNew={!meta.id}
          onStay={() => blocker.reset()}
          onDiscard={() => blocker.proceed()}
          onSave={async (name, description) => { if (await save(name, description, false, false)) blocker.proceed() }} />
      )}
      {aiOpen && <AIDraftModal bindings={bindings} roles={roles} onClose={() => setAiOpen(false)} />}
      {addData && (
        <AddDataModal
          title={addData.presetSource ? `Set up “${addData.presetSource.name}”` : addData.role && !bindings[addData.role] ? 'Choose data' : addData.role ? `Replace data for “${addData.role}”` : 'Add data to this workflow'}
          presetSource={addData.presetSource}
          startTab={addData.tab}
          onClose={() => setAddData(null)}
          onPick={(s) => (addData.step ? attachToStep(s, addData.step) : placeDataset(s, addData.role))}
          onPickMany={addData.step || (addData.role && bindings[addData.role]) ? undefined : (list) => placeDatasets(list, addData.role)}
        />
      )}
    </div>
  )
}

/** Notes the AI translation puts on each step, pointing back to the macro or script lines. */
const isCodeNote = (note: unknown) => typeof note === 'string' && /^From (macro|code|document) /.test(note)
const SOURCE_TEXT: Record<string, MacroInfo['language']> = { macro_to_workflow: 'vba', python_to_workflow: 'python', doc_to_workflow: 'doc' }
const SOURCE_LABEL: Record<MacroInfo['language'], { noun: string; Noun: string; translated: string; from: string }> = {
  vba: { noun: 'macro', Noun: 'Macro', translated: 'Translated Excel macro', from: 'an Excel macro' },
  python: { noun: 'script', Noun: 'Script', translated: 'Translated Python script', from: 'a Python script' },
  doc: { noun: 'procedure', Noun: 'Procedure', translated: 'Translated process document', from: 'a process document' },
}
const translatedLabel = (g: StepGroup) => (SOURCE_LABEL[g.source?.language as MacroInfo['language']] ?? SOURCE_LABEL.vba).translated

function MacroBanner({ info, onAddData }: { info: MacroInfo; onAddData: () => void }) {
  const { noun, from } = SOURCE_LABEL[info.language]
  return (
    <details className="alert info prep-banner" open={info.missing_data.length > 0}>
      <summary style={{ cursor: 'pointer' }}>
        <b>Translated from {from}.</b> Click each step to see which {noun} lines it comes from.
        {info.not_translated.length > 0 && <> · {info.not_translated.length} part(s) not translated</>}
        {info.missing_data.length > 0 && <> · <span style={{ color: 'var(--bad)' }}>{info.missing_data.length} dataset(s) missing</span></>}
      </summary>
      {info.missing_data.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <b className="small">The AI says the {noun} also needs:</b>
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

function FlowCanvas({ recipe, bindings, byId, preview, sel, setSel, addAt, setAddAt, onAdd, onConnect,
  expanded, onToggleGroup, range, onStepClick, zoom, pan, dropStep }: {
  recipe: Recipe; bindings: Record<string, string>; byId: Record<string, Selection>; preview: Preview | null
  sel: Sel; setSel: (s: Sel) => void; addAt: AddAt; setAddAt: (a: AddAt) => void
  onAdd: (op: string, at: NonNullable<AddAt>) => void; onConnect: () => void
  expanded: Set<string>; onToggleGroup: (id: string, open?: boolean) => void
  range: { start: number; end: number } | null; onStepClick: (i: number, branch: string | undefined, shift: boolean) => void
  zoom: number; pan: { x: number; y: number }
  /** "branch:index" of the Join/Append box a library table is being dragged over. */
  dropStep?: string | null
}) {
  const n = recipe.steps.length
  const err = preview?.error
  const groups = recipe.groups ?? []
  // Main flow as drawn: a collapsed group is one item. colOf maps each step to its column.
  const { items, colOf } = layoutMain(n, groups, expanded)
  const resultCol = items.length + 1
  // Inputs whose own steps belong to a collapsed group feed straight into the group node.
  const folded = new Set(groups.filter((g) => !expanded.has(g.id)).flatMap((g) => g.inputs ?? []))

  // Each extra input gets its own row: input → its own steps → into the step that uses it, which is
  // in the main flow or on another input's row (inputs can merge before reaching the main flow).
  const secondary = recipe.inputs.filter((i) => i.role !== recipe.base)
  const laneOf: Record<string, number> = Object.fromEntries(secondary.map((inp, k) => [inp.role, k + 1]))
  const shown = (role: string) => (folded.has(role) ? [] : secondary.find((i) => i.role === role)?.steps ?? [])
  const starts: Record<string, number> = {}
  const placing = new Set<string>()
  const targetOf = (role: string): { lane: number; col: number } | null => {
    const m = recipe.steps.findIndex((s) => stepRefs(s).includes(role))
    if (m >= 0) return { lane: 0, col: colOf[m] }
    for (const other of secondary) {
      if (other.role === role) continue
      const j = (other.steps ?? []).findIndex((s) => stepRefs(s).includes(role))
      if (j >= 0) return { lane: laneOf[other.role], col: startOf(other.role) + (folded.has(other.role) ? 0 : 1 + j) }
    }
    return null
  }
  // A row ends just before the step it feeds, so its first column can be left of the main input.
  const startOf = (role: string): number => {
    if (role in starts) return starts[role]
    if (placing.has(role)) return 0
    placing.add(role)
    const t = targetOf(role)
    starts[role] = t ? t.col - 1 - shown(role).length : 0
    return starts[role]
  }
  const rows = secondary.map((inp) => ({
    role: inp.role, steps: shown(inp.role), lane: laneOf[inp.role], start: startOf(inp.role), target: targetOf(inp.role),
    hiddenSteps: folded.has(inp.role) ? (inp.steps ?? []).length : 0,
  }))
  const rowEnd = (r: (typeof rows)[number]) => r.start + r.steps.length

  // Extra outputs hang below the step they are taken from, packed into lanes under the input rows.
  const tapCol = (o: ExtraOutput): { lane: number; col: number } => {
    if (!o.branch || o.branch === recipe.base) return { lane: 0, col: o.branch || o.after < 0 ? 0 : colOf[o.after] ?? 0 }
    const r = rows.find((x) => x.role === o.branch)
    if (!r) return { lane: 0, col: 0 }
    return { lane: r.lane, col: r.start + (o.after < 0 || r.hiddenSteps ? 0 : 1 + o.after) }
  }
  const firstOutLane = 1 + secondary.length
  const busy = new Set<string>()
  const outs = (recipe.extra_outputs ?? []).map((o) => {
    const from = tapCol(o)
    const col = from.col + 1
    let lane = Math.max(firstOutLane, from.lane + 1)
    while (busy.has(`${lane}:${col}`)) lane++
    busy.add(`${lane}:${col}`)
    return { o, from, col, lane }
  })

  // A blank workflow is just its "Choose data" node; the rest of the flow appears once data is in.
  const blank = !recipe.inputs.some((i) => bindings[i.role]) && n === 0
  const ox = -Math.min(0, ...rows.map((r) => r.start))   // shift right when a row starts left of the main input
  const pos = (col: number, lane: number) => ({ x: PAD_X + (col + ox) * COL_W, y: PAD_Y + lane * LANE_H })
  const lanes = Math.max(1 + secondary.length, ...outs.map((x) => x.lane + 1))
  const maxCol = Math.max(resultCol, ...rows.map(rowEnd), ...outs.map((x) => x.col)) + ox
  // Extra room on the right and bottom so the floating Run button and zoom controls never cover a node.
  const width = blank ? PAD_X * 2 : Math.max(PAD_X * 2 + maxCol * COL_W + 70, 600)
  const height = blank ? PAD_Y + 64 : PAD_Y + lanes * LANE_H + 30

  const edges: ReactNode[] = []
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }, key: string, cls = '') => {
    const mx = (a.x + b.x) / 2
    edges.push(<path key={key} d={`M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`} className={`flow-edge${cls}`} />)
  }
  if (!blank) for (let c = 0; c <= items.length; c++) curve(pos(c, 0), pos(c + 1, 0), `m${c}`)
  for (const r of rows) {
    for (let c = r.start; c < rowEnd(r); c++) curve(pos(c, r.lane), pos(c + 1, r.lane), `b${r.role}${c}`)
    if (r.target) curve(pos(rowEnd(r), r.lane), pos(r.target.col, r.target.lane), `s${r.role}`)
  }
  for (const x of outs) curve(pos(x.from.col, x.from.lane), pos(x.col, x.lane), `o${x.o.id}`, ' out')

  const isSel = (s: Sel) => JSON.stringify(s) === JSON.stringify(sel)
  const inputNode = (role: string, col: number, lane: number, unused: boolean) => {
    const s = byId[bindings[role]]
    const p = preview?.inputs.find((x) => x.role === role)
    const { x, y } = pos(col, lane)
    return (
      <div key={`in-${role}`} data-role={role} className={`flow-node input${isSel({ kind: 'input', role }) ? ' selected' : ''}${s ? '' : ' unbound'}`} style={{ left: x, top: y }}
        onClick={() => { setSel({ kind: 'input', role }); if (!s) onConnect() }} title={s ? `${s.label}\n${s.source_name}` : 'Drag a table from the Library onto this box'}>
        <div className="flow-shape">
          {s ? <FileIcon kind={s.source_kind} ext={extOf(s.source_name)} size={26} /> : <span style={{ fontSize: 20, color: 'var(--accent)' }}>+</span>}
          {s?.template && <span className="flow-flag tpl" title="Data template">📅</span>}
        </div>
        <div className="flow-label">
          <div className="ellipsis"><b>{!s && isDefaultRole(role) ? 'Drag dataset' : lane > 0 ? role : s?.label ?? role}</b></div>
          {s?.template && <div className="ellipsis tpl-period">{periodLabel(s, bindings[role], p?.template_value)}</div>}
          <div className="faint ellipsis">{p ? `${p.rows.toLocaleString()} rows${unused ? ' · not used yet' : ''}` : s ? s.source_name : isDefaultRole(role) ? 'one or more tables' : 'choose data'}</div>
        </div>
      </div>
    )
  }
  const stepNode = (s: Step, i: number, col: number, lane: number, branch?: string) => {
    const { x, y } = pos(col, lane)
    const rep = branch ? preview?.branches?.[branch]?.[i] : preview?.steps[i]
    const bad = !!err && err.step === i && (err.branch ?? undefined) === branch
    const me: Sel = { kind: 'step', i, branch }
    const combine = s.op === 'join' || s.op === 'append_rows'
    const waiting = combine && !stepRefs(s).length
    return (
      <div key={`${branch ?? 'main'}-${i}`} data-step={i} data-branch={branch ?? ''}
        className={`flow-node step${branch ? ' branch' : ''}${isSel(me) ? ' selected' : ''}${bad ? ' errored' : ''}${waiting ? ' awaiting-table' : ''}${dropStep === `${branch ?? ''}:${i}` ? ' drop-target' : ''}${!branch && range && range.start <= i && i <= range.end ? ' in-range' : ''}`} style={{ left: x, top: y }}
        onClick={(e) => onStepClick(i, branch, e.shiftKey)} title={`${branch ? `On “${branch}” only: ` : ''}${stepSummary(s)}${s.note ? `\n${s.note}` : ''}${branch ? '' : '\nShift+click another step to select a range to group'}`}>
        <div className="flow-shape" style={{ background: OP_COLOR[s.op] }}>
          <OpIcon op={s.op} size={branch ? 17 : 20} color="#fff" />
          {bad && <span className="flow-flag bad">!</span>}
          {!bad && rep && rep.warnings.length > 0 && <span className="flow-flag warn">{rep.warnings.length}</span>}
          {isCodeNote(s.note) && <span className="flow-flag macro" title={s.note}>📜</span>}
        </div>
        <div className="flow-label">
          <div className="ellipsis"><b>{OP_LABEL[s.op]}</b></div>
          <div className="faint ellipsis">{waiting ? 'drop a table here' : rep ? `${rep.rows_out.toLocaleString()} rows` : bad ? 'needs attention' : stepSummary(s)}</div>
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
          {g.kind === 'macro' && <span className="flow-flag macro" title={translatedLabel(g)}>📜</span>}
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
      {!blank && (() => {
        const { x, y } = pos(resultCol, 0)
        return (
          <div className={`flow-node step output${isSel({ kind: 'output' }) ? ' selected' : ''}`} style={{ left: x, top: y }} onClick={() => setSel({ kind: 'output' })}>
            <div className="flow-shape" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={20} color="#fff" /></div>
            <div className="flow-label"><div className="ellipsis"><b>Result</b></div><div className="faint ellipsis">{outputSub(recipe.output)}</div></div>
          </div>
        )
      })()}
      {!blank && outs.map(({ o, col, lane }) => {
        const { x, y } = pos(col, lane)
        const me: Sel = { kind: 'output', id: o.id }
        return (
          <div key={`out-${o.id}`} className={`flow-node step output extra${isSel(me) ? ' selected' : ''}`} style={{ left: x, top: y }}
            onClick={() => setSel(me)} title={`Extra output: ${o.name}`}>
            <div className="flow-shape" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={18} color="#fff" /></div>
            <div className="flow-label"><div className="ellipsis"><b>{outputLabel(o.name)}</b></div><div className="faint ellipsis">{outputSub(o)}</div></div>
          </div>
        )
      })}
      {!blank && Array.from({ length: items.length + 1 }, (_, k) => {
        const next = items[k]
        const at = !next ? n : next.kind === 'step' ? next.i : next.g.start
        return plus(`add${k}`, pos(k, 0).x + COL_W / 2, pos(k, 0).y, { i: at }, n === 0)
      })}

      {rows.map((r) => (
        <span key={r.role} style={{ display: 'contents' }}>
          {inputNode(r.role, r.start, r.lane, !r.target)}
          {r.steps.map((s, j) => stepNode(s, j, r.start + 1 + j, r.lane, r.role))}
          {!r.hiddenSteps && Array.from({ length: r.steps.length + 1 }, (_, j) => {
            const a = pos(r.start + j, r.lane)
            // The last "+" sits just after the row's last node, before it joins the main flow.
            return plus(`add-${r.role}-${j}`, a.x + COL_W / 2, a.y, { i: j, branch: r.role })
          })}
        </span>
      ))}

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
  return createPortal(
    <div className="flow-menu floating" style={style} role="menu">
      {at.branch && <div className="flow-menu-note">Steps here change <b>{at.branch}</b> only, before it is combined. Join or append here to merge other inputs into it first.</div>}
      {CATALOG.map((g) => (
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
      <div>
        <div className="flow-menu-group">Output</div>
        <button className="ghost" role="menuitem" onClick={() => onPick(OUTPUT_OP)}>
          <span className="op-dot sm" style={{ background: OP_COLOR.output }}><OpIcon op="output" size={13} color="#fff" /></span>
          <span style={{ textAlign: 'left' }}><b>Save the table here</b><br /><span className="faint small">An extra output file, also added to your Library</span></span>
        </button>
      </div>
    </div>,
    document.body,
  )
}

/** "xlsx + csv · Library" under an output node. */
function outputSub(o: { formats: string[]; save_to_library?: boolean }) {
  const files = o.formats.join(' + ')
  const lib = o.save_to_library !== false
  return [files, lib ? 'Library' : ''].filter(Boolean).join(' · ') || 'not saved'
}
