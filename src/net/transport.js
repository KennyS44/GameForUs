// WebRTC transport over PeerJS.
//
// A static site has no server of its own, so one player's browser acts as the
// host and everyone else connects straight to it. The only outside service is
// PeerJS's free broker, used purely to introduce the two browsers to each
// other — once connected, all game traffic is peer to peer.
//
// Known limits, by design:
//   - if the host closes their tab, the match ends;
//   - some strict NATs need a TURN relay, which this free setup doesn't have.
// Both go away when the simulation moves to a real server.

// PeerJS ships as a classic browser bundle, so it is loaded on demand rather
// than imported. Solo play never downloads it.
let peerLibPromise = null;

function loadPeerLib() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerLibPromise) return peerLibPromise;
  peerLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/peerjs.min.js', import.meta.url).href;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('peerjs missing')));
    s.onerror = () => reject(new Error('peerjs failed to load'));
    document.head.appendChild(s);
  });
  return peerLibPromise;
}

const PREFIX = 'gfu4x';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes

export function makeRoomCode() {
  let out = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normaliseCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

const peerId = (code) => `${PREFIX}-${code}`;

const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

// Data channel tuned for a game: unordered, no retransmits. A stale snapshot
// is worthless, so never wait for one to be re-sent.
const CONN_OPTIONS = {
  reliable: false,
  serialization: 'json',
};

function emptyHandlers() {
  return { join: [], leave: [], message: [], status: [], error: [] };
}

// ── Host ──────────────────────────────────────────────────────────────────

export function createHostTransport({ code, onStatus }) {
  const h = emptyHandlers();
  const conns = new Map();
  let peer = null;
  let closed = false;

  const status = (msg, kind = 'info') => {
    onStatus?.(msg, kind);
    h.status.forEach((fn) => fn(msg, kind));
  };

  const ready = loadPeerLib().then((Peer) => new Promise((resolve, reject) => {
    peer = new Peer(peerId(code), PEER_OPTIONS);

    peer.on('open', () => {
      status(`Комната ${code} открыта. Ждём игроков…`, 'ok');
      resolve(code);
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        conns.set(conn.peer, conn);
        status(`Игрок подключился (${conns.size} в комнате).`, 'ok');
        h.join.forEach((fn) => fn(conn.peer, conn.metadata));
      });
      conn.on('data', (data) => {
        h.message.forEach((fn) => fn(conn.peer, data));
      });
      const drop = () => {
        if (!conns.has(conn.peer)) return;
        conns.delete(conn.peer);
        status(`Игрок отключился (${conns.size} в комнате).`);
        h.leave.forEach((fn) => fn(conn.peer));
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });

    peer.on('error', (err) => {
      if (closed) return;
      const msg =
        err.type === 'unavailable-id'
          ? 'Такая комната уже занята — создайте новую.'
          : err.type === 'network'
            ? 'Нет связи с сервером комнат. Проверьте интернет.'
            : `Ошибка соединения: ${err.type}`;
      status(msg, 'error');
      h.error.forEach((fn) => fn(err));
      reject(err);
    });
  }));

  return {
    kind: 'host',
    code,
    ready,
    get peerCount() {
      return conns.size;
    },
    peerIds: () => [...conns.keys()],
    onPeerJoin: (fn) => h.join.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onMessage: (fn) => h.message.push(fn),
    onStatus: (fn) => h.status.push(fn),
    onError: (fn) => h.error.push(fn),
    sendTo(id, msg) {
      const c = conns.get(id);
      if (c?.open) {
        try {
          c.send(msg);
        } catch {
          /* channel died mid-send; the close handler will clean up */
        }
      }
    },
    broadcast(msg) {
      for (const c of conns.values()) {
        if (!c.open) continue;
        try {
          c.send(msg);
        } catch {
          /* as above */
        }
      }
    },
    close() {
      closed = true;
      for (const c of conns.values()) c.close();
      conns.clear();
      peer?.destroy();
    },
  };
}

// ── Client ────────────────────────────────────────────────────────────────

export function createClientTransport({ code, name, onStatus }) {
  const h = emptyHandlers();
  let peer = null;
  let conn = null;
  let closed = false;

  const status = (msg, kind = 'info') => {
    onStatus?.(msg, kind);
    h.status.forEach((fn) => fn(msg, kind));
  };

  const ready = loadPeerLib().then((Peer) => new Promise((resolve, reject) => {
    peer = new Peer(PEER_OPTIONS);
    const timeout = setTimeout(() => {
      if (!conn?.open) {
        status('Комната не отвечает. Проверьте код и что хост в игре.', 'error');
        reject(new Error('timeout'));
      }
    }, 12000);

    peer.on('open', (myId) => {
      status('Подключаемся к комнате…');
      conn = peer.connect(peerId(code), { ...CONN_OPTIONS, metadata: { name } });

      conn.on('open', () => {
        clearTimeout(timeout);
        status('Подключено.', 'ok');
        resolve(myId);
      });
      conn.on('data', (data) => {
        h.message.forEach((fn) => fn(conn.peer, data));
      });
      conn.on('close', () => {
        if (closed) return;
        status('Хост закрыл комнату.', 'error');
        h.leave.forEach((fn) => fn(conn.peer));
      });
      conn.on('error', (err) => {
        clearTimeout(timeout);
        status('Не удалось соединиться с хостом.', 'error');
        reject(err);
      });
    });

    peer.on('error', (err) => {
      if (closed) return;
      clearTimeout(timeout);
      const msg =
        err.type === 'peer-unavailable'
          ? 'Комната с таким кодом не найдена.'
          : err.type === 'network'
            ? 'Нет связи с сервером комнат. Проверьте интернет.'
            : `Ошибка соединения: ${err.type}`;
      status(msg, 'error');
      h.error.forEach((fn) => fn(err));
      reject(err);
    });
  }));

  return {
    kind: 'client',
    code,
    ready,
    get myId() {
      return peer?.id;
    },
    onPeerJoin: (fn) => h.join.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onMessage: (fn) => h.message.push(fn),
    onStatus: (fn) => h.status.push(fn),
    onError: (fn) => h.error.push(fn),
    send(msg) {
      if (conn?.open) {
        try {
          conn.send(msg);
        } catch {
          /* channel died mid-send */
        }
      }
    },
    sendTo(_id, msg) {
      this.send(msg);
    },
    broadcast(msg) {
      this.send(msg);
    },
    close() {
      closed = true;
      conn?.close();
      peer?.destroy();
    },
  };
}
