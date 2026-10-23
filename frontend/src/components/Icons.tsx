import type { ReactNode } from 'react'
import type { SourceKind } from '../types'

// ---------- file-type icons (document with folded corner + type mark)

type FileType = 'excel' | 'csv' | 'pdf' | 'word' | 'text' | 'markdown' | 'confluence' | 'web' | 'json' | 'code' | 'feed'

const FILE_COLORS: Record<FileType, string> = {
  excel: '#1f7a45', csv: '#3b8f6e', pdf: '#c8352b', word: '#2b5cb8', text: '#6b7586', markdown: '#4a5568', confluence: '#2f6fd6', web: '#6a4fc4', json: '#5b6475', code: '#3572a5', feed: '#b8612a',
}

export function fileTypeFor(kind: SourceKind | string | undefined, ext?: string): FileType {
  const e = (ext ?? '').toLowerCase()
  if (kind === 'confluence') return 'confluence'
  if (kind === 'feed') return 'feed'
  if (kind === 'html' || e === '.html') return 'web'
  if (kind === 'json' || e === '.json') return 'json'
  if (kind === 'code' || e === '.py' || e === '.ipynb') return 'code'
  if (kind === 'markdown') return 'markdown'
  if (kind === 'xlsx') return 'excel'
  if (kind === 'csv' || e === '.csv' || e === '.tsv') return 'csv'
  if (kind === 'excel' || e === '.xlsx' || e === '.xlsm') return 'excel'
  if (e === '.pdf') return 'pdf'
  if (e === '.docx') return 'word'
  if (e === '.md' || e === '.markdown') return 'markdown'
  return 'text'
}

function mark(type: FileType): ReactNode {
  const w = '#fff'
  switch (type) {
    case 'excel':
      // table grid with a highlighted header row
      return <>
        <rect x="7" y="13" width="14" height="11" rx="1" fill="none" stroke={w} strokeWidth="1.4" />
        <rect x="7" y="13" width="14" height="3.4" fill={w} opacity=".9" />
        <path d="M11.7 16.4V24M16.3 16.4V24M7 20.2h14" stroke={w} strokeWidth="1.2" />
      </>
    case 'csv':
      return <>
        <path d="M8 15h12M8 18.5h12M8 22h12" stroke={w} strokeWidth="1.4" strokeLinecap="round" />
        <path d="M12 14v9.5M16 14v9.5" stroke={w} strokeWidth="1.2" strokeDasharray="1.4 1.6" />
      </>
    case 'pdf':
      return <text x="14" y="22.6" textAnchor="middle" fontSize="7.6" fontWeight="800" fill={w} fontFamily="system-ui, sans-serif">PDF</text>
    case 'word':
      return <path d="M8.3 14.5l2.2 8.5 3.5-7 3.5 7 2.2-8.5" fill="none" stroke={w} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
    case 'markdown':
      return <path d="M8 22.5v-7l3 3.6 3-3.6v7M17.5 15.5v6.5M15.5 20l2 2.4 2-2.4" fill="none" stroke={w} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    case 'confluence':
      return <path d="M8 21.2c2.5-3.6 4.9-3.6 6 -1.2s3.5 2.4 6 -1.2M8 16.8c2.5 3.6 4.9 3.6 6 1.2s3.5-2.4 6 1.2" fill="none" stroke={w} strokeWidth="1.6" strokeLinecap="round" />
    case 'web':
      return <path d="M11 15.5l-3 3.3 3 3.3M17 15.5l3 3.3-3 3.3M15 14.5l-2 8.6" fill="none" stroke={w} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    case 'code':
      return <path d="M11 15.5l-3 3.3 3 3.3M17 15.5l3 3.3-3 3.3" fill="none" stroke={w} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    case 'feed':
      // arrow into a tray: data fetched in
      return <path d="M14 13.5v7M10.8 17.5l3.2 3.2 3.2-3.2M8.5 21.5v2.5h11v-2.5" fill="none" stroke={w} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    case 'json':
      return <text x="14" y="22.6" textAnchor="middle" fontSize="8" fontWeight="800" fill={w} fontFamily="ui-monospace, monospace">{'{ }'}</text>
    default:
      return <path d="M8 15h12M8 18.5h12M8 22h8" stroke={w} strokeWidth="1.4" strokeLinecap="round" />
  }
}

export function FileIcon({ kind, ext, size = 32, title }: { kind?: SourceKind | string; ext?: string; size?: number; title?: string }) {
  const type = fileTypeFor(kind, ext)
  const c = FILE_COLORS[type]
  return (
    <svg width={size} height={size * 32 / 28} viewBox="0 0 28 32" role="img" aria-label={title ?? `${type} file`} style={{ flex: 'none' }}>
      <path d="M4 1.5h13.5L25 9v20a1.5 1.5 0 0 1-1.5 1.5h-19A1.5 1.5 0 0 1 3 29V3a1.5 1.5 0 0 1 1-1.5z" fill={c} />
      <path d="M17.5 1.5V7.5a1.5 1.5 0 0 0 1.5 1.5H25z" fill="#fff" opacity=".45" />
      {mark(type)}
    </svg>
  )
}

// ---------- step (operation) icons

const OP_PATHS: Record<string, ReactNode> = {
  select_columns: <><rect x="4" y="4" width="4.5" height="16" rx="1" /><rect x="10" y="4" width="4.5" height="16" rx="1" opacity=".35" /><rect x="16" y="4" width="4.5" height="16" rx="1" /></>,
  rename_columns: <><path d="M4 18l3.5-10L11 18M5.3 14.5h4.4" /><path d="M14 18l6-6-2-2-6 6v2z" /></>,
  filter_rows: <path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" />,
  sort_rows: <><path d="M8 4v16M4.5 16.5 8 20l3.5-3.5" /><path d="M16 20V4M12.5 7.5 16 4l3.5 3.5" /></>,
  append_rows: <><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="4" y="14" width="16" height="6" rx="1" strokeDasharray="2 2" /><path d="M12 10.5v3" /></>,
  join: <><circle cx="9" cy="12" r="6" /><circle cx="15" cy="12" r="6" /></>,
  deduplicate: <><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H16" /><path d="M11.5 11.5l5 5M16.5 11.5l-5 5" /></>,
  convert_types: <><path d="M4 8h13l-3-3M20 16H7l3 3" /></>,
  derive_column: <><path d="M10 5.5c-2 0-2.5 1-2.8 3L6 18.5c-.3 1.8-1 2.5-2.5 2.5" /><path d="M4.5 10.5h6" /><path d="M13 11l6 7M19 11l-6 7" /></>,
  group_aggregate: <path d="M18 5H6l6 7-6 7h12" />,
  pivot: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 9h16M9 4v16" /><path d="M13 13.5h4.5V18" /></>,
  unpivot: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 9h16M9 4v16" /><path d="M17.5 18H13v-4.5" /></>,
  output: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M5 17v2.5h14V17" /></>,
  group: <><path d="M12 3 3 8l9 5 9-5z" /><path d="M3 12.5l9 5 9-5" /><path d="M3 17l9 5 9-5" /></>,
}

export const OP_COLOR: Record<string, string> = {
  select_columns: '#3f7fd9', rename_columns: '#3f7fd9', filter_rows: '#3f7fd9', sort_rows: '#3f7fd9',
  convert_types: '#3f7fd9', derive_column: '#3f7fd9', deduplicate: '#3f7fd9',
  join: '#7b5cd6', append_rows: '#7b5cd6',
  group_aggregate: '#1f9466', pivot: '#d77a1f', unpivot: '#d77a1f',
  output: '#4b5565',
  group: '#334155',
}

export function OpIcon({ op, size = 20, color = 'currentColor' }: { op: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {OP_PATHS[op] ?? <circle cx="12" cy="12" r="6" />}
    </svg>
  )
}

// ---------- column data-type glyphs (as in profile cards)

const CALENDAR = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" strokeWidth="3" />
  </svg>
)

export function TypeGlyph({ type }: { type: string }) {
  const g: Record<string, ReactNode> = { text: 'Abc', integer: '#', number: '#.#', date: CALENDAR, boolean: '✓✗', empty: '∅' }
  return <span className={`type-glyph t-${type}`} title={type}>{g[type] ?? type}</span>
}
