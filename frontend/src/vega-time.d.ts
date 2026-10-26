// vega-time ships without type declarations; only what the dashboard uses.
declare module 'vega-time' {
  /** A function flooring a date to the start of its bucket for these units, in local time (as Vega-Lite's timeUnit does). */
  export function timeFloor(units: string[], step?: number): (d: Date) => Date
}
