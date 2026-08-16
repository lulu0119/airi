/**
 * Computes the current monthly period window anchored to a subscription start.
 *
 * Matches OpenCode `getMonthlyBounds`: UTC day/time from `subscribed`, clamp
 * short months, and when this month's anchor is still in the future, use the
 * previous month as the start.
 *
 * @example
 * getMonthlyBounds(new Date('2024-03-15T12:00:00Z'), new Date('2024-01-31T08:00:00Z'))
 * // => { start: 2024-02-29T08:00:00Z, end: 2024-03-31T08:00:00Z }
 */
export function getMonthlyBounds(now: Date, subscribed: Date): { start: Date, end: Date } {
  const day = subscribed.getUTCDate()
  const hours = subscribed.getUTCHours()
  const minutes = subscribed.getUTCMinutes()
  const seconds = subscribed.getUTCSeconds()
  const milliseconds = subscribed.getUTCMilliseconds()

  function anchor(year: number, month: number): Date {
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return new Date(Date.UTC(year, month, Math.min(day, maxDay), hours, minutes, seconds, milliseconds))
  }

  function shift(year: number, month: number, delta: number): readonly [number, number] {
    const total = year * 12 + month + delta
    return [Math.floor(total / 12), ((total % 12) + 12) % 12] as const
  }

  let year = now.getUTCFullYear()
  let month = now.getUTCMonth()
  let start = anchor(year, month)
  if (start > now) {
    ;[year, month] = shift(year, month, -1)
    start = anchor(year, month)
  }
  const [nextYear, nextMonth] = shift(year, month, 1)
  const end = anchor(nextYear, nextMonth)
  return { start, end }
}

export type Clock = () => Date

export const systemClock: Clock = () => new Date()
