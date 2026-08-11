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

// STUN alone only works when at least one side's router allows a direct
// connection. Behind a symmetric NAT — common on mobile networks and corporate
// Wi-Fi — the two browsers can see each other's addresses and still fail to
// talk. A TURN server relays the traffic in that case, at the cost of an extra
// hop. These are free public relays: better than a failed match, but a real
// dedicated server is what removes the problem for good.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp', // last resort через 443/TCP
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const PEER_OPTIONS = {
  debug: 0,
  config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 },
};

// Relaying can take noticeably longer to negotiate than a direct connection,
// so the wait is generous before giving up.
const JOIN_TIMEOUT_MS = 25000;

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
    // A wrong or closed room fails fast and separately, with "комната не
    // найдена". Reaching this timeout therefore means the host *was* found and
    // the two browsers still could not open a channel to each other — a
    // network problem, not a typo. Saying "check the code" here would send the
    // player looking in the wrong place.
    const timeout = setTimeout(() => {
      if (!conn?.open) {
        status(
          'Хост найден, но прямое соединение не установилось — мешает сеть ' +
          'или роутер. Попробуйте другую сеть (например, мобильный интернет) ' +
          'или пусть комнату создаст второй игрок.',
          'error',
        );
        reject(new Error('ice-timeout'));
      }
    }, JOIN_TIMEOUT_MS);

    peer.on('open', (myId) => {
      status('Подключаемся к комнате…');
      conn = peer.connect(peerId(code), { ...CONN_OPTIONS, metadata: { name } });

      // Watch the underlying WebRTC connection. When NAT traversal gives up it
      // says so, and reporting that immediately beats making the player stare
      // at a spinner until the timeout expires.
      const watchIce = () => {
        const pc = conn?.peerConnection;
        if (!pc) {
          if (!closed && !conn?.open) setTimeout(watchIce, 250);
          return;
        }
        pc.addEventListener('iceconnectionstatechange', () => {
          if (pc.iceConnectionState !== 'failed' || conn.open || closed) return;
          clearTimeout(timeout);
          status(
            'Не удалось пробиться к хосту через сеть. Помогает другая сеть ' +
            '(например, мобильный интернет) или поменяться ролями — пусть ' +
            'комнату создаст второй игрок.',
            'error',
          );
          reject(new Error('ice-failed'));
        });
      };
      watchIce();

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
