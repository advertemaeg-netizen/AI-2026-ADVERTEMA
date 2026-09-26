/** Seconds → a short value + unit key for "12 s" / "2.5 min" / "1.2 h". */
export function durationParts(seconds: number): { value: number; unit: 'seconds' | 'minutes' | 'hours' } {
  if (seconds < 60) return { value: Math.round(seconds), unit: 'seconds' }
  if (seconds < 3600) return { value: Math.round((seconds / 60) * 10) / 10, unit: 'minutes' }
  return { value: Math.round((seconds / 3600) * 10) / 10, unit: 'hours' }
}
