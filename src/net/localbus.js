// Two windows of the same browser are already on the same machine. Making them
// talk through a broker, STUN, NAT traversal and a relay — the whole WebRTC
// apparatus, whose entire job is to cross a network that is not there — is how
// you end up unable to test a match on your own computer.
//
// A BroadcastChannel joins any windows of one browser on one origin, instantly
// and with nothing in between. It cannot reach another browser or another
// device: that is still WebRTC's job, and this only ever runs first because
// when it works, it works immediately.
//
// The shape of what these return matches the WebRTC transports exactly, so
// neither the session nor the game can tell which one it got.

const channelName = (code) => `gameforus-room-${code}`;
const newId = () => `bus-${Math.random().toString(36).slice(2, 10)}`;

// Every message says which way it travels, because a BroadcastChannel is a
// room, not a wire: a second client would otherwise read the first one's post
// to the host and answer it.
const UP = 'up'; // client -> host
const DOWN = 'down'; // host -> client

function emptyHandlers() {
  return { join: [], leave: [], message: [], status: [], error: [] };
}

export function createBusHost({ code, onStatus }) {
  const h = emptyHandlers();
  const peers = new Set();
  let bus = null;

  try {
    bus = new BroadcastChannel(channelName(code));
  } catch {
    return null; // no BroadcastChannel: nothing lost, WebRTC still runs
  }

  bus.onmessage = (e) => {
    const m = e.data;
    if (!m || m.dir !== UP) return;
    if (m.t === 'hello') {
      if (!peers.has(m.from)) {
        peers.add(m.from);
        onStatus?.(`Игрок подключился в этом браузере (${peers.size} в комнате).`, 'ok');
      }
      bus.postMessage({ dir: DOWN, t: 'welcome', to: m.from });
      h.join.forEach((fn) => fn(m.from, { name: m.name }));
    } else if (m.t === 'bye') {
      if (!peers.delete(m.from)) return;
      h.leave.forEach((fn) => fn(m.from));
    } else if (m.t === 'msg' && peers.has(m.from)) {
      h.message.forEach((fn) => fn(m.from, m.payload));
    }
  };

  return {
    kind: 'bus-host',
    handlers: h,
    has: (id) => peers.has(id),
    peerIds: () => [...peers],
    get peerCount() {
      return peers.size;
    },
    sendTo(id, msg) {
      if (peers.has(id)) bus.postMessage({ dir: DOWN, t: 'msg', to: id, payload: msg });
    },
    broadcast(msg) {
      if (peers.size) bus.postMessage({ dir: DOWN, t: 'msg', to: null, payload: msg });
    },
    close() {
      peers.clear();
      bus.close();
    },
  };
}

// Look for a host in this same browser. Resolves with a transport if one
// answers within `timeoutMs`, or null to say "not here, go over the network".
export function joinBus({ code, name, timeoutMs = 700 }) {
  return new Promise((resolve) => {
    let bus;
    try {
      bus = new BroadcastChannel(channelName(code));
    } catch {
      resolve(null);
      return;
    }

    const h = emptyHandlers();
    const myId = newId();
    let joined = false;
    const hostId = `host-${code}`;

    const giveUp = setTimeout(() => {
      if (joined) return;
      bus.close();
      resolve(null);
    }, timeoutMs);

    bus.onmessage = (e) => {
      const m = e.data;
      if (!m || m.dir !== DOWN) return;
      if (m.t === 'welcome' && m.to === myId && !joined) {
        joined = true;
        clearTimeout(giveUp);
        resolve({
          kind: 'client',
          code,
          local: true,
          ready: Promise.resolve(myId),
          get myId() {
            return myId;
          },
          onPeerJoin: (fn) => h.join.push(fn),
          onPeerLeave: (fn) => h.leave.push(fn),
          onMessage: (fn) => h.message.push(fn),
          onStatus: (fn) => h.status.push(fn),
          onError: (fn) => h.error.push(fn),
          send(msg) {
            bus.postMessage({ dir: UP, t: 'msg', from: myId, payload: msg });
          },
          sendTo(_id, msg) {
            this.send(msg);
          },
          broadcast(msg) {
            this.send(msg);
          },
          close() {
            bus.postMessage({ dir: UP, t: 'bye', from: myId });
            bus.close();
          },
        });
      } else if (m.t === 'msg' && (m.to === myId || m.to === null)) {
        h.message.forEach((fn) => fn(hostId, m.payload));
      }
    };

    bus.postMessage({ dir: UP, t: 'hello', from: myId, name });
  });
}
