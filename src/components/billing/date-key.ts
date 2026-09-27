import { cairoParts, cairoWallTimeToIso } from '@/lib/cairo-time'

/** "YYYY-MM-DD" (Cairo) for <input type="date"> */
export function toDateKey(value: string | Date) {
  return cairoParts(value).dateKey
}

/** <input type="date"> value → ISO instant at that Cairo time of day */
export function dateKeyToIso(key: string, time = '00:00') {
  const [year, month, day] = key.split('-').map(Number)
  return cairoWallTimeToIso(year, month - 1, day, time)
}
