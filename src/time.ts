import { TIMEZONE } from './env.js'

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function formatLocal(ts: number): string {
  const parts = dateTimeFormatter.formatToParts(new Date(ts))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

export function formatLocalWithZone(ts: number): string {
  return `${formatLocal(ts)} ${TIMEZONE}`
}
