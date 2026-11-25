/* Scare Mode: shared connection helpers.
 * Every page joins a "room" (a short code). The TV display is the hub:
 * phones and the control page connect to it over WebRTC (PeerJS).
 * Signaling uses the free PeerJS cloud by default; video and heartbeat
 * then flow directly between devices on the venue network.
 */
const SM = (() => {
  const qs = new URLSearchParams(location.search);
  const room = (qs.get('room') || localStorage.getItem('sm-room') || 'marquee')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24) || 'marquee';
  try { localStorage.setItem('sm-room', room); } catch (e) {}

  // Optional self-hosted signaling server: ?server=host:port[:path][:secure]
  function peerOptions() {
    const o = { debug: 1 };
    const s = qs.get('server');
    if (s) {
      const [host, port, path, secure] = s.split(':');
      Object.assign(o, { host, port: Number(port || 443), path: path || '/', secure: secure !== 'insecure' });
    }
    return o;
  }

  const tvId = `scaremode-${room}-tv`;
  const rid = () => Math.random().toString(36).slice(2, 8);

  /* A phone/control "client": keeps a data link (and optional media call)
   * to the TV alive, reconnecting forever. */
  function client({ role, getStream, onMessage, onStatus }) {
    let peer = null, conn = null, call = null, lastSeen = 0, timer = null, connecting = false;
    const status = s => onStatus && onStatus(s);

    function start() {
      peer = new Peer(`scaremode-${room}-${role}-${rid()}`, peerOptions());
      peer.on('open', () => { status('searching'); tick(); });
      peer.on('error', err => {
        if (err.type === 'peer-unavailable') { status('waiting for TV'); connecting = false; }
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { status('offline'); }
        else console.warn(err.type, err);
      });
      peer.on('disconnected', () => { status('reconnecting'); setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 1500); });
      timer = setInterval(tick, 2000);
    }

    function alive() { return conn && conn.open && Date.now() - lastSeen < 7000; }

    function tick() {
      if (!peer || !peer.open) return;
      if (alive()) { send({ t: 'ping' }); return; }
      if (connecting && Date.now() - connecting < 6000) return;
      teardown();
      connecting = Date.now();
      conn = peer.connect(tvId, { reliable: true, metadata: { role } });
      conn.on('open', () => {
        connecting = false; lastSeen = Date.now(); status('connected');
        send({ t: 'hello', role });
        const stream = getStream && getStream();
        if (stream) call = peer.call(tvId, stream, { metadata: { role } });
      });
      conn.on('data', d => { lastSeen = Date.now(); if (d && d.t !== 'ping' && onMessage) onMessage(d); });
      conn.on('close', () => { status('searching'); });
      conn.on('error', () => {});
    }

    function teardown() {
      try { conn && conn.close(); } catch (e) {}
      try { call && call.close(); } catch (e) {}
      conn = null; call = null;
    }

    function send(msg) { if (conn && conn.open) { try { conn.send(msg); } catch (e) {} } }

    // Re-send the camera (e.g. after switching cameras)
    function restream() { teardown(); connecting = false; tick(); }

    start();
    return { send, restream, isConnected: alive };
  }

  /* Keep the phone screen on. */
  async function keepAwake() {
    let lock = null;
    async function get() { try { lock = await navigator.wakeLock.request('screen'); } catch (e) {} }
    if ('wakeLock' in navigator) {
      await get();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') get(); });
    }
  }

  function link(page) {
    const p = new URLSearchParams(location.search); p.set('room', room);
    return `${page}?${p.toString()}`;
  }

  return { room, tvId, peerOptions, client, keepAwake, link, qs };
})();
