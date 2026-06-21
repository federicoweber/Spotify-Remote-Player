import type { Image, SimpleArtist } from '../spotify/types'

/** Milliseconds → "m:ss". */
export function msToClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export function artistsText(artists: SimpleArtist[]): string {
  return artists.map((a) => a.name).join(', ')
}

/** Total runtime of a set of tracks, rounded to whole minutes, e.g. "64 min". */
export function totalMinutesLabel(tracks: { duration_ms: number }[]): string {
  const totalMs = tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0)
  const minutes = Math.max(1, Math.round(totalMs / 60000))
  return `${minutes} min`
}

/** Pick a cover image roughly matching the desired edge size (px). */
export function albumImage(images: Image[], preferred = 300): string {
  if (!images.length) return ''
  const sorted = [...images].sort(
    (a, b) => (a.width ?? 0) - (b.width ?? 0),
  )
  const match = sorted.find((img) => (img.width ?? 0) >= preferred)
  return (match ?? sorted[sorted.length - 1]).url
}

export function releaseYear(date: string): string {
  return date ? date.slice(0, 4) : ''
}
