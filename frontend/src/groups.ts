// Keeping step groups consistent while main-flow steps are inserted, deleted and moved.
import type { StepGroup } from './types'

/** Inserting a step at `at`: groups after it shift; inserting strictly inside a group extends it. */
export function shiftOnInsert(groups: StepGroup[], at: number): StepGroup[] {
  return groups.map((g) => {
    if (at <= g.start) return { ...g, start: g.start + 1, end: g.end + 1 }
    if (at <= g.end) return { ...g, end: g.end + 1 }
    return g
  })
}

/** Deleting step `i`: groups after it shift; a group that loses its last step disappears. */
export function shiftOnDelete(groups: StepGroup[], i: number): StepGroup[] {
  return groups
    .map((g) => {
      if (i < g.start) return { ...g, start: g.start - 1, end: g.end - 1 }
      if (i <= g.end) return { ...g, end: g.end - 1 }
      return g
    })
    .filter((g) => g.end >= g.start)
}

export const groupOf = (groups: StepGroup[], i: number) => groups.find((g) => g.start <= i && i <= g.end)

export type FlowItem = { kind: 'step'; i: number } | { kind: 'group'; g: StepGroup }

/** Main-flow items as drawn: collapsed groups become one item. Also maps each step to its column. */
export function layoutMain(n: number, groups: StepGroup[], expanded: Set<string>) {
  const items: FlowItem[] = []
  const colOf: number[] = []
  let i = 0
  while (i < n) {
    const g = groups.find((x) => x.start === i)
    if (g && !expanded.has(g.id)) {
      items.push({ kind: 'group', g })
      for (let k = g.start; k <= g.end; k++) colOf[k] = items.length
      i = g.end + 1
    } else {
      items.push({ kind: 'step', i })
      colOf[i] = items.length
      i++
    }
  }
  return { items, colOf }
}
