import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Serve over HTTPS on the loopback IP literal 127.0.0.1.
// Spotify's dashboard requires HTTPS for redirect URIs, and the login flow
// rejects "localhost" as "Insecure" — so we need HTTPS *and* the IP literal:
// https://127.0.0.1:5005. (127.0.0.1 is a browser secure context, so the PKCE
// crypto in window.crypto.subtle works.)
//
// Port 5005: 5000/7000 are taken by macOS AirPlay, 6000 is a browser-blocked
// "unsafe port" (X11), and 5173 is used by another app.
export default defineConfig({
  plugins: [basicSsl()],
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
