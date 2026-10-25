// Datasets a workflow input can use: single sheet selections and data templates.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DATASETS_CHANGED, api } from './api'
import type { DataTemplate, Selection, Source } from './types'

const extOf = (name: string) => name.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? ''

/** Present a template like a selection, so pickers, nodes and bindings treat both alike. */
export function templateAsDataset(t: DataTemplate): Selection {
  return {
    id: t.id, source_id: '', kind: 'sheet', label: t.name,
    config: { sheet: t.sheet, header_row: t.header_row, columns: t.columns },
    schema: t.schema, created_at: t.created_at, updated_at: t.updated_at,
    source_name: t.pattern, source_kind: ['.csv', '.tsv'].includes(extOf(t.pattern)) ? 'csv' : 'excel',
    template: t,
  }
}

/** A binding is a selection id, a template id (newest file) or "templateId@value" (a specific file). */
export const bindingId = (binding: string | undefined) => (binding ?? '').split('@')[0]
export const bindingValue = (binding: string | undefined) => {
  const i = (binding ?? '').indexOf('@')
  return i >= 0 ? binding!.slice(i + 1) : null
}

export function useDatasets() {
  const [list, setList] = useState<Selection[] | null>(null)
  const reload = useCallback(async () => {
    const [sels, tpls] = await Promise.all([api.get<Selection[]>('/api/selections'), api.get<DataTemplate[]>('/api/templates')])
    setList([...tpls.map(templateAsDataset), ...sels.filter((s) => s.kind === 'sheet')])
  }, [])
  useEffect(() => { reload() }, [reload])
  useRefreshOnChange(reload)
  const add = useCallback((s: Selection) => setList((l) => (l && !l.some((x) => x.id === s.id) ? [s, ...l] : l)), [])
  const byId = useMemo(() => Object.fromEntries((list ?? []).map((s) => [s.id, s])), [list])
  return { datasets: list, byId, reload, add }
}

/** Reload when data is added elsewhere: another page or pop-up in this app, or another browser tab. */
function useRefreshOnChange(reload: () => Promise<void>) {
  useEffect(() => {
    const refresh = () => { reload().catch(() => undefined) }
    window.addEventListener(DATASETS_CHANGED, refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener(DATASETS_CHANGED, refresh); window.removeEventListener('focus', refresh) }
  }, [reload])
}

/** Spreadsheet files added but not set up yet (no sheet saved), so not usable as a dataset until one is. */
export function useUnpreparedFiles() {
  const [list, setList] = useState<Source[]>([])
  const reload = useCallback(async () => {
    const all = await api.get<Source[]>('/api/sources')
    setList(all.filter((s) => (s.kind === 'excel' || s.kind === 'csv') && !s.selection_count))
  }, [])
  useEffect(() => { reload().catch(() => undefined) }, [reload])
  useRefreshOnChange(reload)
  return list
}
