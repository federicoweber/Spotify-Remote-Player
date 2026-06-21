import { defineConfig } from 'vite'

// Serve over plain HTTP on the loopback IP literal 127.0.0.1.
// Spotify rejects "localhost" as a redirect host ("Insecure"), but allows
// loopback IPs (http://127.0.0.1:PORT) without HTTPS. 127.0.0.1 is also a
// browser "secure context", so window.crypto.subtle (used for PKCE) works.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
