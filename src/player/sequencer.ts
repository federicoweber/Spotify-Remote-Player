import * as api from '../spotify/api'
import { SpotifyApiError } from '../spotify/api'
import { planDiscs } from './discs'
import type { PlaybackSource, Track } from '../spotify/types'

// Spotify has no native "gap between songs" feature, so we drive the album
// ourselves: play ONE track at a time (uris: [trackUri], no context), watch it
// to the end via the player API, then wait the configured interval before
// starting the next track. All audio decodes on the chosen Connect device, so
// a device set to "Lossless" plays losslessly — we only send commands.

export type SequencerState =
  | 'idle'
  | 'playing'
  | 'interval'
  | 'discchange'
  | 'paused'
  | 'done'

export interface SequencerSnapshot {
  state: SequencerState
  source: PlaybackSource | null
  tracks: Track[]
  index: number
  currentTrack: Track | null
  progressMs: number
  durationMs: number
  intervalMs: number
  intervalRemainingMs: number
  /** 'playing' or 'interval' when state === 'paused', else null */
  pausedFrom: 'playing' | 'interval' | null
  /** Disc the current track lives on (1-based), and total disc count. */
  currentDisc: number
  discCount: number
  /** Set while state === 'discchange': which disc to swap from/to. */
  pendingDiscChange: { from: number; to: number } | null
  deviceId: string | null
  error: string | null
}

const POLL_MS = 1000
// If the device reports it stopped within this margin of the track's end, treat
// the track as finished (rather than as an external pause).
const END_GRACE_MS = 2500
// How many idle polls to tolerate before declaring the device never started.
const MAX_START_WAIT = 8
// How many "wrong track" polls to tolerate before declaring external takeover.
const MAX_MISMATCH = 4

type Listener = (snap: SequencerSnapshot) => void

export class AlbumSequencer {
  private state: SequencerState = 'idle'
  private source: PlaybackSource | null = null
  private tracks: Track[] = []
  private index = 0

  private deviceId: string | null = null
  private intervalMs = 5000
  private discCapacityMs = 74 * 60_000 // MiniDisc default (74 min)
  private discOf: number[] = []
  private discCount = 0
  private pendingDiscChange: { from: number; to: number } | null = null

  private progressMs = 0
  private durationMs = 0
  private intervalRemainingMs = 0
  private intervalEndsAt = 0
  private pausedFrom: 'playing' | 'interval' | null = null
  private error: string | null = null

  // Per-track transient detection state.
  private hasPlayed = false
  private startWait = 0
  private mismatch = 0

  // Timers.
  private pollHandle: number | undefined
  private endTimer: number | undefined
  private intervalTicker: number | undefined

  private listeners = new Set<Listener>()

  // --- subscription ---------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const fn of this.listeners) fn(snap)
  }

  snapshot(): SequencerSnapshot {
    return {
      state: this.state,
      source: this.source,
      tracks: this.tracks,
      index: this.index,
      currentTrack: this.tracks[this.index] ?? null,
      progressMs: this.progressMs,
      durationMs: this.durationMs,
      intervalMs: this.intervalMs,
      intervalRemainingMs: this.intervalRemainingMs,
      pausedFrom: this.pausedFrom,
      currentDisc: this.discOf[this.index] ?? 1,
      discCount: this.discCount || (this.tracks.length ? 1 : 0),
      pendingDiscChange: this.pendingDiscChange,
      deviceId: this.deviceId,
      error: this.error,
    }
  }

  // --- public controls ------------------------------------------------------

  start(opts: {
    source: PlaybackSource
    tracks: Track[]
    deviceId: string
    intervalSec: number
    discCapacityMin?: number
    startIndex?: number
  }): void {
    this.stopAllTimers()
    this.source = opts.source
    this.tracks = opts.tracks
    this.deviceId = opts.deviceId
    this.intervalMs = secondsToMs(opts.intervalSec)
    if (opts.discCapacityMin !== undefined) {
      this.discCapacityMs = minutesToMs(opts.discCapacityMin)
    }
    this.index = opts.startIndex ?? 0
    this.pendingDiscChange = null
    this.error = null
    this.replanDiscs()
    void this.playCurrent()
  }

  pauseResume(): void {
    if (this.state === 'paused') this.resume()
    else this.pause()
  }

  pause(): void {
    if (this.state === 'playing') {
      this.stopPolling()
      this.clearEndTimer()
      this.pausedFrom = 'playing'
      this.state = 'paused'
      this.safePause()
      this.emit()
    } else if (this.state === 'interval') {
      this.clearIntervalTicker()
      this.intervalRemainingMs = Math.max(0, this.intervalEndsAt - Date.now())
      this.pausedFrom = 'interval'
      this.state = 'paused'
      this.emit()
    }
  }

  resume(): void {
    if (this.state !== 'paused') return
    if (this.pausedFrom === 'interval') {
      this.pausedFrom = null
      this.state = 'interval'
      this.intervalEndsAt = Date.now() + this.intervalRemainingMs
      this.startIntervalTicker()
      this.emit()
    } else {
      this.pausedFrom = null
      this.state = 'playing'
      this.hasPlayed = true
      this.emit()
      api
        .resume(this.deviceId!)
        .then(() => this.startPolling())
        .catch((e) => this.fail(friendlyError(e)))
    }
  }

  /** Skip to the next track immediately (skips the rest of the song + any gap). */
  next(): void {
    this.stopAllTimers()
    if (this.index >= this.tracks.length - 1) {
      this.finish()
      return
    }
    this.index++
    void this.playCurrent()
  }

  previous(): void {
    this.stopAllTimers()
    this.index = Math.max(0, this.index - 1)
    void this.playCurrent()
  }

  /** If currently in the gap, jump straight to the next track. */
  skipInterval(): void {
    const counting =
      this.state === 'interval' ||
      (this.state === 'paused' && this.pausedFrom === 'interval')
    if (!counting) return
    this.clearIntervalTicker()
    this.advance()
  }

  stop(): void {
    this.stopAllTimers()
    this.state = 'idle'
    this.pausedFrom = null
    this.pendingDiscChange = null
    this.progressMs = 0
    this.intervalRemainingMs = 0
    this.safePause()
    this.emit()
  }

  /** Change the gap length; applies to the current countdown and future gaps. */
  setIntervalSeconds(sec: number): void {
    const next = secondsToMs(sec)
    if (this.state === 'interval') {
      // Re-base the running countdown around how long it's already been waiting.
      const elapsed = this.intervalMs - Math.max(0, this.intervalEndsAt - Date.now())
      this.intervalEndsAt = Date.now() + Math.max(0, next - elapsed)
    }
    this.intervalMs = next
    this.emit()
  }

  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId
  }

  /** Set MiniDisc capacity in minutes (0 = no splitting). Re-plans live. */
  setDiscCapacityMinutes(min: number): void {
    this.discCapacityMs = minutesToMs(min)
    this.replanDiscs()
    this.emit()
  }

  private replanDiscs(): void {
    const plan = planDiscs(this.tracks, this.discCapacityMs)
    this.discOf = plan.discOf
    this.discCount = plan.count
  }

  // --- internal state machine ----------------------------------------------

  private async playCurrent(): Promise<void> {
    const track = this.tracks[this.index]
    if (!track) {
      this.finish()
      return
    }
    this.state = 'playing'
    this.pausedFrom = null
    this.pendingDiscChange = null
    this.progressMs = 0
    this.durationMs = track.duration_ms
    this.hasPlayed = false
    this.startWait = 0
    this.mismatch = 0
    this.error = null
    this.emit()

    try {
      await api.playUris(this.deviceId!, [track.uri])
    } catch (e) {
      this.fail(friendlyError(e))
      return
    }
    this.startPolling()
  }

  private async poll(): Promise<void> {
    if (this.state !== 'playing') return

    let st
    try {
      st = await api.getPlaybackState()
    } catch {
      return // transient network/API hiccup — try again next tick
    }
    if (this.state !== 'playing') return // state changed while awaiting

    const cur = this.tracks[this.index]
    const item = st?.item

    if (item && cur && item.id === cur.id) {
      this.mismatch = 0
      this.progressMs = st!.progress_ms ?? 0
      this.durationMs = item.duration_ms

      if (st!.is_playing) {
        this.hasPlayed = true
        this.startWait = 0
        const remaining = this.durationMs - this.progressMs
        this.clearEndTimer()
        if (remaining <= 0) {
          this.onTrackEnd()
          return
        }
        this.endTimer = window.setTimeout(() => this.onTrackEnd(), remaining)
      } else {
        this.clearEndTimer()
        if (this.progressMs >= this.durationMs - END_GRACE_MS) {
          this.onTrackEnd()
          return
        }
        if (this.hasPlayed) {
          // Paused directly on the device — mirror that state.
          this.stopPolling()
          this.pausedFrom = 'playing'
          this.state = 'paused'
        }
        // else: brief stop right after the play command — keep waiting.
      }
      this.emit()
      return
    }

    // The expected track isn't (yet) what's on the device.
    if (this.hasPlayed) {
      // It was playing and now it's gone/changed → the track finished.
      this.onTrackEnd()
      return
    }
    if (item) {
      // Something else is playing — the device may not have picked up our
      // command yet, or playback was taken over externally.
      this.mismatch++
      if (this.mismatch >= MAX_MISMATCH) {
        this.fail('Playback was changed on the selected device.')
      }
    } else {
      // Device idle, still waiting for our command to take effect.
      this.startWait++
      if (this.startWait >= MAX_START_WAIT) {
        this.fail(
          'The device never started playback. Make sure Spotify is open and active on it.',
        )
      }
    }
    this.emit()
  }

  private onTrackEnd(): void {
    if (this.state !== 'playing') return // guard against poll + endTimer racing
    this.stopPolling()
    this.clearEndTimer()
    this.progressMs = this.durationMs
    if (this.index >= this.tracks.length - 1) {
      this.finish()
      return
    }
    const nextIdx = this.index + 1
    const fromDisc = this.discOf[this.index] ?? 1
    const toDisc = this.discOf[nextIdx] ?? 1
    if (toDisc !== fromDisc) {
      this.startDiscChange(fromDisc, toDisc)
    } else {
      this.startInterval()
    }
  }

  private startDiscChange(from: number, to: number): void {
    this.state = 'discchange'
    this.pendingDiscChange = { from, to }
    // Stop the device so nothing plays while the disc is being swapped.
    this.safePause()
    this.emit()
  }

  /** User confirmed they swapped the disc — continue with the next track. */
  confirmDiscChange(): void {
    if (this.state !== 'discchange') return
    this.pendingDiscChange = null
    this.advance() // no inter-track gap across a disc boundary
  }

  private startInterval(): void {
    if (this.intervalMs <= 0) {
      this.advance()
      return
    }
    this.state = 'interval'
    this.intervalEndsAt = Date.now() + this.intervalMs
    this.intervalRemainingMs = this.intervalMs
    // A single-track play already stops at the end, but pause defensively.
    this.safePause()
    this.startIntervalTicker()
    this.emit()
  }

  private startIntervalTicker(): void {
    this.clearIntervalTicker()
    this.intervalTicker = window.setInterval(() => {
      const remaining = this.intervalEndsAt - Date.now()
      this.intervalRemainingMs = Math.max(0, remaining)
      if (remaining <= 0) {
        this.clearIntervalTicker()
        this.advance()
      } else {
        this.emit()
      }
    }, 200)
  }

  private advance(): void {
    this.index++
    void this.playCurrent()
  }

  private finish(): void {
    this.stopAllTimers()
    this.state = 'done'
    this.pausedFrom = null
    this.pendingDiscChange = null
    this.intervalRemainingMs = 0
    this.emit()
  }

  private fail(message: string): void {
    this.stopAllTimers()
    this.error = message
    this.state = 'idle'
    this.pendingDiscChange = null
    this.emit()
  }

  // --- helpers --------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling()
    this.pollHandle = window.setInterval(() => void this.poll(), POLL_MS)
    // Kick off an early poll so progress/end-detection sync sooner than 1s.
    window.setTimeout(() => void this.poll(), 500)
  }

  private stopPolling(): void {
    if (this.pollHandle !== undefined) {
      clearInterval(this.pollHandle)
      this.pollHandle = undefined
    }
  }

  private clearEndTimer(): void {
    if (this.endTimer !== undefined) {
      clearTimeout(this.endTimer)
      this.endTimer = undefined
    }
  }

  private clearIntervalTicker(): void {
    if (this.intervalTicker !== undefined) {
      clearInterval(this.intervalTicker)
      this.intervalTicker = undefined
    }
  }

  private stopAllTimers(): void {
    this.stopPolling()
    this.clearEndTimer()
    this.clearIntervalTicker()
  }

  private safePause(): void {
    if (this.deviceId) api.pause(this.deviceId).catch(() => {})
  }
}

function secondsToMs(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0
  return Math.round(sec * 1000)
}

function minutesToMs(min: number): number {
  if (!Number.isFinite(min) || min <= 0) return 0
  return Math.round(min * 60_000)
}

function friendlyError(e: unknown): string {
  if (e instanceof SpotifyApiError) {
    if (e.reason === 'PREMIUM_REQUIRED' || e.status === 403) {
      return 'Controlling playback requires Spotify Premium.'
    }
    if (e.reason === 'NO_ACTIVE_DEVICE' || e.status === 404) {
      return 'No active device. Pick a device and make sure Spotify is open on it.'
    }
    return e.message
  }
  return e instanceof Error ? e.message : 'Unexpected playback error.'
}
