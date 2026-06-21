import './style.css'
import * as auth from './spotify/auth'
import * as api from './spotify/api'
import { SpotifyApiError } from './spotify/api'
import { AlbumSequencer } from './player/sequencer'
import type { SequencerSnapshot } from './player/sequencer'
import { el, clear } from './ui/dom'
import { albumImage, artistsText, msToClock, releaseYear } from './ui/format'
import type { Album, Device, SavedAlbum, SpotifyUser, Track } from './spotify/types'

const root = document.getElementById('app')!
const sequencer = new AlbumSequencer()

// ---- app state ------------------------------------------------------------
let user: SpotifyUser | null = null
let albums: SavedAlbum[] = []
let devices: Device[] = []
let selectedDeviceId: string | null = null
let intervalSec = 5
let filterText = ''
let detail: { album: Album; tracks: Track[] } | null = null

// ---- stable section containers (built once in renderShell) ----------------
let headerEl: HTMLElement
let controlsEl: HTMLElement
let albumsEl: HTMLElement
let nowPlayingEl: HTMLElement
let modalEl: HTMLElement

void bootstrap()

async function bootstrap(): Promise<void> {
  let justSignedIn = false
  try {
    justSignedIn = await auth.handleRedirectCallback()
  } catch (e) {
    renderLogin(messageOf(e))
    return
  }
  void justSignedIn

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
    updateControlsNotice(messageOf(e))
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

  const redirectInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'Redirect URI',
    value: auth.getRedirectUri(),
    spellcheck: 'false',
    autocapitalize: 'off',
  }) as HTMLInputElement

  const connectBtn = el('button', {
    class: 'btn btn-primary btn-lg',
    text: 'Connect Spotify',
    onclick: async () => {
      auth.setClientId(clientIdInput.value)
      auth.setRedirectUri(redirectInput.value)
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
      text: 'Browse your saved albums and play them on a Spotify Connect device with a custom gap between every track.',
    }),
    errorBox,
    el('label', { class: 'field-label', text: 'Client ID' }),
    clientIdInput,
    el('label', { class: 'field-label', text: 'Redirect URI (must match your Spotify app exactly)' }),
    redirectInput,
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
  albumsEl = el('section', { class: 'albums' })
  nowPlayingEl = el('footer', { class: 'nowplaying', hidden: true })
  modalEl = el('div', { class: 'modal-backdrop', hidden: true })

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeDetail()
  })

  root.append(
    headerEl,
    el('main', { class: 'content' }, [controlsEl, albumsEl]),
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
      avatarUrl
        ? el('img', { class: 'avatar', src: avatarUrl, alt: '' })
        : null,
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
      deviceSelect.append(
        el('option', { value: d.id ?? '', text: label }) as HTMLOptionElement,
      )
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

  // Interval
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

  controlsEl.append(
    el('div', { class: 'control-group' }, [
      el('label', { class: 'field-label', text: 'Playback device' }),
      el('div', { class: 'control-row' }, [deviceSelect, refreshBtn]),
    ]),
    el('div', { class: 'control-group' }, [
      el('label', { class: 'field-label', text: 'Gap between songs (seconds)' }),
      intervalInput,
    ]),
  )

  const premiumWarning =
    user && user.product && user.product !== 'premium'
      ? 'Your account is not Premium — Spotify only allows playback control on Premium accounts.'
      : null
  const messages = [notice, premiumWarning].filter(Boolean) as string[]
  for (const msg of messages) {
    controlsEl.append(el('div', { class: 'notice', text: msg }))
  }
}

function updateControlsNotice(notice: string): void {
  updateControls(notice)
}

// ===========================================================================
// Albums grid
// ===========================================================================

function updateAlbums(): void {
  clear(albumsEl)

  const header = el('div', { class: 'albums-header' }, [
    el('h2', { text: `Your albums${albums.length ? ` (${albums.length})` : ''}` }),
  ])
  const search = el('input', {
    class: 'field search',
    type: 'search',
    placeholder: 'Filter albums…',
    value: filterText,
  }) as HTMLInputElement
  search.addEventListener('input', () => {
    filterText = search.value.toLowerCase()
    renderGrid()
  })
  header.append(search)
  albumsEl.append(header)

  const grid = el('div', { class: 'grid' })
  albumsEl.append(grid)

  function renderGrid(): void {
    clear(grid)
    const filtered = albums.filter(({ album }) => {
      if (!filterText) return true
      return (
        album.name.toLowerCase().includes(filterText) ||
        artistsText(album.artists).toLowerCase().includes(filterText)
      )
    })
    if (filtered.length === 0) {
      grid.append(el('p', { class: 'muted', text: 'No albums match.' }))
      return
    }
    for (const saved of filtered) grid.append(albumCard(saved))
  }
  renderGrid()
}

function albumCard(saved: SavedAlbum): HTMLElement {
  const { album } = saved
  const cover = albumImage(album.images, 300)
  return el('button', {
    class: 'card',
    onclick: () => void openDetail(album),
  }, [
    cover
      ? el('img', { class: 'card-cover', src: cover, alt: '', loading: 'lazy' })
      : el('div', { class: 'card-cover card-cover-empty' }),
    el('div', { class: 'card-title', text: album.name, title: album.name }),
    el('div', {
      class: 'card-sub',
      text: `${artistsText(album.artists)} · ${releaseYear(album.release_date)}`,
    }),
  ])
}

function showAlbumsLoading(loaded: number, total: number): void {
  clear(albumsEl)
  albumsEl.append(
    el('div', { class: 'loading' }, [
      el('div', { class: 'spinner' }),
      el('p', {
        class: 'muted',
        text: total
          ? `Loading your albums… ${loaded}/${total}`
          : 'Loading your albums…',
      }),
    ]),
  )
}

// ===========================================================================
// Album detail modal
// ===========================================================================

async function openDetail(album: Album): Promise<void> {
  detail = { album, tracks: album.tracks.items }
  renderDetail(true)
  try {
    const tracks = await api.getAlbumTracks(album)
    detail = { album, tracks }
    renderDetail(false)
  } catch (e) {
    renderDetail(false, messageOf(e))
  }
}

function closeDetail(): void {
  detail = null
  modalEl.hidden = true
  clear(modalEl)
}

function renderDetail(loadingMore: boolean, error?: string): void {
  if (!detail) return
  const { album, tracks } = detail
  clear(modalEl)
  modalEl.hidden = false

  const canPlay = Boolean(selectedDeviceId)
  const cover = albumImage(album.images, 300)

  const playAlbumBtn = el('button', {
    class: 'btn btn-primary',
    text: '▶ Play album',
    disabled: !canPlay,
    title: canPlay ? '' : 'Select a device first',
    onclick: () => startAlbum(0),
  })

  const trackList = el('ol', { class: 'tracklist' })
  tracks.forEach((track, i) => {
    trackList.append(
      el('li', { class: 'track' }, [
        el('span', { class: 'track-num', text: String(track.track_number || i + 1) }),
        el('span', { class: 'track-name', text: track.name, title: track.name }),
        el('span', { class: 'track-dur', text: msToClock(track.duration_ms) }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          text: '▶',
          title: canPlay ? 'Play album from here' : 'Select a device first',
          disabled: !canPlay,
          onclick: () => startAlbum(i),
        }),
      ]),
    )
  })

  const panel = el('div', { class: 'modal' }, [
    el('button', { class: 'modal-close', text: '✕', onclick: () => closeDetail() }),
    el('div', { class: 'modal-head' }, [
      cover
        ? el('img', { class: 'modal-cover', src: cover, alt: '' })
        : el('div', { class: 'modal-cover card-cover-empty' }),
      el('div', { class: 'modal-meta' }, [
        el('h2', { class: 'modal-title', text: album.name }),
        el('p', { class: 'muted', text: artistsText(album.artists) }),
        el('p', { class: 'muted small', text:
          `${album.total_tracks} tracks · ${releaseYear(album.release_date)}` }),
        el('div', { class: 'modal-actions' }, [
          playAlbumBtn,
          !canPlay ? el('span', { class: 'muted small', text: 'Pick a device above to enable playback.' }) : null,
        ]),
      ]),
    ]),
    error ? el('div', { class: 'notice', text: error }) : null,
    loadingMore && tracks.length < album.total_tracks
      ? el('p', { class: 'muted small', text: 'Loading full track list…' })
      : null,
    trackList,
  ])

  modalEl.append(panel)
}

// ===========================================================================
// Playback wiring
// ===========================================================================

function startAlbum(startIndex: number): void {
  if (!detail || !selectedDeviceId) return
  sequencer.start({
    album: detail.album,
    tracks: detail.tracks,
    deviceId: selectedDeviceId,
    intervalSec,
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

  const track = snap.currentTrack
  const album = snap.album
  const cover = album ? albumImage(album.images, 100) : ''
  const inInterval =
    snap.state === 'interval' ||
    (snap.state === 'paused' && snap.pausedFrom === 'interval')

  // Progress / countdown bar
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
      ? 'Album finished'
      : snap.state === 'paused'
        ? 'Paused'
        : `${msToClock(snap.progressMs)} / ${msToClock(snap.durationMs)}`

  const isPaused = snap.state === 'paused'
  const isDone = snap.state === 'done'

  const controls = el('div', { class: 'np-controls' }, [
    el('button', { class: 'btn btn-ghost np-btn', text: '⏮', title: 'Previous track', disabled: isDone, onclick: () => sequencer.previous() }),
    el('button', {
      class: 'btn btn-primary np-btn np-play',
      text: isPaused ? '▶' : '⏸',
      title: isPaused ? 'Resume' : 'Pause',
      disabled: isDone,
      onclick: () => sequencer.pauseResume(),
    }),
    el('button', { class: 'btn btn-ghost np-btn', text: '⏭', title: 'Next track', disabled: isDone, onclick: () => sequencer.next() }),
    inInterval
      ? el('button', { class: 'btn btn-ghost btn-sm', text: 'Skip gap', onclick: () => sequencer.skipInterval() })
      : null,
    el('button', { class: 'btn btn-ghost btn-sm', text: '⏹ Stop', onclick: () => sequencer.stop() }),
  ])

  nowPlayingEl.append(
    el('div', { class: 'np-track' }, [
      cover ? el('img', { class: 'np-cover', src: cover, alt: '' }) : el('div', { class: 'np-cover card-cover-empty' }),
      el('div', { class: 'np-meta' }, [
        el('div', { class: 'np-name', text: track?.name ?? (isDone ? 'Done' : '—') }),
        el('div', { class: 'np-sub', text: track ? artistsText(track.artists) : album?.name ?? '' }),
      ]),
    ]),
    el('div', { class: 'np-center' }, [
      el('div', { class: 'np-status' }, [
        el('span', { class: 'np-count', text: album ? `Track ${snap.index + 1} / ${snap.tracks.length}` : '' }),
        el('span', { class: 'np-time', text: statusText }),
      ]),
      bar,
    ]),
    controls,
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
    updateControlsNotice(messageOf(e))
    return
  }
  updateControls()
}

async function loadAlbums(): Promise<void> {
  showAlbumsLoading(0, 0)
  try {
    albums = await api.getAllSavedAlbums((loaded, total) => showAlbumsLoading(loaded, total))
  } catch (e) {
    clear(albumsEl)
    albumsEl.append(el('div', { class: 'notice', text: messageOf(e) }))
    return
  }
  updateAlbums()
}

// ===========================================================================
// Utils
// ===========================================================================

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
