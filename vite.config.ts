import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Serve over HTTPS on localhost:5000 so it matches the Spotify redirect URI
// (Spotify allows https://localhost but not plain http://localhost).
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: 'localhost',
    port: 5000,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 5000,
    strictPort: true,
  },
})
