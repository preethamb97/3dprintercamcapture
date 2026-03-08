# 3D Printer Cam Capture

Automated time-lapse camera controller for **Bambu Lab A1** (and compatible) 3D printers. Uses your phone’s camera to capture a photo on the server every time the printer reports a new layer, so you can build a layer-by-layer time-lapse with no manual triggering.

## Features

- **Layer-triggered capture** – Listens to the printer over MQTT; when `layer_num` increases, the app waits 2.5s (for the toolhead to move to the purge/wiper) then triggers a capture.
- **Mobile-first UI** – Open the app on your phone over HTTPS; choose camera and quality (HD or max resolution). Photos are saved only on the server (no downloads on the phone).
- **Camera options** – Pick any camera (default is back/rear). Quality: HD (1080p) or Max (camera’s highest resolution).
- **Server-side storage** – Each frame is saved in the `photos/` folder as `layer_XXXX.jpg` (zero-padded layer number).

## Prerequisites

- **Node.js** (e.g. v18+) on a PC on the same Wi‑Fi as the printer
- **Bambu Lab A1** (or compatible) with LAN access:
  - Printer and PC on the same network
  - **Access code** from the printer: **Settings → LAN Only Mode** (enable and copy the code; this is not your Bambu account password)
- **Phone** on the same Wi‑Fi to open the web UI and provide the camera

## Quick start

1. **Clone and install**
   ```bash
   cd 3dprintercamcapture
   npm install
   ```

2. **Configure**
   - Copy `.env.example` to `.env`
   - Set `PRINTER_IP` (printer’s LAN IP from **Settings → Device → Network**)
   - Set `ACCESS_CODE` (from **Settings → LAN Only Mode** on the printer)
   - Optional: set `PC_IP` so the “open on phone” URL is correct; optional `PRINTER_SERIAL` for a more stable MQTT subscription

3. **Run**
   ```bash
   npm start
   ```
   The server will print a URL like `https://192.168.1.7:3000`. Open that URL on your phone (same Wi‑Fi), accept the self-signed certificate, allow camera access, and leave the page open during the print.

4. **Print** – Start a print on the A1. Each layer change will trigger a capture; frames are saved under `photos/` on the server.

## Configuration (.env)

| Variable        | Required | Description |
|----------------|----------|-------------|
| `PRINTER_IP`   | Yes      | Printer’s local IP (e.g. `192.168.1.3`) |
| `ACCESS_CODE`  | Yes      | LAN-only access code from printer (Settings → LAN Only Mode) |
| `PC_IP`        | No       | Your PC’s LAN IP (for the “open on phone” URL) |
| `PRINTER_SERIAL` | No     | Printer serial (Settings → Device); can improve MQTT stability |
| `PORT`         | No       | HTTP/HTTPS port (default `3000`) |

## Tech stack

- **Backend:** Node.js, Express, HTTPS (self-signed cert for camera on mobile), Socket.io, MQTT (TLS, port 8883)
- **Frontend:** Vanilla HTML/JS, Socket.io client; camera via `getUserMedia` (HTTPS required)
- **Printer:** Bambu Lab local MQTT broker (`bblp` + access code), topic `device/+/report` or `device/<SERIAL>/report`

## Project structure

```
3dprintercamcapture/
├── server.js          # Express + HTTPS + Socket.io + MQTT, serves public/ and photos/
├── public/
│   └── index.html     # Camera UI, quality/camera selectors, capture → server
├── photos/            # Captured frames (layer_0001.jpg, …)
├── .env               # Your config (not committed)
├── .env.example       # Template for .env
└── package.json
```

## License

MIT.
