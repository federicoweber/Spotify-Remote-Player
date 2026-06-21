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
