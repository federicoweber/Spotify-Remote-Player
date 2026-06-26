// Minimal Spotify Web API types — only the fields this app actually reads.
// Full schemas: https://developer.spotify.com/documentation/web-api/reference

export interface Image {
  url: string
  height: number | null
  width: number | null
}

export interface SimpleArtist {
  id: string
  name: string
}

/** Lightweight album reference carried on full track objects (e.g. playlist items). */
export interface AlbumRef {
  id: string
  name: string
  images: Image[]
}

export interface Track {
  id: string
  uri: string
  name: string
  duration_ms: number
  track_number: number
  disc_number: number
  artists: SimpleArtist[]
  is_playable?: boolean
  /** Present on full tracks (playlist items); absent on album's simplified tracks. */
  album?: AlbumRef
}

export interface Paging<T> {
  items: T[]
  next: string | null
  total: number
  limit: number
  offset: number
}

export interface Album {
  id: string
  uri: string
  name: string
  album_type: string
  total_tracks: number
  release_date: string
  images: Image[]
  artists: SimpleArtist[]
  tracks: Paging<Track>
}

export interface SavedAlbum {
  added_at: string
  album: Album
}

export interface SimplifiedPlaylist {
  id: string
  uri: string
  name: string
  description: string | null
  images: Image[]
  owner: { id: string; display_name: string | null }
  // Newer Spotify API exposes the track-collection ref under `items`; older
  // responses use `tracks`. Both are { href, total }.
  tracks?: { href: string; total: number }
  items?: { href: string; total: number }
}

/**
 * An entry in a playlist. Newer API nests the track/episode under `item`;
 * older responses use `track`. Either is null for removed entries.
 */
export interface PlaylistTrackItem {
  item?: Track | null
  track?: Track | null
  is_local?: boolean
}

/** What the sequencer is playing — an album or a playlist, generalized. */
export interface PlaybackSource {
  kind: 'album' | 'playlist'
  id: string
  name: string
  images: Image[]
}

export interface SpotifyUser {
  id: string
  display_name: string | null
  email?: string
  product?: string // "premium" | "free" | ...
  images: Image[]
}

export interface Device {
  id: string | null
  name: string
  type: string
  is_active: boolean
  is_restricted: boolean
  volume_percent: number | null
  supports_volume?: boolean
}

export interface PlaybackState {
  device: Device | null
  is_playing: boolean
  progress_ms: number | null
  item: Track | null
  shuffle_state?: boolean
  repeat_state?: string
}
