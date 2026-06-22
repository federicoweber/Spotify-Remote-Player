import type { Track } from '../spotify/types'

// Splitting tracks across fixed-length discs (e.g. MiniDisc 60/74/80 min).
// Greedy fill: keep adding tracks to the current disc until the next track
// would overflow the capacity, then start a new disc. A single track longer
// than the capacity gets its own disc (it can't be split).

export interface DiscPlan {
  /** 1-based disc number for each track, aligned to the input array. */
  discOf: number[]
  /** Number of discs (0 if there are no tracks). */
  count: number
  /** Total runtime in ms for each disc, indexed [disc-1]. */
  durations: number[]
}

export function planDiscs(tracks: Track[], capacityMs: number): DiscPlan {
  return planFromBreaks(tracks, breaksFromCapacity(tracks, capacityMs))
}

/**
 * Track indices at which a new disc begins (sorted, 1-based positions in the
 * list). e.g. [4, 9] → disc 1 = tracks 0–3, disc 2 = 4–8, disc 3 = 9+.
 */
export function breaksFromCapacity(tracks: Track[], capacityMs: number): number[] {
  if (capacityMs <= 0) return []
  const breaks: number[] = []
  let acc = 0
  for (let i = 0; i < tracks.length; i++) {
    const d = tracks[i].duration_ms || 0
    if (acc > 0 && acc + d > capacityMs) {
      breaks.push(i)
      acc = 0
    }
    acc += d
  }
  return breaks
}

/** Build a disc plan from explicit break points (manual or auto-derived). */
export function planFromBreaks(tracks: Track[], breaks: number[]): DiscPlan {
  const sorted = [...breaks].sort((a, b) => a - b)
  const discOf: number[] = []
  const durations: number[] = []
  let disc = 1
  let bi = 0
  for (let i = 0; i < tracks.length; i++) {
    while (bi < sorted.length && sorted[bi] === i) {
      disc++
      bi++
    }
    discOf.push(disc)
    durations[disc - 1] = (durations[disc - 1] || 0) + (tracks[i].duration_ms || 0)
  }
  return { discOf, count: tracks.length ? disc : 0, durations }
}
