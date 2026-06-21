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

export interface Track {
  id: string
  uri: string
  name: string
  duration_ms: number
  track_number: number
  disc_number: number
  artists: SimpleArtist[]
  is_playable?: boolean
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
