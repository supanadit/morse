// Dev-server proxy: makes `ng serve` (:4200) talk to the NestJS host without any
// query parameter. The frontend always connects to its own origin (`/ws`), so
// the same build works behind the proxy in development and directly in
// production (where the host serves the bundle itself).
//
// Override the target when the host runs elsewhere:
//   MORSE_SERVER_URL=http://192.168.1.10:4399 npm run dev:ui
const target = process.env.MORSE_SERVER_URL ?? 'http://127.0.0.1:4399';

/** @type {Record<string, unknown>} */
export default {
  '/ws': { target, ws: true, changeOrigin: true },
  '/api': { target, changeOrigin: true },
};
