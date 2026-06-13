// WhatsApp Bot Server for Render - Persistent Node.js process
// Keeps Baileys WebSocket alive (unlike serverless)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'session');
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ============ State ============
let sock = null;
let waConnected = false;
let linkedPhone = null;
let sessionId = null;
let linkedAt = null;

// ============ Baileys resolver ============
// Baileys v6+ is ESM-only. We resolve exports carefully.
let _makeWASocket = null;
let _useMultiFileAuthState = null;
let _fetchLatestBaileysVersion = null;
let _Browsers = null;
let _pino = null;

async function loadBaileys() {
  console.log('Loading Baileys module...');
  const baileys = await import('@whiskeysockets/baileys');

  // Log all available keys for debugging
  const keys = Object.keys(baileys);
  console.log('Baileys export keys:', keys.slice(0, 30).join(', '), '...');

  // Resolve makeWASocket - try every possible location
  _makeWASocket = baileys.default?.makeWASocket
    || baileys.default?.default
    || baileys.makeWASocket
    || baileys.default;

  if (typeof _makeWASocket !== 'function') {
    // Last resort: search for the function
    for (const key of keys) {
      if (typeof baileys[key] === 'function' && key.toLowerCase().includes('socket')) {
        _makeWASocket = baileys[key];
        console.log('Found makeWASocket as:', key);
        break;
      }
    }
  }

  _useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
  _fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion || baileys.default?.fetchLatestBaileysVersion;
  _Browsers = baileys.Browsers || baileys.default?.Browsers;

  console.log('makeWASocket type:', typeof _makeWASocket);
  console.log('useMultiFileAuthState type:', typeof _useMultiFileAuthState);

  if (typeof _makeWASocket !== 'function') {
    console.error('CRITICAL: makeWASocket is not a function!');
    console.error('baileys.default type:', typeof baileys.default);
    if (baileys.default) console.error('baileys.default keys:', Object.keys(baileys.default).slice(0, 20));
    throw new Error('Cannot resolve makeWASocket from baileys exports');
  }

  // Load pino
  const pinoMod = await import('pino');
  _pino = typeof pinoMod.default === 'function' ? pinoMod.default : pinoMod;
  console.log('pino type:', typeof _pino);

  console.log('Baileys loaded successfully!');
}

// ============ Helpers ============
function readJSON(file, def = null) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data));
}

// Auth middleware
function auth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return next();
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET || pw);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// GitHub backup (optional)
async function ghRead(file) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/data/${file}.json`, {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'WA-Bot' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content, 'base64').toString()), sha: j.sha };
  } catch { return null; }
}
async function ghWrite(file, data, sha) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return;
  const body = { message: `wa-bot: ${file}`, content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(`https://api.github.com/repos/${repo}/contents/data/${file}.json`, {
    method: 'PUT', headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'WA-Bot' }, body: JSON.stringify(body)
  });
}
async function saveToGitHub() {
  try {
    const e = await ghRead('wa-session');
    await ghWrite('wa-session', { phone: linkedPhone, sessionId, linkedAt, connected: waConnected }, e?.sha);
  } catch (err) { console.error('GitHub backup error:', err.message); }
}

// ============ Socket Management ============
async function createSocket(fresh = false) {
  if (!_makeWASocket) await loadBaileys();

  if (fresh) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  const { state, saveCreds } = await _useMultiFileAuthState(SESSION_DIR);
  let version;
  try { version = (await _fetchLatestBaileysVersion()).version; } catch { version = [2, 3000, 1021221121]; }

  const browser = (_Browsers?.ubuntu) ? _Browsers.ubuntu('ZAID BWP') : ['ZAID BWP', 'Chrome', '1.0.0'];
  const logger = _pino({ level: 'silent' });

  console.log('Creating WA socket, version:', version);
  sock = _makeWASocket({ version, logger, auth: state, browser, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection } = update;
    if (connection === 'open') {
      waConnected = true;
      linkedPhone = sock.user?.id?.split(':')[0] || linkedPhone;
      console.log('WhatsApp connected:', linkedPhone);
      if (!linkedAt) linkedAt = new Date().toISOString();
      writeJSON('config.json', { linked: true, phone: linkedPhone, sessionId, linkedAt });
    }
    if (connection === 'close') { waConnected = false; console.log('WhatsApp disconnected'); }
  });

  return { sock, state, saveCreds };
}

function waitForConn(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (waConnected && sock) return resolve();
    const t = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
    sock?.ev.on('connection.update', (u) => {
      if (u.connection === 'open') { clearTimeout(t); resolve(); }
      if (u.connection === 'close') { clearTimeout(t); reject(new Error('Connection closed')); }
    });
  });
}

async function ensureConnected() {
  if (sock && waConnected) return;
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('Restoring saved session...');
    await createSocket(false);
    await waitForConn(20000);
  } else { throw new Error('WhatsApp not linked - pair from admin panel first'); }
}

// ============ Startup ============
(async () => {
  // Load baileys module first
  await loadBaileys();

  // Restore session if exists
  const config = readJSON('config.json');
  if (config?.linked) {
    sessionId = config.sessionId; linkedPhone = config.phone; linkedAt = config.linkedAt;
    try { await createSocket(false); await waitForConn(30000); console.log('Session restored:', linkedPhone); }
    catch (err) { console.log('Session restore failed:', err.message); }
  }
})();

// ============ ROUTES ============

// Status
app.get('/api/whatsapp', auth, (req, res) => {
  if (req.query.action !== 'status') return res.status(400).json({ error: 'Use ?action=status' });
  res.json({ linked: waConnected, phone: linkedPhone, sessionId, linkedAt });
});

// Pair
app.post('/api/whatsapp', auth, async (req, res) => {
  if (req.query.action !== 'pair') return res.status(400).json({ error: 'Use ?action=pair' });
  const { phone } = req.body;
  if (!phone || !/^\d{8,15}$/.test(phone.replace(/\D/g, '')))
    return res.status(400).json({ error: 'Valid phone required (digits, country code, no +). e.g. 923001234567' });
  const clean = phone.replace(/\D/g, '');
  try {
    if (sock) try { sock.end(new Error('re-pair')); } catch {}
    waConnected = false;
    const { sock: s, state, saveCreds } = await createSocket(true);
    const code = await s.requestPairingCode(clean);
    const display = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
    console.log('Pairing code:', display, 'for', clean);

    const result = await new Promise((resolve) => {
      let done = false;
      s.ev.on('connection.update', async (u) => {
        if (u.connection === 'open' && !done) {
          done = true;
          const ph = s.user?.id?.split(':')[0] || clean;
          linkedPhone = ph; sessionId = 'zaidashiq_' + crypto.randomBytes(8).toString('hex');
          linkedAt = new Date().toISOString(); waConnected = true;
          try { saveCreds(); } catch {}
          try {
            writeJSON('wa-auth-backup.json', { creds: state.creds, keys: serializeKeys(state.keys), phone: ph, sessionId, linkedAt });
            await saveToGitHub();
          } catch {}
          // Send session ID to paired number
          try {
            await s.sendMessage(ph + '@s.whatsapp.net', { text:
              `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝\n\n` +
              `✅ *WhatsApp Successfully Linked!*\n\n🔑 *Session ID:*\n\`${sessionId}\`\n\n` +
              `━━━━━━━━━━━━━━━━━━\n📋 *Setup:*\n` +
              `Add env variable on Render:\n  Name: \`WA_SESSION_ID\`\n  Value: \`${sessionId}\`\n\n` +
              `Also add on Vercel:\n  Name: \`WA_SESSION_ID\`\n  Value: \`${sessionId}\`\n\n` +
              `━━━━━━━━━━━━━━━━━━\n📌 _Powered by ZAID BWP_\n📞 _03299931199_`
            });
            console.log('Session ID sent to', ph);
          } catch (e) { console.log('Send session ID error:', e.message); }
          writeJSON('config.json', { linked: true, phone: ph, sessionId, linkedAt });
          resolve({ status: 'linked', phone: ph, sessionId });
        }
        if (u.connection === 'close' && !done) { done = true; resolve({ status: 'error', message: 'Connection closed. Try again.' }); }
      });
      setTimeout(() => { if (!done) { done = true; resolve({ status: 'timeout', message: 'Timed out (55s). Code not entered in WhatsApp.' }); } }, 55000);
    });
    return res.json({ ...result, pairingCode: display });
  } catch (err) {
    console.error('Pair error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send
app.post('/api/whatsapp-send', async (req, res) => {
  try {
    const envSid = process.env.WA_SESSION_ID;
    if (envSid && envSid !== sessionId) {
      return res.json({ success: false, error: 'Session ID mismatch - update WA_SESSION_ID env var' });
    }
    const { section, entry, command, senderJid, text: directText, document } = req.body;
    if (!sock || !waConnected) await ensureConnected();
    if (command) return await handleCommand(command, senderJid, res);
    if (directText || document) {
      const to = (req.body.to || req.query.to || '') + '@s.whatsapp.net';
      const msg = document ? { document, fileName: req.body.fileName || 'file.csv', mimetype: req.body.mimetype || 'text/csv', caption: directText || '' } : { text: directText };
      await sock.sendMessage(to, msg);
      return res.json({ success: true });
    }
    if (section && entry) {
      const message = formatMsg(section, entry);
      const nums = ['923244643714', '923711286436'];
      const results = [];
      for (const n of nums) {
        try { await sock.sendMessage(n + '@s.whatsapp.net', { text: message }); results.push({ number: n, status: 'sent' }); }
        catch (e) { results.push({ number: n, status: 'failed', error: e.message }); }
      }
      return res.json({ success: true, results });
    }
    res.status(400).json({ error: 'Provide section+entry, command, or text+to' });
  } catch (err) {
    console.error('Send error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// Unlink
app.delete('/api/whatsapp', auth, async (req, res) => {
  if (req.query.action !== 'unlink') return res.status(400).json({ error: 'Use ?action=unlink' });
  try {
    if (sock) try { sock.end(new Error('unlink')); } catch {}
    sock = null; waConnected = false; linkedPhone = null; sessionId = null; linkedAt = null;
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    writeJSON('config.json', { linked: false });
    try { await ghWrite('wa-session', null, null); } catch {}
    res.json({ success: true, message: 'Unlinked' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Webhook
app.post('/api/whatsapp-webhook', async (req, res) => {
  try {
    const { body, message, from } = req.body;
    const text = (body || message || '').toLowerCase().trim();
    const cmds = ['itemsms','itemspic','walletms','walletpic','personms','personpic','maintenancems','maintenancepic','samplesms','samplespic','clippingms','clippingpic'];
    if (!cmds.includes(text)) return res.json({ ignored: true });
    if (!sock || !waConnected) await ensureConnected();
    await handleCommand(text, from, res);
  } catch (err) { res.json({ success: false, error: err.message }); }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', connected: waConnected, phone: linkedPhone, uptime: Math.round(process.uptime()), baileysLoaded: !!_makeWASocket }));

// ============ Command Handler ============
async function handleCommand(command, senderJid, res) {
  try {
    const cmd = (command || '').toLowerCase().trim();
    const targetJid = senderJid || '923244643714@s.whatsapp.net';
    const header = `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝\n\n`;
    const map = { itemsms:'items', itemspic:'items', walletms:'wallet', walletpic:'wallet', personms:'person', personpic:'person',
      maintenancems:'maintenance', maintenancepic:'maintenance', samplesms:'samples', samplespic:'samples', clippingms:'clipping', clippingpic:'clipping' };
    const section = map[cmd];
    if (!section) {
      await sock.sendMessage(targetJid, { text: header + '❌ Unknown command.\n\nAvailable:\n• itemsms/itemspic\n• walletms/walletpic\n• personms/personpic\n• maintenancems/maintenancepic\n• samplesms/samplespic\n• clippingms/clippingpic' });
      return res.json({ success: true });
    }
    let entries = [];
    const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
    if (token && repo) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/data/${section}.json`, {
          headers: { Authorization: `token ${token}`, 'User-Agent': 'WA-Bot' }
        });
        if (r.ok) { const j = await r.json(); entries = JSON.parse(Buffer.from(j.content, 'base64').toString()) || []; }
      } catch { entries = []; }
    }
    if (cmd.endsWith('pic')) {
      let text = header + `📊 *${section.toUpperCase()} DATA*\n━━━━━━━━━━━━━━━━━━\n📋 Total: *${entries.length}*\n\n`;
      entries.slice(-20).reverse().forEach((e, i) => {
        const name = e.name || e.personName || e.clipperName || e.personOrPurpose || e.subject || 'Entry';
        const num = e.number || e.amount || e.size || '';
        text += `${i + 1}. *${name}* ${num ? '- ' + num : ''}\n`;
      });
      text += `\n⏰ _${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}_`;
      await sock.sendMessage(targetJid, { text });
    } else {
      let csv = entries.length > 0
        ? Object.keys(entries[0]).join(',') + '\n' + entries.map(r => Object.keys(entries[0]).map(h => r[h] != null ? String(r[h]).replace(/,/g, ';') : '').join(',')).join('\n')
        : 'No data available\n';
      await sock.sendMessage(targetJid, {
        document: Buffer.from(csv, 'utf-8'), fileName: `${section}_${new Date().toISOString().split('T')[0]}.csv`,
        mimetype: 'text/csv', caption: header + `📊 *${section.toUpperCase()}*\n📋 ${entries.length} entries`
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Command error:', err.message);
    res.json({ success: false, error: err.message });
  }
}

// ============ Message Formatter ============
function formatMsg(section, entry) {
  const now = new Date();
  const time = now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, day: '2-digit', month: 'short', year: 'numeric' });
  const header = `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝`;
  let d = '';
  switch (section) {
    case 'items': d = `📦 *NEW ITEM*\n━━━━━━━━━━━━━━━━━━\n🏷️ Name: *${entry.name||'N/A'}*\n🔢 Serial: ${entry.number||'N/A'}\n👤 Person: ${entry.person||'N/A'}\n📋 Model: ${entry.model||'N/A'}`; break;
    case 'wallet': d = `${entry.type==='in'?'💰':'💸'} *WALLET ${entry.type==='in'?'INCOME':'EXPENSE'}*\n━━━━━━━━━━━━━━━━━━\n👤 ${entry.type==='in'?'From':'For'}: *${entry.personOrPurpose||'N/A'}*\n💵 Amount: *Rs. ${entry.amount||0}*`; break;
    case 'person': d = `👷 *WORKER ${entry.action==='enter'?'CHECK-IN':'CHECK-OUT'}*\n━━━━━━━━━━━━━━━━━━\n👤 Name: *${entry.personName||'N/A'}*`; break;
    case 'maintenance': d = `🔧 *MAINTENANCE ${entry.category?.toUpperCase()||'ENTRY'}*\n━━━━━━━━━━━━━━━━━━\n📌 Subject: *${entry.subject||'N/A'}*\n📝 Desc: ${entry.description||'N/A'}`; break;
    case 'samples': d = `🧪 *SAMPLE ${entry.type==='in'?'RECEIVED':'SENT'}*\n━━━━━━━━━━━━━━━━━━\n👤 Person: *${entry.personName||'N/A'}*\n📋 Program: ${entry.program||'N/A'}\n📦 Pieces: ${entry.pieces||'N/A'}`; break;
    case 'clipping': d = `✂️ *CLIPPING ${entry.type==='in'?'IN':'OUT'}*\n━━━━━━━━━━━━━━━━━━\n👤 Clipper: *${entry.clipperName||'N/A'}*\n📐 Size: ${entry.size||'N/A'}`; break;
    default: d = `📋 *NEW: ${section}*\n${JSON.stringify(entry)}`;
  }
  return `${header}\n\n${d}\n\n━━━━━━━━━━━━━━━━━━\n⏰ *${time}*\n📌 _Powered by ZAID BWP_\n📞 _03299931199_`;
}

function serializeKeys(keys) {
  const r = {};
  for (const [k, v] of Object.entries(keys)) { if (v && typeof v === 'object') r[k] = v; }
  return r;
}

// ============ Start ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WhatsApp Bot server listening on port ${PORT}`));
