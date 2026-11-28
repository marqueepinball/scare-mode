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

  /* Video quality for phone cameras: ?q=low (default) | med | high */
  const Q = { low: [480, 360, 15, 350], med: [640, 480, 24, 700], high: [1280, 720, 30, 1500] };
  const quality = Q[qs.get('q')] ? qs.get('q') : 'low';
  const [qW, qH, qFps, qKbps] = Q[quality];
  function videoSize() { return { width: { ideal: qW }, height: { ideal: qH }, frameRate: { ideal: qFps, max: qFps } }; }

  /* Prefer H.264 so TV boxes can decode in hardware (VP8 is decoded in software). */
  function preferH264(sdp) {
    try {
      const L = sdp.split('\r\n');
      const mi = L.findIndex(l => l.startsWith('m=video'));
      if (mi < 0) return sdp;
      let end = L.findIndex((l, i) => i > mi && l.startsWith('m='));
      if (end < 0) end = L.length;
      const sec = L.slice(mi, end);
      const h264 = sec.filter(l => /^a=rtpmap:\d+ H264\//i.test(l)).map(l => l.match(/^a=rtpmap:(\d+)/)[1]);
      if (!h264.length) return sdp;
      // keep each H.264 payload's RTX partner right behind it
      const rtx = sec.filter(l => /^a=fmtp:\d+ apt=\d+/.test(l)).map(l => l.match(/^a=fmtp:(\d+) apt=(\d+)/));
      const first = [];
      h264.forEach(pt => { first.push(pt); rtx.filter(m => m[2] === pt).forEach(m => first.push(m[1])); });
      const parts = L[mi].split(' ');
      const pts = parts.slice(3);
      L[mi] = [...parts.slice(0, 3), ...first.filter(p => pts.includes(p)), ...pts.filter(p => !first.includes(p))].join(' ');
      return L.join('\r\n');
    } catch (e) { return sdp; }
  }

  /* Cap the camera's send bitrate/framerate once the call is up. */
  function capSender(call) {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      const pc = call && call.peerConnection;
      const snd = pc && pc.getSenders && pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (snd) {
        clearInterval(t);
        try {
          const p = snd.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = qKbps * 1000;
          p.encodings[0].maxFramerate = qFps;
          snd.setParameters(p).catch(() => {});
        } catch (e) {}
      } else if (tries > 20) clearInterval(t);
    }, 500);
  }
  const rid = () => Math.random().toString(36).slice(2, 8);

  /* A phone/control "client": keeps a data link (and optional media call)
   * to the TV alive, reconnecting forever. */
  function client({ role, getStream, onMessage, onStatus }) {
    let peer = null, conn = null, call = null, lastSeen = 0, timer = null, connecting = false, tvCode = '';
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
        if (stream) { call = peer.call(tvId, stream, { metadata: { role }, sdpTransform: preferH264 }); capSender(call); }
      });
      conn.on('data', d => {
        lastSeen = Date.now();
        if (d && d.tv && d.tv !== tvCode) { tvCode = d.tv; status('connected (TV code ' + tvCode + ')'); }
        if (d && d.t !== 'ping' && onMessage) onMessage(d);
      });
      conn.on('close', () => { tvCode = ''; status('searching'); });
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

  /* Camera zoom: hardware zoom where the phone supports it (Chrome on Android),
   * otherwise a digital zoom that the TV applies to that camera's picture.
   * ?zoom=2 sets it from the link; a picker on the page changes it live. */
  function zoomControl({ role, getStream, link, preview, after, mirror }) {
    const key = 'sm-' + role + '-zoom';
    let z = parseFloat(qs.get('zoom') || localStorage.getItem(key) || '1') || 1;
    const sel = document.createElement('select');
    sel.id = 'zoomSel';
    [1, 1.5, 2, 2.5, 3].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = 'Zoom ' + v + 'x'; sel.appendChild(o); });
    if (![1, 1.5, 2, 2.5, 3].includes(z)) { const o = document.createElement('option'); o.value = z; o.textContent = 'Zoom ' + z + 'x'; sel.appendChild(o); }
    sel.value = String(z);
    const row = document.createElement('div'); row.className = 'row'; row.style.marginTop = '8px'; row.appendChild(sel);
    after.parentNode.insertBefore(row, after.nextSibling);
    // clip the preview so a digital zoom shows what the TV will show
    const box = document.createElement('div');
    box.style.cssText = 'overflow:hidden;border-radius:8px;background:#000';
    preview.parentNode.insertBefore(box, preview); box.appendChild(preview);
    let digital = 1;
    async function apply() {
      digital = z;
      const stream = getStream && getStream();
      const t = stream && stream.getVideoTracks()[0];
      try {
        const caps = t && t.getCapabilities ? t.getCapabilities() : {};
        if (caps.zoom) {
          const hw = Math.max(caps.zoom.min, Math.min(caps.zoom.max, z));
          await t.applyConstraints({ advanced: [{ zoom: hw }] });
          digital = Math.max(1, z / hw);
        }
      } catch (e) {}
      preview.style.transform = `scale(${mirror ? -digital : digital}, ${digital})`;
      send();
    }
    function send() { link.send({ t: 'zoom', v: digital }); }
    sel.onchange = () => { z = parseFloat(sel.value) || 1; try { localStorage.setItem(key, String(z)); } catch (e) {} apply(); };
    return { apply, send };
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

  return { room, tvId, peerOptions, client, keepAwake, link, qs, zoomControl, videoSize, preferH264, quality };
})();
