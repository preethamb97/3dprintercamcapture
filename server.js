/**
 * Bambu Lab A1 time-lapse camera controller – backend
 *
 * Setup: npm install
 * Run:   npm start
 */

require('dotenv').config();

const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const os = require('os');
const selfsigned = require('selfsigned');

const PHOTOS_DIR = path.join(__dirname, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// --- Configuration (from .env) ---
const PRINTER_IP = (process.env.PRINTER_IP || '').trim();
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const PRINTER_SERIAL = (process.env.PRINTER_SERIAL || '').trim();
const MQTT_PORT = 8883;
console.log(`[Config] PRINTER_IP=${PRINTER_IP} PRINTER_SERIAL=${PRINTER_SERIAL || '(auto)'} PORT=${MQTT_PORT}`);

if (!PRINTER_IP || !ACCESS_CODE) {
  console.error('Missing PRINTER_IP or ACCESS_CODE. Copy .env.example to .env and set your printer details.');
  process.exit(1);
}
// Reminder: ACCESS_CODE = code from printer screen under Settings → LAN Only Mode (not your Bambu account password)
// On Bambu A1 with smooth timelapse, layer_num increments in MQTT exactly when the nozzle
// has already parked at the wiper — so we capture immediately with just a tiny settle delay
// (300ms) to let the phone camera frame catch up.
// Override with CAPTURE_SETTLE_MS in .env if needed (set to 0 to capture instantly).
const CAPTURE_SETTLE_MS = parseInt(process.env.CAPTURE_SETTLE_MS || '300', 10);

const app = express();
// HTTPS required for camera on mobile (secure context)
const attrs = [{ name: 'commonName', value: 'localhost' }];
const cert = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
const httpsOpts = {
  key: cert.private,
  cert: cert.cert,
};
const server = https.createServer(httpsOpts, app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// So mobile/UI can show the correct URL (HTTPS required for camera)
app.get('/api/config', (_, res) => {
  const port = process.env.PORT || 3000;
  const pcIp = process.env.PC_IP;
  let baseUrl = null;
  if (pcIp) baseUrl = `https://${pcIp}:${port}`;
  else {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name]) {
        if (n.family === 'IPv4' && !n.internal) {
          baseUrl = `https://${n.address}:${port}`;
          break;
        }
      }
      if (baseUrl) break;
    }
  }
  res.json({ baseUrl: baseUrl || '', port });
});

// --- MQTT client (TLS, Bambu Lab A1) ---
// Bambu uses built-in MQTT broker: port 8883 (TLS), user "bblp", password = access code from printer (Settings → Device → LAN only).
const mqttBroker = `mqtts://${PRINTER_IP}:${MQTT_PORT}`;
const mqttOptions = {
  username: 'bblp',
  password: ACCESS_CODE,
  clientId: 'bambu_timelapse_1', // Fixed ID; random IDs can cause Bambu to close the connection
  keepalive: 20, // Send ping every 20s (Bambu may close if idle too long)
  rejectUnauthorized: false,
  checkServerIdentity: () => {},
  connectTimeout: 10000,
  reconnectPeriod: 5000,
};

let mqttClient = null;
let lastLayerNum = null;
let mqttConnected = false;
let mqttLastError = '';

// Deduplication: prevent a burst of identical MQTT messages from firing multiple captures.
const capturedLayers = new Set();

function statusMessage(connected, detail) {
  if (connected) return 'MQTT connected';
  if (!detail) return 'MQTT disconnected';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ENETUNREACH/.test(detail)) {
    return 'MQTT: Cannot reach printer — check PRINTER_IP and Wi‑Fi';
  }
  if (/not authorized|auth|password|credentials/i.test(detail)) {
    return 'MQTT: Not authorized — use access code from printer: Settings → LAN Only Mode';
  }
  return 'MQTT: ' + detail;
}

function connectMqtt() {
  if (mqttClient) {
    try { mqttClient.end(true); } catch (_) {}
    mqttClient = null;
  }
  mqttConnected = false;
  mqttLastError = '';
  io.emit('status', { mqtt: false, message: statusMessage(false, 'Connecting…') });

  console.log('[MQTT] Connecting to', PRINTER_IP + ':' + MQTT_PORT, '…');
  mqttClient = mqtt.connect(mqttBroker, mqttOptions);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    mqttLastError = '';
    const reportTopic = PRINTER_SERIAL ? `device/${PRINTER_SERIAL.trim()}/report` : 'device/+/report';
    mqttClient.subscribe(reportTopic, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
      else console.log('[MQTT] Connected and subscribed to', reportTopic);
    });
    io.emit('status', { mqtt: true, message: 'MQTT connected' });
  });

  mqttClient.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      const print = data.print || data;
      const layerNum = typeof print.layer_num === 'number' ? print.layer_num : null;
      if (layerNum === null) return;

      // On Bambu A1 smooth timelapse, layer_num increments in MQTT exactly when the nozzle
      // has already moved to the wiper position — capture immediately (+ tiny settle delay).
      if (lastLayerNum !== null && layerNum > lastLayerNum) {
        const capturedLayer = layerNum;
        if (!capturedLayers.has(capturedLayer)) {
          capturedLayers.add(capturedLayer);
          setTimeout(() => {
            io.emit('capture_frame', { layer: capturedLayer });
            console.log(`[Layer] ${capturedLayer} → capture triggered`);
            setTimeout(() => capturedLayers.delete(capturedLayer), 30000);
          }, CAPTURE_SETTLE_MS);
        }
      }
      lastLayerNum = layerNum;
    } catch (_) {}
  });

  mqttClient.on('error', (err) => {
    mqttConnected = false;
    mqttLastError = err.message || String(err);
    console.error('[MQTT] Error:', mqttLastError);
    if (/not authorized|auth/i.test(mqttLastError)) {
      console.error('[MQTT] → Use the code from the printer screen: Settings → LAN Only Mode (not Bambu account password).');
    }
    io.emit('status', { mqtt: false, message: statusMessage(false, mqttLastError) });
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    const msg = mqttLastError || 'Connection closed';
    console.log('[MQTT] Disconnected:', msg);
    io.emit('status', { mqtt: false, message: statusMessage(false, msg) });
  });

  mqttClient.on('offline', () => {
    mqttConnected = false;
    io.emit('status', { mqtt: false, message: 'MQTT reconnecting…' });
  });
}

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.emit('status', {
    mqtt: mqttConnected,
    message: mqttConnected ? 'MQTT connected' : 'MQTT disconnected',
  });

  // Client sends photo data; we ack success/failure so the client can log/retry.
  socket.on('save_photo', ({ layer, dataUrl }, ack) => {
    const reply = (ok, msg) => { if (typeof ack === 'function') ack({ ok, msg }); };
    if (layer == null || !dataUrl || typeof dataUrl !== 'string') {
      return reply(false, 'invalid payload');
    }
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    if (!base64) return reply(false, 'empty image data');
    const name = 'layer_' + String(layer).padStart(4, '0') + '.jpg';
    const filePath = path.join(PHOTOS_DIR, name);
    try {
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      console.log(`[Photo] Saved ${name} (${Math.round(base64.length * 0.75 / 1024)} KB)`);
      reply(true, name);
    } catch (err) {
      console.error(`[Photo] Failed to save ${name}:`, err.message);
      reply(false, err.message);
    }
  });
});

// --- Start (listen on all interfaces for mobile access) ---
connectMqtt();

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

function getLanUrl() {
  if (process.env.PC_IP) return `https://${process.env.PC_IP}:${PORT}`;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) return `https://${n.address}:${PORT}`;
    }
  }
  return `https://<this-pc-ip>:${PORT}`;
}

server.listen(PORT, HOST, () => {
  const url = getLanUrl();
  console.log(`Server running at https://localhost:${PORT}`);
  console.log(`On your phone (same Wi‑Fi), open: ${url}`);
  console.log(`(Accept the security warning — certificate is self-signed.)`);
});
