import { getAccessToken, logout } from './auth'
import type {
  Album,
  Device,
  PlaybackState,
  Paging,
  PlaylistTrackItem,
  SavedAlbum,
  SimplifiedPlaylist,
  SpotifyUser,
  Track,
} from './types'

const BASE = 'https://api.spotify.com/v1'

export class SpotifyApiError extends Error {
  status: number
  /** Spotify's machine-readable reason, e.g. NO_ACTIVE_DEVICE / PREMIUM_REQUIRED. */
  reason?: string
  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.name = 'SpotifyApiError'
    this.status = status
    this.reason = reason
  }
}

interface RequestOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Set true to skip a single 401-driven refresh+retry (internal use). */
  _retried?: boolean
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await getAccessToken()
  const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  // Rate limited — respect Retry-After then try once more.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '1')
    await sleep((retryAfter + 0.25) * 1000)
    return request<T>(path, opts)
  }

  // Token rejected — force a refresh and retry once.
  if (res.status === 401 && !opts._retried) {
    return request<T>(path, { ...opts, _retried: true })
  }
  if (res.status === 401) {
    logout()
    throw new SpotifyApiError(401, 'Session expired — please sign in again.')
  }

  if (res.status === 204 || res.status === 202) {
    return undefined as T
  }

  if (!res.ok) {
    const { message, reason } = await parseError(res)
    throw new SpotifyApiError(res.status, message, reason)
  }

  // Some endpoints (player commands) return 200 with an empty body.
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function parseError(
  res: Response,
): Promise<{ message: string; reason?: string }> {
  try {
    const data = await res.json()
    return {
      message: data?.error?.message ?? res.statusText,
      reason: data?.error?.reason,
    }
  } catch {
    return { message: res.statusText }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function getCurrentUser(): Promise<SpotifyUser> {
  return request<SpotifyUser>('/me')
}

// ---------------------------------------------------------------------------
// Library: every saved album (handles pagination).
// ---------------------------------------------------------------------------

export async function getAllSavedAlbums(
  onProgress?: (loaded: number, total: number) => void,
): Promise<SavedAlbum[]> {
  const all: SavedAlbum[] = []
  let page = await request<Paging<SavedAlbum>>('/me/albums', {
    query: { limit: 50, offset: 0 },
  })
  all.push(...page.items)
  onProgress?.(all.length, page.total)

  while (page.next) {
    page = await request<Paging<SavedAlbum>>(page.next)
    all.push(...page.items)
    onProgress?.(all.length, page.total)
  }
  return all
}

/**
 * Returns every track URI for an album, in order. The saved-albums payload
 * already includes the first 50 tracks; only multi-disc / >50-track albums
 * need extra pages.
 */
export async function getAlbumTracks(album: Album): Promise<Track[]> {
  const tracks = [...album.tracks.items]
  let next = album.tracks.next
  while (next) {
    const page = await request<Paging<Track>>(next)
    tracks.push(...page.items)
    next = page.next
  }
  return tracks
}

// ---------------------------------------------------------------------------
// Library: every playlist the user owns or follows (handles pagination).
// ---------------------------------------------------------------------------

export async function getAllPlaylists(
  onProgress?: (loaded: number, total: number) => void,
): Promise<SimplifiedPlaylist[]> {
  const all: SimplifiedPlaylist[] = []
  let page = await request<Paging<SimplifiedPlaylist>>('/me/playlists', {
    query: { limit: 50, offset: 0 },
  })
  // The API occasionally returns null entries for unavailable playlists.
  all.push(...page.items.filter(Boolean))
  onProgress?.(all.length, page.total)

  while (page.next) {
    page = await request<Paging<SimplifiedPlaylist>>(page.next)
    all.push(...page.items.filter(Boolean))
    onProgress?.(all.length, page.total)
  }
  return all
}

/** Number of tracks in a playlist, across both API shapes. */
export function playlistTotal(p: SimplifiedPlaylist): number {
  return p.items?.total ?? p.tracks?.total ?? 0
}

/**
 * Returns every playable track of a playlist, in order. Skips removed entries,
 * local files, and podcast episodes (only `spotify:track:` URIs are kept).
 *
 * Uses the `/items` endpoint: the older `/tracks` endpoint now returns 403 for
 * newer apps. Each entry's track is under `item` (newer) or `track` (older).
 */
export async function getPlaylistTracks(playlistId: string): Promise<Track[]> {
  const tracks: Track[] = []
  const collect = (items: PlaylistTrackItem[]): void => {
    for (const entry of items) {
      const t = entry?.item ?? entry?.track
      if (t && t.uri && t.uri.startsWith('spotify:track:')) tracks.push(t)
    }
  }

  let page = await request<Paging<PlaylistTrackItem>>(
    `/playlists/${playlistId}/items`,
    { query: { limit: 100, offset: 0, additional_types: 'track' } },
  )
  collect(page.items)
  while (page.next) {
    page = await request<Paging<PlaylistTrackItem>>(page.next)
    collect(page.items)
  }
  return tracks
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export async function getDevices(): Promise<Device[]> {
  const data = await request<{ devices: Device[] }>('/me/player/devices')
  return data.devices ?? []
}

export function getPlaybackState(): Promise<PlaybackState | undefined> {
  // Returns 204 (→ undefined) when nothing is active.
  return request<PlaybackState | undefined>('/me/player')
}

/** Start (or replace) playback on a device with explicit track URIs. */
export function playUris(
  deviceId: string,
  uris: string[],
  positionMs = 0,
): Promise<void> {
  return request<void>('/me/player/play', {
    method: 'PUT',
    query: { device_id: deviceId },
    body: { uris, position_ms: positionMs },
  })
}

/** Resume whatever is already loaded on the device. */
export function resume(deviceId: string): Promise<void> {
  return request<void>('/me/player/play', {
    method: 'PUT',
    query: { device_id: deviceId },
  })
}

export function pause(deviceId: string): Promise<void> {
  return request<void>('/me/player/pause', {
    method: 'PUT',
    query: { device_id: deviceId },
  })
}

export function transferPlayback(deviceId: string, play = false): Promise<void> {
  return request<void>('/me/player', {
    method: 'PUT',
    body: { device_ids: [deviceId], play },
  })
}
