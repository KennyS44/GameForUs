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

import { createBusHost, joinBus } from './localbus.js?v=1a8eeedb';

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
// connection. Two players on one network are the awkward case rather than the
// easy one: their public addresses are identical, so the pair that would have
// to work is the local one — and browsers hide local addresses behind mDNS
// `.local` names that another browser often cannot resolve. Then the only way
// through is a TURN relay.
//
// The first entry is PeerJS's own free relay, which ships with the library and
// is the one that has always actually answered; the list used to replace it
// wholesale with a relay that has since been retired, leaving no fallback at
// all. Free relays are better than a failed match, not a guarantee — a real
// dedicated server is what removes the problem for good.
const ICE_SERVERS = [
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
  {
    urls: [
      'turn:staticauth.openrelay.metered.ca:80',
      'turn:staticauth.openrelay.metered.ca:443',
      'turn:staticauth.openrelay.metered.ca:443?transport=tcp', // last resort over 443/TCP
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
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

  // Windows of this same browser reach the room without touching the network
  // at all. They arrive through the same join/leave/message handlers as anyone
  // else, so nothing downstream knows the difference.
  const bus = createBusHost({ code, onStatus: status });
  if (bus) {
    bus.handlers.join.push((id, meta) => h.join.forEach((fn) => fn(id, meta)));
    bus.handlers.leave.push((id) => h.leave.forEach((fn) => fn(id)));
    bus.handlers.message.push((id, msg) => h.message.forEach((fn) => fn(id, msg)));
  }

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
      return conns.size + (bus?.peerCount ?? 0);
    },
    peerIds: () => [...conns.keys(), ...(bus?.peerIds() ?? [])],
    onPeerJoin: (fn) => h.join.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onMessage: (fn) => h.message.push(fn),
    onStatus: (fn) => h.status.push(fn),
    onError: (fn) => h.error.push(fn),
    sendTo(id, msg) {
      if (bus?.has(id)) {
        bus.sendTo(id, msg);
        return;
      }
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
      bus?.broadcast(msg);
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
      bus?.close();
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
  let relayFound = false;

  const status = (msg, kind = 'info') => {
    onStatus?.(msg, kind);
    h.status.forEach((fn) => fn(msg, kind));
  };

  // If the host is another window of this browser, the answer comes back in
  // milliseconds and the network is never involved.
  const overTheNetwork = () => loadPeerLib().then((Peer) => new Promise((resolve, reject) => {
    peer = new Peer(PEER_OPTIONS);
    // A wrong or closed room fails fast and separately, with "комната не
    // найдена". Reaching this timeout therefore means the host *was* found and
    // the two browsers still could not open a channel to each other — a
    // network problem, not a typo. Saying "check the code" here would send the
    // player looking in the wrong place.
    const timeout = setTimeout(() => {
      if (conn?.open) return;
      // Two ways to fail, and they need different advice. No relay candidate
      // at all means every free TURN server was unreachable, so there was
      // never a fallback to try; with one gathered, the relay was there and
      // the pair still would not form.
      status(
        relayFound
          ? 'Хост найден, но канал так и не открылся. Помогает другая сеть ' +
            '(например, мобильный интернет) или поменяться ролями.'
          : 'Хост найден, но пробиться к нему не вышло: ретранслятор недоступен, ' +
            'а напрямую мешает сеть или роутер. Если оба игрока за одним ' +
            'роутером, надёжнее всего открыть второе окно того же браузера — ' +
            'они соединяются напрямую, без сети.',
        'error',
      );
      reject(new Error('ice-timeout'));
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
        // Remember whether a relay was ever on the table, so the failure can
        // say which of the two problems it was.
        pc.addEventListener('icecandidate', (e) => {
          if (e.candidate && / typ relay /.test(e.candidate.candidate)) relayFound = true;
        });
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

  // The bus answers or it does not; either way the network path is only tried
  // once, and the caller sees one promise.
  let route = null;
  const ready = joinBus({ code, name }).then((local) => {
    if (closed) return null;
    if (local) {
      route = local;
      status('Подключено ко второму окну этого браузера.', 'ok');
      local.onMessage((id, msg) => h.message.forEach((fn) => fn(id, msg)));
      return local.ready;
    }
    return overTheNetwork();
  });

  return {
    kind: 'client',
    code,
    ready,
    get myId() {
      return route?.myId ?? peer?.id;
    },
    onPeerJoin: (fn) => h.join.push(fn),
    onPeerLeave: (fn) => h.leave.push(fn),
    onMessage: (fn) => h.message.push(fn),
    onStatus: (fn) => h.status.push(fn),
    onError: (fn) => h.error.push(fn),
    send(msg) {
      if (route) {
        route.send(msg);
        return;
      }
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
      route?.close();
      conn?.close();
      peer?.destroy();
    },
  };
}
