export type SourceKind = 'excel' | 'csv' | 'document' | 'confluence' | 'feed'
/** A code-fetched data feed: one module in backend/app/connectors/feeds/. */
export interface FeedInfo { id: string; name: string; description: string; error: string | null }

export type SourceStatus = 'ok' | 'changed' | 'missing' | 'error'

export interface Source {
  id: string
  kind: SourceKind
  name: string
  location: string
  metadata: {
    extension?: string
    size?: number
    mtime?: number
    sheets?: string[]
    segments?: number
    characters?: number
    title?: string
    space?: string
    version?: number
    url?: string
    /** Confluence: when the page was last edited (ISO). Files use mtime. */
    modified?: string
    /** Data feed: which feed, what was passed to its fetch code, and the last fetch. */
    feed?: string
    feed_name?: string
    params?: Record<string, unknown>
    rows?: number
    fetched_at?: string
    /** A dataset a workflow run produced (kept in the Library). */
    produced_by?: ProducedBy
  }
  fingerprint: string | null
  status: SourceStatus
  status_detail: string | null
  created_at: string
  updated_at: string
  selection_count?: number
  /** A dropped file copied into the app folder, so not linked to the original path. */
  is_copy?: boolean
  /** Distinct sheets with at least one saved selection (list endpoint only). */
  sheets_used?: number
  selections?: Selection[]
}

export interface ColumnSchema {
  name: string
  type: string
}

/** What a filter can pick from: a column's values as they enter a step. */
export interface ColumnValues {
  type: string
  count?: number
  nulls?: number
  distinct?: number
  truncated?: boolean
  values: { value: Cell; count: number }[]
  min?: number | string
  max?: number | string
  bins?: { from: number | string; to: number | string; count: number }[]
  error?: string
}

export interface Selection {
  id: string
  source_id: string
  kind: 'document' | 'sheet' | 'page'
  label: string
  config: { sheet?: string; header_row?: number; columns?: string[] | null }
  schema: ColumnSchema[] | null
  created_at: string
  updated_at: string
  source_name?: string
  source_kind?: SourceKind
  source_status?: SourceStatus
  /** Set when this entry is a data template rather than a single sheet selection. */
  template?: DataTemplate
  /** Set when a workflow run produced this dataset. */
  produced_by?: ProducedBy | null
}

export interface SheetPreview {
  sheet: string
  width: number
  columns: string[]
  rows: { row: number; cells: Cell[] }[]
  suggested_header_row: number | null
}

export type Cell = string | number | boolean | null

export interface ColumnProfile {
  name: string
  type: string
  non_null: number
  nulls: number
  distinct: number
  samples: Cell[]
}

export interface SheetProfile {
  header_row: number
  row_count: number
  columns: ColumnProfile[]
  warnings: string[]
  sample: { columns: string[]; rows: Cell[][] }
}

export interface Drift {
  missing: string[]
  added: string[]
  type_changes: { name: string; was: string; now: string }[]
}

export interface SelectionCheck {
  selection_id: string
  status: 'ok' | 'changed' | 'missing' | 'error' | 'drift' | 'removed'
  detail: string | null
  drift?: Drift | null
}

export interface CollectionItem {
  selection_id: string
  position: number
  included: boolean
  kind: Selection['kind']
  label: string
  config: Selection['config']
  schema: ColumnSchema[] | null
  removed: boolean
  source_id: string
  source_name: string
  source_kind: SourceKind
  location: string
  source_status: SourceStatus
}

export interface Collection {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
  items?: CollectionItem[]
  item_count?: number
}

export interface OptionField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'boolean' | 'number'
  default?: unknown
  choices?: string[]
  help?: string
}

export interface ServiceDef {
  id: string
  name: string
  description: string
  mode: 'deterministic' | 'ai_assisted' | 'ai_dependent'
  input_kind: 'collection' | 'datasets'
  accepts: string[]
  outputs: string[]
  options: OptionField[]
  builder_route: string | null
}

export interface PreviewSegment {
  anchor: string
  locator: string
  chars: number
  included: boolean
  text: string
  truncated: boolean
}

export interface ContextPreviewItem {
  ref: string
  label: string
  kind: string
  source_name: string
  location: string
  version: string | null
  warnings: string[]
  error: string | null
  segments: PreviewSegment[]
}

export interface ContextPreview {
  items: ContextPreviewItem[]
  characters: number
  estimated_tokens: number
  token_budget: number
  over_budget: boolean
}

export interface Redaction {
  find: string
  replace: string
}

export interface Artifact {
  id: string
  run_id: string
  kind: 'xlsx' | 'csv' | 'markdown' | 'html' | 'json'
  name: string
  path: string
  size: number
  metadata: Record<string, unknown>
  created_at: string
  run_title?: string
  service_id?: string
  file_path?: string
}

export interface Exchange {
  kind: 'prompt' | 'response' | 'corrective_prompt'
  at: string
  chars: number
  text?: string
  attempt?: number
  accepted?: boolean
  errors?: number
  warnings?: number
}

export type RunStatus = 'draft' | 'running' | 'awaiting_response' | 'invalid_response' | 'completed' | 'failed'

export interface Run {
  id: string
  /** The saved workflow this run belongs to, if any. */
  recipe_id?: string | null
  service_id: string
  title: string
  status: RunStatus
  config: Record<string, unknown>
  collection_id: string | null
  snapshot_id: string | null
  state: {
    progress?: RunProgress
    prompt?: string
    estimated_tokens?: number
    corrective_prompt?: string | null
    warnings?: string[]
    attempt?: number
    recipe?: Recipe
    document?: unknown
    steps?: StepReport[]
    inputs?: { role: string; label: string; path: string; sheet: string; header_row: number; rows: number; sha256: string; warnings: string[] }[]
    [k: string]: unknown
  }
  exchanges: Exchange[]
  errors: string[]
  summary: Record<string, unknown>
  created_at: string
  updated_at: string
  artifacts: Artifact[]
  snapshot?: { id: string; manifest: { retrieved_at: string; items: { ref: string; label: string; kind: string; location: string; version: string | null; error: string | null; warnings: string[]; anchors: { anchor: string; locator: string; chars: number }[]; rows?: number; header_row?: number }[]; [k: string]: unknown } }
  collection_name?: string
  artifact_count?: number
}

// ---- transformations

export type Step = { op: string; note?: string; [k: string]: unknown }

export interface Recipe {
  schema_version: 1
  inputs: { role: string; description?: string; expected_columns?: ColumnSchema[]; steps?: Step[] }[]
  base: string
  steps: Step[]
  output: RecipeOutput
  /** Further results taken part-way through the flow (main flow when `branch` is unset). */
  extra_outputs?: ExtraOutput[]
  groups?: StepGroup[]
}

export interface RecipeOutput {
  name: string
  formats: ('xlsx' | 'csv')[]
  folder?: string | null
  if_exists?: 'keep_both' | 'replace'
  /** Keep the table in the Library as a dataset, refreshed on every run (default on). */
  save_to_library?: boolean
}

/** An output taken right after step `after` (-1 = the input as read) of the main flow or of input `branch`. */
export interface ExtraOutput extends RecipeOutput {
  id: string
  branch?: string | null
  after: number
}

/** Where a dataset kept in the Library came from, when a workflow run produced it. */
export interface ProducedBy {
  workflow: string
  recipe_id: string | null
  recipe_version: number | null
  run_id: string
  run_at: string
  output_id: string
  output_name: string
  rows: number
}

/** A named, collapsible run of consecutive main-flow steps (inclusive indices). Never affects results. */
export interface StepGroup {
  id: string
  name: string
  start: number
  end: number
  kind?: 'manual' | 'macro'
  inputs?: string[]
  source?: Record<string, string> | null
}

export interface StepReport {
  index: number
  op: string
  rows_in: number
  rows_out: number
  columns: ColumnSchema[]
  warnings: string[]
  details: Record<string, unknown>
}

export interface TransformPreview {
  inputs: { role: string; label: string; rows: number; sheet: string; header_row: number; warnings: string[]; path?: string; template_id?: string; template_value?: string; template_latest?: boolean }[]
  input_problems: string[]
  steps: StepReport[]
  branches?: Record<string, StepReport[]>
  error: { step: number | null; branch?: string | null; message: string } | null
  warnings?: string[]
  data?: { columns: string[]; rows: Cell[][]; row_count: number; schema: ColumnSchema[] }
}

export interface RecipeSummary {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
  latest_version: number
}

export interface RecipeDetail extends RecipeSummary {
  version: { id: string; version: number; definition: Recipe; origin: string; created_at: string }
  versions: { id: string; version: number; origin: string; created_at: string }[]
  last_bindings: Record<string, string>
}

export interface Settings {
  confluence_base_url: string
  retain_prompts: boolean
  prompt_token_budget: number
  chatbot_name: string
  confluence_token_set: boolean
  save_folder: string | null
  welcomed: boolean
  suggested_save_folder: string
}

export interface TemplateMatch {
  value: string
  label: string
  filename: string
  path: string
  date: string | null
  modified: number
  size: number
}

export interface DataTemplate {
  id: string
  name: string
  folder: string
  pattern: string
  format: string
  sheet: string
  header_row: number
  columns: string[] | null
  schema: ColumnSchema[] | null
  matches: TemplateMatch[]
  error: string | null
  created_at: string
  updated_at: string
}

export interface TemplateSuggestion {
  pattern: string
  format: string
  example_value: string
  matches: TemplateMatch[]
}

export interface RunProgress {
  stage: 'queued' | 'read' | 'steps' | 'write' | 'done' | 'failed'
  message: string
  done: number
  total: number
  started: number
  inputs_done?: number
  inputs_total?: number
}
