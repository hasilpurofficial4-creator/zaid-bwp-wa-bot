// ZAID BWP WhatsApp Bot - Standalone Render Server
// Persistent Baileys WebSocket + built-in pairing UI
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

// ==================== STATE ====================
let sock = null;
let waConnected = false;
let linkedPhone = null;
let sessionId = null;
let linkedAt = null;
let pairingListeners = []; // for pairing flow

// ==================== BAILEYS LOADER ====================
let _makeWASocket, _useMultiFileAuthState, _fetchLatestBaileysVersion, _Browsers, _pino;

async function loadBaileys() {
  if (_makeWASocket) return;
  console.log('[INIT] Loading Baileys...');
  const b = await import('@whiskeysockets/baileys');
  const keys = Object.keys(b);
  console.log('[INIT] Baileys exports:', keys.slice(0, 25).join(', '), '...');

  _makeWASocket = b.default?.makeWASocket || b.default?.default || b.makeWASocket || b.default;
  _useMultiFileAuthState = b.useMultiFileAuthState || b.default?.useMultiFileAuthState;
  _fetchLatestBaileysVersion = b.fetchLatestBaileysVersion || b.default?.fetchLatestBaileysVersion;
  _Browsers = b.Browsers || b.default?.Browsers;

  if (typeof _makeWASocket !== 'function') {
    for (const k of keys) {
      if (typeof b[k] === 'function' && k.toLowerCase().includes('socket')) {
        _makeWASocket = b[k]; console.log('[INIT] Found makeWASocket as:', k); break;
      }
    }
  }
  if (typeof _makeWASocket !== 'function') {
    console.error('[INIT] FAIL - makeWASocket not found. Keys:', keys.join(', '));
    console.error('[INIT] b.default type:', typeof b.default, b.default ? Object.keys(b.default).slice(0, 15) : 'null');
    process.exit(1);
  }

  const pm = await import('pino');
  _pino = typeof pm.default === 'function' ? pm.default : pm;
  console.log('[INIT] Baileys loaded OK. makeWASocket:', typeof _makeWASocket, '| useMultiFileAuthState:', typeof _useMultiFileAuthState);
}

// ==================== HELPERS ====================
function readJSON(f, d = null) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8')); } catch { return d; } }
function writeJSON(f, d) { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d)); }

function auth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return next();
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { require('jsonwebtoken').verify(t, process.env.JWT_SECRET || pw); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// GitHub backup
async function ghRead(file) {
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!tok || !repo) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/data/${file}.json`, { headers: { Authorization: `token ${tok}`, 'User-Agent': 'WA-Bot' } });
    if (!r.ok) return null; const j = await r.json();
    return { data: JSON.parse(Buffer.from(j.content, 'base64').toString()), sha: j.sha };
  } catch { return null; }
}
async function ghWrite(file, data, sha) {
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!tok || !repo) return;
  const body = { message: `wa-bot: ${file}`, content: Buffer.from(JSON.stringify(data)).toString('base64') };
  if (sha) body.sha = sha;
  await fetch(`https://api.github.com/repos/${repo}/contents/data/${file}.json`, { method: 'PUT', headers: { Authorization: `token ${tok}`, 'Content-Type': 'application/json', 'User-Agent': 'WA-Bot' }, body: JSON.stringify(body) });
}
async function saveToGitHub() {
  try { const e = await ghRead('wa-session'); await ghWrite('wa-session', { phone: linkedPhone, sessionId, linkedAt, connected: waConnected }, e?.sha); }
  catch (err) { console.error('[GH] backup error:', err.message); }
}

// ==================== SOCKET ====================
async function createSocket(fresh = false) {
  if (!_makeWASocket) await loadBaileys();
  if (fresh) { try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {} fs.mkdirSync(SESSION_DIR, { recursive: true }); }

  const { state, saveCreds } = await _useMultiFileAuthState(SESSION_DIR);
  let version;
  try { version = (await _fetchLatestBaileysVersion()).version; } catch { version = [2, 3000, 1021221121]; }
  const browser = (_Browsers?.ubuntu) ? _Browsers.ubuntu('ZAID BWP') : ['ZAID BWP', 'Chrome', '1.0.0'];

  console.log('[SOCK] Creating socket, version:', version);
  sock = _makeWASocket({ version, logger: _pino({ level: 'silent' }), auth: state, browser, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      waConnected = true;
      linkedPhone = sock.user?.id?.split(':')[0] || linkedPhone;
      console.log('[SOCK] Connected:', linkedPhone);
      if (!linkedAt) linkedAt = new Date().toISOString();
      writeJSON('config.json', { linked: true, phone: linkedPhone, sessionId, linkedAt });
      // Notify pairing listeners
      pairingListeners.forEach(fn => fn({ type: 'open' }));
    }

    if (connection === 'close') {
      waConnected = false;
      const err = lastDisconnect?.error;
      const sc = err?.output?.statusCode || err?.data?.statusCode || 0;
      console.log('[SOCK] Disconnected, status:', sc, 'msg:', err?.message || 'unknown');
      // Notify pairing listeners
      pairingListeners.forEach(fn => fn({ type: 'close', statusCode: sc, error: err?.message }));
      // Auto-reconnect if not auth failure
      if (sc !== 401 && sc !== 403 && fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
        console.log('[SOCK] Reconnecting in 3s...');
        setTimeout(() => createSocket(false).catch(e => console.log('[SOCK] Reconnect failed:', e.message)), 3000);
      }
    }
  });

  return { sock, state, saveCreds };
}

async function ensureConnected() {
  if (sock && waConnected) return;
  if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    console.log('[SOCK] Restoring session...');
    await createSocket(false);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Restore timeout')), 30000);
      sock?.ev.on('connection.update', u => { if (u.connection === 'open') { clearTimeout(t); res(); } });
    });
  } else throw new Error('Not linked - pair from Render dashboard first');
}

// ==================== PAIRING PAGE ====================
app.get('/', (req, res) => {
  const status = waConnected ? 'linked' : 'not-linked';
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZAID BWP - WhatsApp Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#1a1a2e;border-radius:16px;padding:30px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{text-align:center;background:linear-gradient(135deg,#25d366,#128c7e);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:24px;margin-bottom:5px}
.sub{text-align:center;color:#888;font-size:13px;margin-bottom:25px}
.status{display:flex;align-items:center;gap:8px;padding:12px;border-radius:10px;margin-bottom:20px;font-size:14px}
.status.on{background:rgba(37,211,102,.1);border:1px solid rgba(37,211,102,.3);color:#25d366}
.status.off{background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);color:#ff4757}
.dot{width:10px;height:10px;border-radius:50%}.dot.on{background:#25d366;animation:pulse 2s infinite}.dot.off{background:#ff4757}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:#111;color:#fff;font-size:15px;margin-bottom:15px;outline:none}
input:focus{border-color:#25d366}
button{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:.2s}
button:hover{transform:translateY(-1px);box-shadow:0 5px 20px rgba(37,211,102,.3)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none}
.code-box{background:linear-gradient(135deg,#1a3a2a,#1a2a3a);border:2px solid #25d366;border-radius:12px;padding:20px;text-align:center;margin:15px 0;display:none}
.code{font-size:36px;font-weight:700;letter-spacing:8px;font-family:monospace;color:#25d366}
.session-box{background:linear-gradient(135deg,#1a2a1a,#2a2a1a);border:1px solid #25d366;border-radius:10px;padding:15px;margin:15px 0;display:none;word-break:break-all}
.session-id{font-family:monospace;font-size:18px;color:#ffd700;padding:8px;background:#111;border-radius:6px;display:block;margin:8px 0;user-select:all}
.msg{text-align:center;font-size:13px;color:#888;margin-top:10px}.log{background:#111;border-radius:8px;padding:10px;margin-top:15px;font-family:monospace;font-size:12px;color:#666;max-height:120px;overflow-y:auto;white-space:pre-wrap;display:none}
.env-box{background:#1a1a2e;border:1px solid #444;border-radius:8px;padding:12px;margin-top:15px;font-size:13px;display:none}
.env-box code{color:#ffd700;background:#111;padding:2px 6px;border-radius:4px}
.btn-sm{padding:8px 16px;font-size:13px;width:auto;display:inline-block;margin-top:8px}
.unlink{background:linear-gradient(135deg,#ff4757,#ff6b81);margin-top:15px}
.copy-btn{background:linear-gradient(135deg,#4a90d9,#357abd);margin-top:8px}
.step{background:#111;border-radius:8px;padding:12px;margin:10px 0;font-size:13px;line-height:1.6}
.step b{color:#25d366}
</style></head><body><div class="card">
<h1>🏢 ZAID BWP MANAGEMENT</h1>
<p class="sub">WhatsApp Bot Control Panel &bull; 📱 03299931199</p>
<div class="status ${status === 'linked' ? 'on' : 'off'}" id="status-bar"><div class="dot ${status === 'linked' ? 'on' : 'off'}"></div><span id="status-text">${status === 'linked' ? 'Connected: ' + (linkedPhone || '') : 'Not Linked'}</span></div>

<div id="pair-section" ${status === 'linked' ? 'style="display:none"' : ''}>
  <label>Enter phone number (with country code, no +)</label>
  <input type="text" id="phone" placeholder="e.g. 923001234567" value="">
  <button id="pair-btn" onclick="startPair()">🔗 Link WhatsApp</button>
</div>

<div class="code-box" id="code-box"><p style="color:#aaa;margin-bottom:8px">Enter this code in WhatsApp:<br><small>Settings → Linked Devices → Link with phone number</small></p><div class="code" id="code-text"></div></div>

<div class="session-box" id="session-box">
  <p style="color:#aaa;margin-bottom:5px">✅ <b style="color:#25d366">WhatsApp Linked!</b></p>
  <p style="color:#aaa;font-size:13px">Your Session ID:</p>
  <span class="session-id" id="session-id"></span>
  <button class="btn-sm copy-btn" onclick="copySid()">📋 Copy Session ID</button>
  <div class="env-box" id="env-box">
    <p><b style="color:#25d366">Add these env vars to Vercel:</b></p>
    <div class="step"><b>RENDER_WA_URL</b> = <code id="render-url"></code><br><b>WA_SESSION_ID</b> = <code id="session-val"></code></div>
    <p style="color:#888;margin-top:8px">Then redeploy Vercel to activate notifications.</p>
  </div>
</div>

<div id="linked-section" ${status !== 'linked' ? 'style="display:none"' : ''}>
  <div class="session-box" style="display:block">
    <p style="color:#aaa;margin-bottom:5px">✅ <b style="color:#25d366">WhatsApp Connected</b></p>
    <p style="color:#aaa;font-size:13px">Phone: <b id="linked-phone">${linkedPhone || ''}</b></p>
    <p style="color:#aaa;font-size:13px;margin-top:5px">Session ID: <span class="session-id" id="linked-sid">${sessionId || 'N/A'}</span></p>
    <button class="btn-sm copy-btn" onclick="copyLinked()">📋 Copy Session ID</button>
    <div class="env-box" style="display:block">
      <p><b style="color:#25d366">Vercel env vars:</b></p>
      <div class="step"><b>RENDER_WA_URL</b> = <code>${req.protocol + '://' + req.get('host')}</code><br><b>WA_SESSION_ID</b> = <code>${sessionId || 'N/A'}</code></div>
    </div>
    <button class="btn-sm unlink" onclick="unlinkWA()">🗑️ Unlink WhatsApp</button>
  </div>
</div>

<div class="log" id="log"></div>
</div><script>
const log = (m) => { const el = document.getElementById('log'); el.style.display='block'; el.textContent += m+'\\n'; el.scrollTop=el.scrollHeight; };

async function startPair() {
  const phone = document.getElementById('phone').value.replace(/\\D/g,'');
  if (!phone || phone.length < 8) { alert('Enter valid phone with country code'); return; }
  document.getElementById('pair-btn').disabled = true;
  log('Requesting pairing code for '+phone+'...');
  try {
    const r = await fetch('/api/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone}) });
    const d = await r.json();
    if (d.pairingCode) {
      document.getElementById('code-text').textContent = d.pairingCode;
      document.getElementById('code-box').style.display = 'block';
      log('Pairing code: '+d.pairingCode);
      pollResult();
    } else if (d.error) { alert(d.error); document.getElementById('pair-btn').disabled=false; }
  } catch(e) { alert('Error: '+e.message); document.getElementById('pair-btn').disabled=false; }
}

async function pollResult() {
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/status'); const d = await r.json();
      if (d.linked) {
        clearInterval(poll);
        log('✅ Linked! Phone: '+d.phone+' Session: '+d.sessionId);
        document.getElementById('code-box').style.display='none';
        document.getElementById('pair-section').style.display='none';
        document.getElementById('session-id').textContent = d.sessionId;
        document.getElementById('session-val').textContent = d.sessionId;
        document.getElementById('render-url').textContent = window.location.origin;
        document.getElementById('session-box').style.display='block';
        document.getElementById('env-box').style.display='block';
        document.getElementById('status-bar').className='status on';
        document.getElementById('status-text').textContent='Connected: '+d.phone;
      }
    } catch(e) { log('Poll error: '+e.message); }
  }, 2000);
  setTimeout(() => { clearInterval(poll); document.getElementById('pair-btn').disabled=false; log('Timeout - try again'); }, 60000);
}

function copySid() { navigator.clipboard.writeText(document.getElementById('session-id').textContent); alert('Session ID copied!'); }
function copyLinked() { navigator.clipboard.writeText(document.getElementById('linked-sid').textContent); alert('Session ID copied!'); }

async function unlinkWA() {
  if (!confirm('Unlink WhatsApp?')) return;
  try { await fetch('/api/unlink', {method:'DELETE'}); location.reload(); } catch(e) { alert('Error: '+e.message); }
}
</script></body></html>`);
});

// ==================== API ROUTES ====================

app.get('/api/status', (req, res) => {
  res.json({ linked: waConnected, phone: linkedPhone, sessionId, linkedAt });
});

app.post('/api/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{8,15}$/.test(phone.replace(/\D/g, '')))
    return res.status(400).json({ error: 'Valid phone required. e.g. 923001234567' });
  const clean = phone.replace(/\D/g, '');
  try {
    if (sock) try { sock.end(new Error('re-pair')); } catch {}
    waConnected = false;
    pairingListeners = [];
    const { sock: s, state, saveCreds } = await createSocket(true);

    // Wait for socket connection to open
    console.log('[PAIR] Waiting for socket connection...');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Socket connection timeout (20s)')), 20000);
      const handler = (u) => {
        if (u.connection === 'open') { clearTimeout(t); resolve(); }
        if (u.connection === 'close') {
          const sc = u.lastDisconnect?.error?.output?.statusCode || 0;
          console.log('[PAIR] Socket closed during connect, status:', sc);
          if (sc === 401 || sc === 403) { clearTimeout(t); reject(new Error('Auth failed: ' + (u.lastDisconnect?.error?.message || sc))); }
        }
      };
      s.ev.on('connection.update', handler);
    });
    console.log('[PAIR] Socket connected, requesting pairing code...');

    const code = await s.requestPairingCode(clean);
    const display = code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code;
    console.log('[PAIR] Code:', display, 'for', clean);

    // Send code immediately, don't wait for connection
    res.json({ pairingCode: display, status: 'waiting' });

    // Now wait for connection in background
    let closeCount = 0;
    const waiter = (evt) => {
      if (evt.type === 'open') {
        const ph = s.user?.id?.split(':')[0] || clean;
        linkedPhone = ph;
        sessionId = 'zaidashiq_' + crypto.randomBytes(8).toString('hex');
        linkedAt = new Date().toISOString();
        waConnected = true;
        try { saveCreds(); } catch {}
        try { writeJSON('wa-auth-backup.json', { creds: state.creds, keys: serializeKeys(state.keys), phone: ph, sessionId, linkedAt }); saveToGitHub(); } catch {}
        writeJSON('config.json', { linked: true, phone: ph, sessionId, linkedAt });
        console.log('[PAIR] ✅ Linked:', ph, 'SessionID:', sessionId);
        // Send session ID message
        s.sendMessage(ph + '@s.whatsapp.net', { text:
          `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝\n\n` +
          `✅ *WhatsApp Successfully Linked!*\n\n🔑 *Session ID:*\n\`${sessionId}\`\n\n` +
          `━━━━━━━━━━━━━━━━━━\n📋 *Vercel Env Vars:*\n` +
          `\`RENDER_WA_URL\` = (your Render URL)\n\`WA_SESSION_ID\` = \`${sessionId}\`\n\n` +
          `━━━━━━━━━━━━━━━━━━\n📌 _Powered by ZAID BWP_\n📞 _03299931199_`
        }).catch(e => console.log('[PAIR] Send msg error:', e.message));
        pairingListeners = [];
      }
      if (evt.type === 'close') {
        closeCount++;
        console.log(`[PAIR] Close #${closeCount}, status: ${evt.statusCode}`);
      }
    };
    pairingListeners.push(waiter);
    // Clean up after 60s
    setTimeout(() => { pairingListeners = pairingListeners.filter(f => f !== waiter); }, 60000);
  } catch (err) {
    console.error('[PAIR] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/unlink', async (req, res) => {
  try {
    if (sock) try { sock.end(new Error('unlink')); } catch {}
    sock = null; waConnected = false; linkedPhone = null; sessionId = null; linkedAt = null;
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    writeJSON('config.json', { linked: false });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send message (called by Vercel proxy)
app.post('/api/whatsapp-send', async (req, res) => {
  try {
    const envSid = process.env.WA_SESSION_ID;
    if (envSid && envSid !== sessionId) return res.json({ success: false, error: 'Session ID mismatch' });
    const { section, entry, command, senderJid, text: directText, document } = req.body;
    if (!sock || !waConnected) await ensureConnected();
    if (command) return await handleCommand(command, senderJid, res);
    if (directText || document) {
      const to = (req.body.to || req.query.to || '') + '@s.whatsapp.net';
      await sock.sendMessage(to, document
        ? { document, fileName: req.body.fileName || 'file.csv', mimetype: req.body.mimetype || 'text/csv', caption: directText || '' }
        : { text: directText });
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
  } catch (err) { console.error('[SEND] Error:', err.message); res.json({ success: false, error: err.message }); }
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

// WhatsApp status (proxy-compatible)
app.get('/api/whatsapp', auth, (req, res) => {
  res.json({ linked: waConnected, phone: linkedPhone, sessionId, linkedAt });
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', connected: waConnected, phone: linkedPhone, uptime: Math.round(process.uptime()), baileys: !!_makeWASocket }));

// ==================== COMMAND HANDLER ====================
async function handleCommand(command, senderJid, res) {
  try {
    const cmd = (command || '').toLowerCase().trim();
    const jid = senderJid || '923244643714@s.whatsapp.net';
    const hdr = `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝\n\n`;
    const map = { itemsms:'items', itemspic:'items', walletms:'wallet', walletpic:'wallet', personms:'person', personpic:'person',
      maintenancems:'maintenance', maintenancepic:'maintenance', samplesms:'samples', samplespic:'samples', clippingms:'clipping', clippingpic:'clipping' };
    const sec = map[cmd];
    if (!sec) { await sock.sendMessage(jid, { text: hdr + '❌ Unknown command.' }); return res.json({ success: true }); }
    let entries = [];
    const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
    if (tok && repo) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/contents/data/${sec}.json`, { headers: { Authorization: `token ${tok}`, 'User-Agent': 'WA-Bot' } });
        if (r.ok) { const j = await r.json(); entries = JSON.parse(Buffer.from(j.content, 'base64').toString()) || []; }
      } catch { entries = []; }
    }
    if (cmd.endsWith('pic')) {
      let text = hdr + `📊 *${sec.toUpperCase()} DATA*\n━━━━━━━━━━━━━━━━━━\n📋 Total: *${entries.length}*\n\n`;
      entries.slice(-20).reverse().forEach((e, i) => { const n = e.name || e.personName || e.clipperName || e.personOrPurpose || e.subject || 'Entry'; const v = e.number || e.amount || e.size || ''; text += `${i+1}. *${n}* ${v?'- '+v:''}\n`; });
      text += `\n⏰ _${new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}_`;
      await sock.sendMessage(jid, { text });
    } else {
      let csv = entries.length > 0 ? Object.keys(entries[0]).join(',') + '\n' + entries.map(r => Object.keys(entries[0]).map(h => r[h]!=null?String(r[h]).replace(/,/g,';'):'').join(',')).join('\n') : 'No data\n';
      await sock.sendMessage(jid, { document: Buffer.from(csv, 'utf-8'), fileName: `${sec}_${new Date().toISOString().split('T')[0]}.csv`, mimetype: 'text/csv', caption: hdr + `📊 *${sec.toUpperCase()}*\n📋 ${entries.length} entries` });
    }
    res.json({ success: true });
  } catch (err) { console.error('[CMD] Error:', err.message); res.json({ success: false, error: err.message }); }
}

// ==================== FORMATTER ====================
function formatMsg(section, entry) {
  const now = new Date();
  const time = now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, day: '2-digit', month: 'short', year: 'numeric' });
  const hdr = `╔═══════════════════════╗\n  🏢 *ZAID BWP MANAGEMENT*\n  📱 03299931199\n╚═══════════════════════╝`;
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
  return `${hdr}\n\n${d}\n\n━━━━━━━━━━━━━━━━━━\n⏰ *${time}*\n📌 _Powered by ZAID BWP_\n📞 _03299931199_`;
}
function serializeKeys(keys) { const r = {}; for (const [k,v] of Object.entries(keys)) if (v && typeof v === 'object') r[k] = v; return r; }

// ==================== START ====================
(async () => {
  await loadBaileys();
  const config = readJSON('config.json');
  if (config?.linked) {
    sessionId = config.sessionId; linkedPhone = config.phone; linkedAt = config.linkedAt;
    try { await createSocket(false); console.log('[INIT] Session restored:', linkedPhone); }
    catch (err) { console.log('[INIT] Restore failed:', err.message); }
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n╔══════════════════════════════╗\n  🏢 ZAID BWP WhatsApp Bot\n  📡 Port: ${PORT}\n  🌐 Open: http://localhost:${PORT}\n╚══════════════════════════════╝\n`));
