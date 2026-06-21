// Authorization Code flow with PKCE — runs entirely in the browser, no backend
// or client secret required.
// https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize'
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'

// Scopes:
//  - user-library-read         → read the user's saved albums
//  - playlist-read-private      → read the user's private playlists
//  - playlist-read-collaborative → read collaborative playlists
//  - user-read-playback-state  → list devices + read what's playing
//  - user-modify-playback-state → start/pause/seek/transfer playback
//  - user-read-private          → read profile (to surface the Premium requirement)
const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-private',
].join(' ')

const STORAGE = {
  verifier: 'sp_pkce_verifier',
  state: 'sp_pkce_state',
  tokens: 'sp_tokens',
  clientId: 'sp_client_id_override',
  redirectUri: 'sp_redirect_uri_override',
}

interface StoredTokens {
  access_token: string
  refresh_token: string
  /** epoch ms when the access token expires */
  expires_at: number
  scope?: string
}

// ---------------------------------------------------------------------------
// Config (Client ID + redirect URI). Env values are the default; an optional
// localStorage override lets the user paste a Client ID from the UI.
// ---------------------------------------------------------------------------

export function getClientId(): string {
  return (
    localStorage.getItem(STORAGE.clientId) ||
    import.meta.env.VITE_SPOTIFY_CLIENT_ID ||
    ''
  )
}

export function setClientId(id: string): void {
  const trimmed = id.trim()
  if (trimmed) localStorage.setItem(STORAGE.clientId, trimmed)
  else localStorage.removeItem(STORAGE.clientId)
}

export function getRedirectUri(): string {
  return (
    localStorage.getItem(STORAGE.redirectUri) ||
    import.meta.env.VITE_SPOTIFY_REDIRECT_URI ||
    `${window.location.origin}/callback`
  )
}

export function setRedirectUri(uri: string): void {
  const trimmed = uri.trim()
  if (trimmed) localStorage.setItem(STORAGE.redirectUri, trimmed)
  else localStorage.removeItem(STORAGE.redirectUri)
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: ArrayBuffer): string {
  let str = ''
  const view = new Uint8Array(bytes)
  for (const b of view) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(length: number): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain))
}

// ---------------------------------------------------------------------------
// Login / callback / logout
// ---------------------------------------------------------------------------

export async function login(): Promise<void> {
  const clientId = getClientId()
  if (!clientId) throw new Error('Missing Spotify Client ID')

  const verifier = randomString(64)
  const challenge = base64UrlEncode(await sha256(verifier))
  const state = randomString(16)

  sessionStorage.setItem(STORAGE.verifier, verifier)
  sessionStorage.setItem(STORAGE.state, state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES,
  })

  window.location.assign(`${AUTH_ENDPOINT}?${params.toString()}`)
}

/**
 * If the current URL carries an OAuth `code`, exchange it for tokens.
 * Returns true if a sign-in was just completed. Safe to call on every load.
 */
export async function handleRedirectCallback(): Promise<boolean> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    cleanUrl()
    throw new Error(`Spotify authorization failed: ${error}`)
  }
  if (!code) return false

  const expectedState = sessionStorage.getItem(STORAGE.state)
  if (!returnedState || returnedState !== expectedState) {
    cleanUrl()
    throw new Error('OAuth state mismatch — please try signing in again.')
  }

  const verifier = sessionStorage.getItem(STORAGE.verifier)
  if (!verifier) {
    cleanUrl()
    throw new Error('Missing PKCE verifier — please try signing in again.')
  }

  const body = new URLSearchParams({
    client_id: getClientId(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  })

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    cleanUrl()
    const detail = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${detail}`)
  }

  const data = await res.json()
  storeTokens(data)
  sessionStorage.removeItem(STORAGE.verifier)
  sessionStorage.removeItem(STORAGE.state)
  cleanUrl()
  return true
}

function cleanUrl(): void {
  // Drop the OAuth query params and return to the app root.
  window.history.replaceState({}, document.title, '/')
}

export function logout(): void {
  localStorage.removeItem(STORAGE.tokens)
}

export function isLoggedIn(): boolean {
  return getStoredTokens() !== null
}

/** Scopes the current access token was actually granted. */
export function getGrantedScopes(): string[] {
  const scope = getStoredTokens()?.scope
  return scope ? scope.split(' ') : []
}

export function hasScope(scope: string): boolean {
  return getGrantedScopes().includes(scope)
}

/** True if the stored token is missing any scope this app now requires. */
export function needsReauth(): boolean {
  const granted = new Set(getGrantedScopes())
  return SCOPES.split(' ').some((s) => !granted.has(s))
}

// ---------------------------------------------------------------------------
// Token storage + refresh
// ---------------------------------------------------------------------------

function storeTokens(data: {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}): void {
  const prev = getStoredTokens()
  const tokens: StoredTokens = {
    access_token: data.access_token,
    // Spotify only returns a new refresh token sometimes; keep the old one if absent.
    refresh_token: data.refresh_token || prev?.refresh_token || '',
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
  localStorage.setItem(STORAGE.tokens, JSON.stringify(tokens))
}

function getStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(STORAGE.tokens)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredTokens
  } catch {
    return null
  }
}

let refreshInFlight: Promise<string> | null = null

/** Returns a valid access token, refreshing it first if it's expired/near expiry. */
export async function getAccessToken(): Promise<string> {
  const tokens = getStoredTokens()
  if (!tokens) throw new Error('Not signed in')

  // Refresh ~30s before expiry to avoid mid-request 401s.
  if (Date.now() < tokens.expires_at - 30_000) return tokens.access_token

  if (!refreshInFlight) refreshInFlight = doRefresh(tokens.refresh_token)
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

async function doRefresh(refreshToken: string): Promise<string> {
  if (!refreshToken) {
    logout()
    throw new Error('Session expired — please sign in again.')
  }

  const body = new URLSearchParams({
    client_id: getClientId(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    logout()
    throw new Error('Session expired — please sign in again.')
  }

  const data = await res.json()
  storeTokens(data)
  return data.access_token as string
}
