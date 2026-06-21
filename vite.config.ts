import { defineConfig } from 'vite'

// Serve over plain HTTP on the loopback IP literal 127.0.0.1.
// Spotify rejects "localhost" as a redirect host ("Insecure"), but allows
// loopback IPs (http://127.0.0.1:PORT) without HTTPS. 127.0.0.1 is also a
// browser "secure context", so window.crypto.subtle (used for PKCE) works.
//
// Port 5005: 5000/7000 are taken by macOS AirPlay, 6000 is a browser-blocked
// "unsafe port" (X11), and 5173 is used by another app.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5005,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5005,
    strictPort: true,
  },
})
