import './style.css'
import * as auth from './spotify/auth'
import * as api from './spotify/api'
import { SpotifyApiError } from './spotify/api'
import { AlbumSequencer } from './player/sequencer'
import type { SequencerSnapshot } from './player/sequencer'
import { planDiscs } from './player/discs'
import { el, clear } from './ui/dom'
import {
  albumImage,
  artistsText,
  msToClock,
  releaseYear,
  totalMinutesLabel,
} from './ui/format'
import type {
  Album,
  Device,
  PlaybackSource,
  SavedAlbum,
  SimplifiedPlaylist,
  SpotifyUser,
  Track,
} from './spotify/types'

const root = document.getElementById('app')!
const sequencer = new AlbumSequencer()

const DISC_OPTIONS = [0, 60, 74, 80] // 0 = off; 60/74/80 = MiniDisc lengths

// ---- app state ------------------------------------------------------------
let user: SpotifyUser | null = null
let albums: SavedAlbum[] = []
let playlists: SimplifiedPlaylist[] = []
let playlistsLoaded = false
let libraryMode: 'albums' | 'playlists' = 'albums'
let devices: Device[] = []
let selectedDeviceId: string | null = null
let intervalSec = 5
let discCapacityMin = 74
let filterText = ''
let detail: {
  source: PlaybackSource
  tracks: Track[]
  totalCount: number
  subtitle: string
  loading: boolean
  error?: string
} | null = null

// ---- stable section containers (built once in renderShell) ----------------
let headerEl: HTMLElement
let controlsEl: HTMLElement
let libraryEl: HTMLElement
let nowPlayingEl: HTMLElement
let modalEl: HTMLElement

void bootstrap()

async function bootstrap(): Promise<void> {
  try {
    await auth.handleRedirectCallback()
  } catch (e) {
    renderLogin(messageOf(e))
    return
  }

  if (!auth.isLoggedIn()) {
    renderLogin()
    return
  }

  renderShell()
  sequencer.subscribe(updateNowPlaying)

  try {
    user = await api.getCurrentUser()
  } catch (e) {
    if (e instanceof SpotifyApiError && e.status === 401) {
      auth.logout()
      renderLogin('Your session expired. Please sign in again.')
      return
    }
    updateControls(messageOf(e))
  }
  updateHeader()
  updateControls()

  await Promise.all([loadDevices(), loadAlbums()])
}

// ===========================================================================
// Login view
// ===========================================================================

function renderLogin(error?: string): void {
  clear(root)
  const clientIdInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'Spotify Client ID',
    value: auth.getClientId(),
    spellcheck: 'false',
    autocapitalize: 'off',
  }) as HTMLInputElement

  const connectBtn = el('button', {
    class: 'btn btn-primary btn-lg',
    text: 'Connect Spotify',
    onclick: async () => {
      auth.setClientId(clientIdInput.value)
      if (!clientIdInput.value.trim()) {
        showLoginError('Enter your Spotify app Client ID first.')
        return
      }
      try {
        await auth.login()
      } catch (e) {
        showLoginError(messageOf(e))
      }
    },
  })

  const errorBox = el('div', {
    class: 'login-error',
    text: error ?? '',
    hidden: !error,
  })
  function showLoginError(msg: string): void {
    errorBox.textContent = msg
    errorBox.hidden = false
  }

  const card = el('div', { class: 'login-card' }, [
    el('div', { class: 'brand brand-lg' }, [
      el('span', { class: 'brand-mark', text: '◐' }),
      el('span', { text: 'Album Sequencer' }),
    ]),
    el('p', {
      class: 'muted',
      text: 'Browse your saved albums and playlists, then dub them to a Connect device with a custom gap between tracks and MiniDisc-length disc splitting.',
    }),
    errorBox,
    el('label', { class: 'field-label', text: 'Client ID' }),
    clientIdInput,
    el('p', { class: 'muted small', text: `Redirect URI: ${auth.getRedirectUri()}` }),
    connectBtn,
    el('div', { class: 'login-help' }, [
      el('p', { class: 'muted small', html:
        'Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">developer.spotify.com/dashboard</a>, add the redirect URI above to it, then paste the Client ID here.' }),
      el('p', { class: 'muted small', text:
        'Playback control requires Spotify Premium. For lossless audio, set your Spotify desktop app to "Lossless" and pick it as the device.' }),
    ]),
  ])

  root.append(el('div', { class: 'login-wrap' }, [card]))
}

// ===========================================================================
// Main app shell
// ===========================================================================

function renderShell(): void {
  clear(root)
  headerEl = el('header', { class: 'topbar' })
  controlsEl = el('section', { class: 'controls' })
  libraryEl = el('section', { class: 'albums' })
  nowPlayingEl = el('footer', { class: 'nowplaying', hidden: true })
  modalEl = el('div', { class: 'modal-backdrop', hidden: true })

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeDetail()
  })

  root.append(
    headerEl,
    el('main', { class: 'content' }, [controlsEl, libraryEl]),
    nowPlayingEl,
    modalEl,
  )
}

function updateHeader(): void {
  clear(headerEl)
  const avatarUrl = user?.images?.[0]?.url
  headerEl.append(
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark', text: '◐' }),
      el('span', { text: 'Album Sequencer' }),
    ]),
    el('div', { class: 'user' }, [
      avatarUrl ? el('img', { class: 'avatar', src: avatarUrl, alt: '' }) : null,
      el('span', { class: 'user-name', text: user?.display_name ?? '' }),
      el('button', {
        class: 'btn btn-ghost',
        text: 'Log out',
        onclick: () => {
          auth.logout()
          location.assign('/')
        },
      }),
    ]),
  )
}

function updateControls(notice?: string): void {
  clear(controlsEl)

  // Device picker
  const deviceSelect = el('select', { class: 'field select' }) as HTMLSelectElement
  if (devices.length === 0) {
    deviceSelect.append(el('option', { value: '', text: 'No devices found' }))
    deviceSelect.disabled = true
  } else {
    for (const d of devices) {
      const label = `${d.name} · ${d.type}${d.is_active ? ' (active)' : ''}`
      deviceSelect.append(el('option', { value: d.id ?? '', text: label }))
    }
    deviceSelect.value = selectedDeviceId ?? ''
    deviceSelect.disabled = false
  }
  deviceSelect.addEventListener('change', () => {
    selectedDeviceId = deviceSelect.value || null
    if (selectedDeviceId) sequencer.setDeviceId(selectedDeviceId)
  })

  const refreshBtn = el('button', {
    class: 'btn btn-ghost',
    text: '↻ Devices',
    title: 'Refresh device list',
    onclick: () => void loadDevices(),
  })

  // Inter-track gap
  const intervalInput = el('input', {
    class: 'field interval-input',
    type: 'number',
    min: '0',
    step: '0.5',
    value: String(intervalSec),
  }) as HTMLInputElement
  intervalInput.addEventListener('change', () => {
    const val = Number(intervalInput.value)
    intervalSec = Number.isFinite(val) && val >= 0 ? val : 0
    intervalInput.value = String(intervalSec)
    sequencer.setIntervalSeconds(intervalSec)
  })

  // Disc capacity (MiniDisc length)
  const discSelect = el('select', { class: 'field select' }) as HTMLSelectElement
  for (const opt of DISC_OPTIONS) {
    discSelect.append(
      el('option', { value: String(opt), text: opt === 0 ? 'Off' : `${opt} min` }),
    )
  }
  discSelect.value = String(discCapacityMin)
  discSelect.addEventListener('change', () => {
    discCapacityMin = Number(discSelect.value)
    sequencer.setDiscCapacityMinutes(discCapacityMin)
    if (detail) renderDetail()
  })

  controlsEl.append(
    el('div', { class: 'control-group' }, [
      el('label', { class: 'field-label', text: 'Playback device' }),
      el('div', { class: 'control-row' }, [deviceSelect, refreshBtn]),
    ]),
    el('div', { class: 'control-group control-narrow' }, [
      el('label', { class: 'field-label', text: 'Gap between songs (seconds)' }),
      intervalInput,
    ]),
    el('div', { class: 'control-group control-narrow' }, [
      el('label', { class: 'field-label', text: 'Disc capacity (MiniDisc)' }),
      discSelect,
    ]),
  )

  const premiumWarning =
    user && user.product && user.product !== 'premium'
      ? 'Your account is not Premium — Spotify only allows playback control on Premium accounts.'
      : null
  for (const msg of [notice, premiumWarning].filter(Boolean) as string[]) {
    controlsEl.append(el('div', { class: 'notice', text: msg }))
  }
}

// ===========================================================================
// Library (Albums / Playlists tabs)
// ===========================================================================

function updateLibrary(): void {
  clear(libraryEl)

  const tabs = el('div', { class: 'tabs' }, [
    libraryTab('albums', `Albums${albums.length ? ` (${albums.length})` : ''}`),
    libraryTab(
      'playlists',
      `Playlists${playlistsLoaded ? ` (${playlists.length})` : ''}`,
    ),
  ])

  const search = el('input', {
    class: 'field search',
    type: 'search',
    placeholder: libraryMode === 'albums' ? 'Filter albums…' : 'Filter playlists…',
    value: filterText,
  }) as HTMLInputElement
  search.addEventListener('input', () => {
    filterText = search.value.toLowerCase()
    renderGrid()
  })

  libraryEl.append(el('div', { class: 'albums-header' }, [tabs, search]))
  const grid = el('div', { class: 'grid' })
  libraryEl.append(grid)

  function renderGrid(): void {
    clear(grid)
    if (libraryMode === 'albums') {
      const filtered = albums.filter(({ album }) =>
        matches(album.name, artistsText(album.artists)),
      )
      if (!filtered.length) return void grid.append(emptyNote())
      for (const saved of filtered) grid.append(albumCard(saved))
    } else {
      const filtered = playlists.filter((p) =>
        matches(p.name, p.owner.display_name ?? ''),
      )
      if (!filtered.length) return void grid.append(emptyNote())
      for (const p of filtered) grid.append(playlistCard(p))
    }
  }
  renderGrid()
}

function matches(...fields: string[]): boolean {
  if (!filterText) return true
  return fields.some((f) => f.toLowerCase().includes(filterText))
}

function emptyNote(): HTMLElement {
  return el('p', { class: 'muted', text: 'Nothing matches.' })
}

function libraryTab(mode: 'albums' | 'playlists', label: string): HTMLElement {
  return el('button', {
    class: `tab${libraryMode === mode ? ' tab-active' : ''}`,
    text: label,
    onclick: async () => {
      if (libraryMode === mode) return
      libraryMode = mode
      filterText = ''
      if (mode === 'playlists' && !playlistsLoaded) {
        await loadPlaylists()
      } else {
        updateLibrary()
      }
    },
  })
}

function albumCard(saved: SavedAlbum): HTMLElement {
  const { album } = saved
  return mediaCard(
    albumImage(album.images, 300),
    album.name,
    `${artistsText(album.artists)} · ${releaseYear(album.release_date)}`,
    () => void openAlbum(album),
  )
}

function playlistCard(p: SimplifiedPlaylist): HTMLElement {
  return mediaCard(
    albumImage(p.images, 300),
    p.name,
    `${p.owner.display_name ?? 'Playlist'} · ${p.tracks.total} tracks`,
    () => void openPlaylist(p),
  )
}

function mediaCard(
  cover: string,
  title: string,
  sub: string,
  onClick: () => void,
): HTMLElement {
  return el('button', { class: 'card', onclick: onClick }, [
    cover
      ? el('img', { class: 'card-cover', src: cover, alt: '', loading: 'lazy' })
      : el('div', { class: 'card-cover card-cover-empty' }),
    el('div', { class: 'card-title', text: title, title }),
    el('div', { class: 'card-sub', text: sub }),
  ])
}

function showLibraryLoading(what: string, loaded: number, total: number): void {
  clear(libraryEl)
  libraryEl.append(
    el('div', { class: 'loading' }, [
      el('div', { class: 'spinner' }),
      el('p', {
        class: 'muted',
        text: total ? `Loading your ${what}… ${loaded}/${total}` : `Loading your ${what}…`,
      }),
    ]),
  )
}

// ===========================================================================
// Detail modal (album or playlist)
// ===========================================================================

async function openAlbum(album: Album): Promise<void> {
  detail = {
    source: { kind: 'album', id: album.id, name: album.name, images: album.images },
    tracks: album.tracks.items,
    totalCount: album.total_tracks,
    subtitle: `${artistsText(album.artists)} · ${releaseYear(album.release_date)}`,
    loading: album.tracks.items.length < album.total_tracks,
  }
  renderDetail()
  try {
    const tracks = await api.getAlbumTracks(album)
    if (detail?.source.id === album.id) {
      detail.tracks = tracks
      detail.loading = false
      renderDetail()
    }
  } catch (e) {
    if (detail?.source.id === album.id) {
      detail.loading = false
      detail.error = messageOf(e)
      renderDetail()
    }
  }
}

async function openPlaylist(p: SimplifiedPlaylist): Promise<void> {
  detail = {
    source: { kind: 'playlist', id: p.id, name: p.name, images: p.images },
    tracks: [],
    totalCount: p.tracks.total,
    subtitle: `by ${p.owner.display_name ?? p.owner.id}`,
    loading: true,
  }
  renderDetail()
  try {
    const tracks = await api.getPlaylistTracks(p.id)
    if (detail?.source.id === p.id) {
      detail.tracks = tracks
      detail.loading = false
      renderDetail()
    }
  } catch (e) {
    if (detail?.source.id === p.id) {
      detail.loading = false
      detail.error = messageOf(e)
      renderDetail()
    }
  }
}

function closeDetail(): void {
  detail = null
  modalEl.hidden = true
  clear(modalEl)
}

function renderDetail(): void {
  if (!detail) return
  const { source, tracks, totalCount, subtitle, loading, error } = detail
  clear(modalEl)
  modalEl.hidden = false

  const canPlay = Boolean(selectedDeviceId)
  const cover = albumImage(source.images, 300)
  const plan = planDiscs(tracks, discCapacityMin * 60_000)
  const isPlaylist = source.kind === 'playlist'

  const metaBits = [
    `${totalCount} tracks`,
    tracks.length ? totalMinutesLabel(tracks) : null,
    plan.count > 1 ? `${plan.count} discs` : null,
    subtitle,
  ].filter(Boolean) as string[]

  const playBtn = el('button', {
    class: 'btn btn-primary',
    text: isPlaylist ? '▶ Play playlist' : '▶ Play album',
    disabled: !canPlay || loading,
    title: canPlay ? '' : 'Select a device first',
    onclick: () => startPlaying(0),
  })

  const trackList = el('ol', { class: 'tracklist' })
  let lastDisc = 0
  tracks.forEach((track, i) => {
    const disc = plan.discOf[i] ?? 1
    if (plan.count > 1 && disc !== lastDisc) {
      lastDisc = disc
      trackList.append(
        el('li', { class: 'disc-divider' }, [
          el('span', { text: `Disc ${disc}` }),
          el('span', { class: 'muted small', text: msToClock(plan.durations[disc - 1] ?? 0) }),
        ]),
      )
    }
    trackList.append(
      el('li', { class: 'track' }, [
        el('span', { class: 'track-num', text: String(isPlaylist ? i + 1 : track.track_number || i + 1) }),
        el('div', { class: 'track-main' }, [
          el('div', { class: 'track-name', text: track.name, title: track.name }),
          isPlaylist
            ? el('div', { class: 'track-artist', text: artistsText(track.artists) })
            : null,
        ]),
        el('span', { class: 'track-dur', text: msToClock(track.duration_ms) }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: '▶',
          title: canPlay ? 'Play from here' : 'Select a device first',
          disabled: !canPlay,
          onclick: () => startPlaying(i),
        }),
      ]),
    )
  })

  modalEl.append(
    el('div', { class: 'modal' }, [
      el('button', { class: 'modal-close', text: '✕', onclick: () => closeDetail() }),
      el('div', { class: 'modal-head' }, [
        cover
          ? el('img', { class: 'modal-cover', src: cover, alt: '' })
          : el('div', { class: 'modal-cover card-cover-empty' }),
        el('div', { class: 'modal-meta' }, [
          el('h2', { class: 'modal-title', text: source.name }),
          el('p', { class: 'muted small', text: metaBits.join(' · ') }),
          el('div', { class: 'modal-actions' }, [
            playBtn,
            !canPlay
              ? el('span', { class: 'muted small', text: 'Pick a device above to enable playback.' })
              : null,
          ]),
        ]),
      ]),
      error ? el('div', { class: 'notice', text: error }) : null,
      loading ? el('p', { class: 'muted small', text: 'Loading full track list…' }) : null,
      trackList,
    ]),
  )
}

// ===========================================================================
// Playback wiring
// ===========================================================================

function startPlaying(startIndex: number): void {
  if (!detail || !selectedDeviceId || !detail.tracks.length) return
  sequencer.start({
    source: detail.source,
    tracks: detail.tracks,
    deviceId: selectedDeviceId,
    intervalSec,
    discCapacityMin,
    startIndex,
  })
  closeDetail()
}

function updateNowPlaying(snap: SequencerSnapshot): void {
  if (!nowPlayingEl) return

  if (snap.state === 'idle' && !snap.error) {
    nowPlayingEl.hidden = true
    clear(nowPlayingEl)
    return
  }

  nowPlayingEl.hidden = false
  clear(nowPlayingEl)

  if (snap.error) {
    nowPlayingEl.append(
      el('div', { class: 'np-error' }, [
        el('span', { text: `⚠ ${snap.error}` }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Dismiss', onclick: () => sequencer.stop() }),
      ]),
    )
    return
  }

  // Disc-change prompt takes over the whole bar.
  if (snap.state === 'discchange' && snap.pendingDiscChange) {
    const { from, to } = snap.pendingDiscChange
    nowPlayingEl.append(
      el('div', { class: 'np-discchange' }, [
        el('span', { class: 'np-disc-msg', html:
          `💿 <strong>Disc ${from} full.</strong> Insert disc ${to} of ${snap.discCount}, then confirm.` }),
        el('div', { class: 'np-controls' }, [
          el('button', { class: 'btn btn-primary', text: `Disc ${to} inserted → continue`, onclick: () => sequencer.confirmDiscChange() }),
          el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ Stop', onclick: () => sequencer.stop() }),
        ]),
      ]),
    )
    return
  }

  const track = snap.currentTrack
  const source = snap.source
  const cover =
    (track?.album?.images?.length ? albumImage(track.album.images, 100) : '') ||
    (source ? albumImage(source.images, 100) : '')
  const inInterval =
    snap.state === 'interval' ||
    (snap.state === 'paused' && snap.pausedFrom === 'interval')

  const pct = inInterval
    ? snap.intervalMs > 0
      ? 100 - (snap.intervalRemainingMs / snap.intervalMs) * 100
      : 100
    : snap.durationMs > 0
      ? (snap.progressMs / snap.durationMs) * 100
      : 0

  const barFill = el('div', { class: 'np-bar-fill' })
  barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`
  const bar = el('div', { class: inInterval ? 'np-bar np-bar-interval' : 'np-bar' }, [barFill])

  const statusText = inInterval
    ? `Gap · next in ${(snap.intervalRemainingMs / 1000).toFixed(1)}s`
    : snap.state === 'done'
      ? 'Finished'
      : snap.state === 'paused'
        ? 'Paused'
        : `${msToClock(snap.progressMs)} / ${msToClock(snap.durationMs)}`

  const isPaused = snap.state === 'paused'
  const isDone = snap.state === 'done'

  const discLabel =
    snap.discCount > 1 ? `Disc ${snap.currentDisc}/${snap.discCount} · ` : ''

  nowPlayingEl.append(
    el('div', { class: 'np-track' }, [
      cover ? el('img', { class: 'np-cover', src: cover, alt: '' }) : el('div', { class: 'np-cover card-cover-empty' }),
      el('div', { class: 'np-meta' }, [
        el('div', { class: 'np-name', text: track?.name ?? (isDone ? 'Done' : '—') }),
        el('div', { class: 'np-sub', text: track ? artistsText(track.artists) : source?.name ?? '' }),
      ]),
    ]),
    el('div', { class: 'np-center' }, [
      el('div', { class: 'np-status' }, [
        el('span', { class: 'np-count', text: source ? `${discLabel}Track ${snap.index + 1} / ${snap.tracks.length}` : '' }),
        el('span', { class: 'np-time', text: statusText }),
      ]),
      bar,
    ]),
    el('div', { class: 'np-controls' }, [
      el('button', { class: 'btn btn-ghost np-btn', text: '⏮', title: 'Previous track', disabled: isDone, onclick: () => sequencer.previous() }),
      el('button', { class: 'btn btn-primary np-btn np-play', text: isPaused ? '▶' : '⏸', title: isPaused ? 'Resume' : 'Pause', disabled: isDone, onclick: () => sequencer.pauseResume() }),
      el('button', { class: 'btn btn-ghost np-btn', text: '⏭', title: 'Next track', disabled: isDone, onclick: () => sequencer.next() }),
      inInterval ? el('button', { class: 'btn btn-ghost btn-sm', text: 'Skip gap', onclick: () => sequencer.skipInterval() }) : null,
      el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ Stop', onclick: () => sequencer.stop() }),
    ]),
  )
}

// ===========================================================================
// Data loading
// ===========================================================================

async function loadDevices(): Promise<void> {
  try {
    devices = await api.getDevices()
    const active = devices.find((d) => d.is_active)
    if (!selectedDeviceId || !devices.some((d) => d.id === selectedDeviceId)) {
      selectedDeviceId = active?.id ?? devices[0]?.id ?? null
    }
    if (selectedDeviceId) sequencer.setDeviceId(selectedDeviceId)
  } catch (e) {
    devices = []
    updateControls(messageOf(e))
    return
  }
  updateControls()
}

async function loadAlbums(): Promise<void> {
  if (libraryMode === 'albums') showLibraryLoading('albums', 0, 0)
  try {
    albums = await api.getAllSavedAlbums((loaded, total) => {
      if (libraryMode === 'albums') showLibraryLoading('albums', loaded, total)
    })
  } catch (e) {
    clear(libraryEl)
    libraryEl.append(el('div', { class: 'notice', text: messageOf(e) }))
    return
  }
  updateLibrary()
}

async function loadPlaylists(): Promise<void> {
  showLibraryLoading('playlists', 0, 0)
  try {
    playlists = await api.getAllPlaylists((loaded, total) =>
      showLibraryLoading('playlists', loaded, total),
    )
    playlistsLoaded = true
  } catch (e) {
    clear(libraryEl)
    libraryEl.append(el('div', { class: 'notice', text: messageOf(e) }))
    return
  }
  updateLibrary()
}

// ===========================================================================
// Utils
// ===========================================================================

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
