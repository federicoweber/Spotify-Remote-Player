# Album Sequencer

A one-page web app that signs into Spotify, lists **all your saved albums**, and
plays an album **track-by-track with a customizable gap between songs** (default
**5 seconds**) on any Spotify Connect device.

It controls playback via the Spotify Web API rather than streaming audio itself,
so if you point it at a device set to **Lossless** (e.g. the Spotify desktop
app), the audio decodes losslessly on that device — the app only sends the
play/pause/next commands and inserts the gaps.

## Why it controls a device instead of playing in the browser

Spotify's in-browser Web Playback SDK is capped below lossless (~256 kbps).
Lossless (FLAC) only plays inside Spotify's official apps. To honor lossless,
this app remote-controls one of those apps over **Spotify Connect**.

## Requirements

- **Node 18+**
- A **Spotify Premium** account (the Web API only allows playback control on Premium)
- A Spotify app registered in the developer dashboard (free)
- An active Connect device — typically the **Spotify desktop app** open and signed in.
  For lossless, set that app's audio quality to **Lossless** in its settings.

## Setup

### 1. Create a Spotify app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and **Create app**.
2. Add this **Redirect URI** exactly: `https://localhost:5000`
   (Spotify allows `https://localhost`, but not plain `http://localhost`.)
3. Copy the app's **Client ID**.

### 2. Configure

Copy `.env.example` to `.env` and set your Client ID:

```bash
cp .env.example .env
# then edit .env and set VITE_SPOTIFY_CLIENT_ID=...
```

(You can also paste the Client ID into the app's sign-in screen instead.)

The redirect URI defaults to `https://localhost:5000` to match the dashboard
entry above. If you registered a different URI, set `VITE_SPOTIFY_REDIRECT_URI`
to match it **exactly**.

### 3. Run

```bash
npm install
npm run dev
```

Open **https://localhost:5000**.

> The dev server uses a self-signed certificate (`@vitejs/plugin-basic-ssl`), so
> your browser will warn the first time — accept it to proceed. To avoid the
> warning entirely, generate a locally-trusted cert with
> [`mkcert`](https://github.com/FiloSottile/mkcert) and point Vite's `server.https`
> at it.

## Using it

1. **Connect Spotify** and approve the requested scopes.
2. Make sure a device is available (open the Spotify desktop app). Pick it from
   **Playback device** — hit **↻ Devices** if it isn't listed yet.
3. Set the **gap between songs** in seconds (default 5).
4. Click an album, then **Play album** (or ▶ on a track to start from there).
5. The bottom bar shows the current track, a green progress bar while playing and
   an **amber countdown** during each gap, plus prev / pause / next / stop and a
   **Skip gap** button.

## How the gap works

There's no native Spotify setting for a gap between songs, so the app sequences
the album itself: it plays **one track at a time** (no album queue), watches it
to the end through the player API, waits your configured interval, then starts
the next track. Changing the device's audio quality (e.g. lossless) is done in
the Spotify app — this tool can't set it over the API.

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `npm run dev`     | Start the HTTPS dev server on `:5000`        |
| `npm run build`   | Type-check (`tsc`) and build to `dist/`      |
| `npm run preview` | Serve the production build on `:5000`        |

## Tech

Vite + TypeScript, no UI framework. Auth uses the Authorization Code + PKCE flow
entirely client-side (no backend, no client secret). Tokens live in
`localStorage` and auto-refresh.

## Project layout

```
src/
  main.ts            # app bootstrap, views, playback wiring
  style.css          # dark theme
  spotify/
    auth.ts          # PKCE login / token refresh
    api.ts           # typed Web API client
    types.ts         # Spotify response types
  player/
    sequencer.ts     # album playback engine + inter-track gap
  ui/
    dom.ts, format.ts
```

## Troubleshooting

**Port 5000 / "AirPlay Receiver" on macOS.** macOS's AirPlay Receiver also
listens on port 5000 (IPv4). Vite serves on IPv6 `localhost` (`[::1]:5000`) and
usually wins, but if the page won't load or you see odd responses, free the port:
**System Settings → General → AirDrop & Handoff → turn off AirPlay Receiver**,
then restart `npm run dev`. (Alternatively, pick another port in
`vite.config.ts` + the Spotify redirect URI + `.env`.)

**`INVALID_CLIENT: Invalid redirect URI`.** The redirect URI sent by the app
must match the dashboard entry character-for-character. Confirm
`VITE_SPOTIFY_REDIRECT_URI` (and the field on the sign-in screen) equals what's
registered, including scheme, port, and any trailing path.

**Certificate warning.** Expected with the self-signed dev cert — accept it once,
or use `mkcert` for a trusted cert.

## Limitations / notes

- Playback control requires Premium; the app surfaces a notice otherwise.
- The app can't *set* a device to lossless — configure that in the Spotify app.
- If you change tracks directly in Spotify while the sequencer runs, it detects
  the takeover and stops rather than fighting you.
