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
  const discOf: number[] = []
  const durations: number[] = []
  const splitting = capacityMs > 0

  let disc = 1
  let acc = 0
  for (const track of tracks) {
    const d = track.duration_ms || 0
    if (splitting && acc > 0 && acc + d > capacityMs) {
      disc++
      acc = 0
    }
    discOf.push(disc)
    durations[disc - 1] = (durations[disc - 1] || 0) + d
    acc += d
  }

  return { discOf, count: tracks.length ? disc : 0, durations }
}
