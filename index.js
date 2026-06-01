/**
 * ============================================================
 *  VOICETA WhatsApp Bot Server
 *  Engine : Baileys (WebSocket — tanpa Puppeteer/Chromium)
 *  Hosting : Railway / Render (free tier)
 * ============================================================
 *
 *  ENDPOINT:
 *    POST /send        → kirim pesan WA
 *    POST /send-batch  → kirim pesan ke banyak nomor sekaligus
 *    GET  /health      → cek status koneksi
 *    GET  /status      → info lengkap server
 * ============================================================
 */

"use strict";

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require("@whiskeysockets/baileys");

const pino   = require("pino");
const express = require("express");
const axios   = require("axios");

// ── Konfigurasi ──────────────────────────────────────────────
const CONFIG = {
  PORT            : process.env.PORT             || 3000,
  APPS_SCRIPT_URL : process.env.APPS_SCRIPT_URL  || "",   // URL doPost Google Apps Script
  API_SECRET      : process.env.API_SECRET       || "rahasia123", // ganti di env!
  AUTH_DIR        : "./auth_info",
  RECONNECT_DELAY : 5000,   // ms
};

// ── State global ─────────────────────────────────────────────
let sock          = null;
let isConnected   = false;
let qrCode        = null;
let reconnectTimer = null;

// ── Logger (supaya log Railway tidak berantakan) ──────────────
const logger = pino({ level: "warn" });

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(express.json());

// Middleware: validasi API secret agar endpoint tidak terbuka sembarangan
function requireSecret(req, res, next) {
  const secret = req.headers["x-api-secret"] || req.query.secret;
  if (secret !== CONFIG.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized — API secret salah." });
  }
  next();
}

// ── Helper: format nomor ke JID Baileys ──────────────────────
function toJid(phone) {
  // Bersihkan semua karakter bukan angka
  let num = String(phone).replace(/[^0-9]/g, "");
  // Ganti awalan 0 dengan 62 (Indonesia)
  if (num.startsWith("0")) num = "62" + num.slice(1);
  return num + "@s.whatsapp.net";
}

// ── Koneksi ke WhatsApp ───────────────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal : true,   // tampilkan QR di log Railway saat pertama kali
    generateHighQualityLinkPreview: false,
    browser: ["VOICETA-Bot", "Chrome", "1.0.0"],
  });

  // Simpan credentials setiap kali berubah
  sock.ev.on("creds.update", saveCreds);

  // ── Event: perubahan status koneksi ─────────────────────────
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr;
      console.log("⬜ QR Code tersedia — scan dengan WhatsApp di HP kamu.");
    }

    if (connection === "open") {
      isConnected = true;
      qrCode      = null;
      console.log("✅ WhatsApp terhubung dan siap digunakan.");
    }

    if (connection === "close") {
      isConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      console.log(`⚠️  Koneksi terputus (kode: ${code}). ${loggedOut ? "Sudah logout." : "Reconnect dalam 5 detik..."}`);

      if (!loggedOut) {
        // Reconnect otomatis dengan delay
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWhatsApp, CONFIG.RECONNECT_DELAY);
      }
    }
  });

  // ── Event: pesan masuk (untuk feedback dari Subject) ─────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Abaikan pesan dari diri sendiri dan broadcast
      if (msg.key.fromMe) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const from = msg.key.remoteJid.replace("@s.whatsapp.net", "");
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!body) continue;

      console.log(`📩 Pesan masuk dari ${from}: ${body.substring(0, 80)}...`);

      // Kirim ke Google Apps Script untuk disimpan di Notion
      if (CONFIG.APPS_SCRIPT_URL) {
        try {
          await axios.post(CONFIG.APPS_SCRIPT_URL, {
            type      : "incoming_message",
            from      : from,
            body      : body,
            timestamp : new Date().toISOString(),
          }, { timeout: 10000 });

          console.log(`✅ Feedback dari ${from} berhasil diteruskan ke Notion.`);
        } catch (err) {
          console.error(`❌ Gagal meneruskan pesan ke Apps Script: ${err.message}`);
        }
      }
    }
  });
}

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Kirim satu pesan
// ════════════════════════════════════════════════════════════
app.post("/send", requireSecret, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: "Field 'phone' dan 'message' wajib diisi." });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp belum terhubung. Cek log server untuk scan QR." });
  }

  try {
    const jid = toJid(phone);
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Pesan terkirim ke ${phone}`);
    return res.json({ success: true, to: phone });
  } catch (err) {
    console.error(`❌ Gagal kirim ke ${phone}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Kirim batch (banyak nomor sekaligus)
// ════════════════════════════════════════════════════════════
app.post("/send-batch", requireSecret, async (req, res) => {
  const { messages } = req.body;
  // Format: [ { phone: "628xxx", message: "..." }, ... ]

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Field 'messages' harus berupa array yang tidak kosong." });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp belum terhubung." });
  }

  const results = [];
  for (const item of messages) {
    try {
      const jid = toJid(item.phone);
      await sock.sendMessage(jid, { text: item.message });
      results.push({ phone: item.phone, status: "sent" });
      // Jeda 1.5 detik antar pesan agar tidak di-ban WA
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      results.push({ phone: item.phone, status: "failed", error: err.message });
    }
  }

  return res.json({ results });
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Health check
// ════════════════════════════════════════════════════════════
app.get("/health", (_req, res) => {
  res.json({
    status      : isConnected ? "connected" : "disconnected",
    hasQR       : !!qrCode,
    timestamp   : new Date().toISOString(),
  });
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT: Status lengkap (dengan secret)
// ════════════════════════════════════════════════════════════
app.get("/status", requireSecret, (_req, res) => {
  res.json({
    service     : "VOICETA WhatsApp Bot Server",
    version     : "1.0.0",
    connected   : isConnected,
    hasQR       : !!qrCode,
    appsScript  : CONFIG.APPS_SCRIPT_URL ? "configured" : "not configured",
    uptime      : process.uptime(),
    timestamp   : new Date().toISOString(),
  });
});

// ── Start server ─────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Server berjalan di port ${CONFIG.PORT}`);
  console.log(`   API Secret: ${CONFIG.API_SECRET}`);
});

// ── Inisialisasi koneksi WhatsApp ─────────────────────────────
connectWhatsApp().catch(err => {
  console.error("Fatal: gagal inisialisasi WhatsApp:", err);
  process.exit(1);
});
