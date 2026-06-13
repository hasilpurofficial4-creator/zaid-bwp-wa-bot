// Quick test: can Baileys connect from this machine?
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, 'data', 'test-session');
fs.mkdirSync(SESSION_DIR, { recursive: true });

(async () => {
  console.log('1. Loading baileys...');
  const b = await import('@whiskeysockets/baileys');
  const makeWASocket = b.makeWASocket;
  const useMultiFileAuthState = b.useMultiFileAuthState;
  const fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;
  const Browsers = b.Browsers;
  console.log('2. Baileys loaded. makeWASocket:', typeof makeWASocket);

  const pm = await import('pino');
  const pino = pm.default || pm;

  console.log('3. Fetching version...');
  let version;
  try {
    const vl = await fetchLatestBaileysVersion();
    version = vl.version;
    console.log('4. Version:', version);
  } catch (e) {
    version = [2, 3000, 1021221121];
    console.log('4. Version fetch failed:', e.message, '- using fallback');
  }

  console.log('5. Loading auth state...');
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  console.log('6. Creating socket...');
  const browser = Browsers?.ubuntu ? Browsers.ubuntu('Test') : ['Test', 'Chrome', '1.0.0'];
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'info' }),
    auth: state,
    browser,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u;
    console.log('7. Connection update:', JSON.stringify({
      connection,
      statusCode: lastDisconnect?.error?.output?.statusCode,
      msg: lastDisconnect?.error?.message
    }));

    if (connection === 'open') {
      console.log('SUCCESS: Socket connected!');
      setTimeout(() => { sock.end(); process.exit(0); }, 2000);
    }
    if (connection === 'close') {
      const sc = lastDisconnect?.error?.output?.statusCode || 0;
      if (sc === 401 || sc === 403 || sc === 428) {
        console.log('Expected close (no session):', sc);
        sock.end();
        process.exit(0);
      }
    }
  });

  setTimeout(() => {
    console.log('TIMEOUT: Socket never connected in 25s');
    sock.end();
    process.exit(1);
  }, 25000);
})();
