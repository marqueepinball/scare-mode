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
    // Optional extra TURN relay: ?turn=turn:host:port|username|password
    const t = qs.get('turn');
    if (t) {
      const [urls, username, credential] = t.split('|');
      o.config = { iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
        { urls, username, credential },
      ] };
    }
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
  function client({ role, getStream, onMessage, onStatus, onVideo }) {
    let peer = null, conn = null, call = null, lastSeen = 0, timer = null, connecting = false, tvCode = '';
    const status = s => onStatus && onStatus(s);
    const video = s => onVideo && onVideo(s);
    // Snapshot fallback: if live video never reaches the TV (venue Wi-Fi often
    // blocks it), send JPEG frames over the data link, which does get through.
    let callAt = 0, frameMode = false, fps = 0, frames = 0, fpsAt = Date.now(), waitAck = false, ackAt = 0;
    let grabVid = null, grabCv = null;
    const forceSnap = qs.get('snap') === '1'; // ?snap=1: skip live video, send snapshots only

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
        placeCall();
      });
      conn.on('data', d => {
        lastSeen = Date.now();
        if (d && d.tv && d.tv !== tvCode) { tvCode = d.tv; status('connected (TV code ' + tvCode + ')'); }
        if (!d || d.t === 'ping') return;
        if (d.t === 'fack') { waitAck = false; return; }
        if (d.t === 'vstat') { onVstat(d.ok); return; }
        if (onMessage) onMessage(d);
      });
      conn.on('close', () => { tvCode = ''; status('searching'); });
      conn.on('error', () => {});
    }

    function placeCall() {
      try { call && call.close(); } catch (e) {}
      call = null; callAt = Date.now();
      const stream = getStream && getStream();
      if (stream && peer && peer.open && !forceSnap) { call = peer.call(tvId, stream, { metadata: { role }, sdpTransform: preferH264 }); capSender(call); }
    }

    async function pathType(pc) {
      try {
        const st = await pc.getStats(); let pair = null; const c = {};
        st.forEach(r => { if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r; if (r.type === 'local-candidate') c[r.id] = r; });
        if (!pair) return 'none';
        const l = c[pair.localCandidateId]; return l ? (l.candidateType === 'relay' ? 'relay' : l.candidateType === 'host' ? 'direct' : 'via internet') : '?';
      } catch (e) { return '?'; }
    }

    async function onVstat(ok) {
      const stream = getStream && getStream();
      if (!stream) { frameMode = false; video('Video: no camera yet'); return; }
      const ice = call && call.peerConnection ? call.peerConnection.iceConnectionState : 'no call';
      if (ok) { frameMode = false; video('Video: LIVE on TV (' + ice + ')'); return; }
      const age = Date.now() - callAt;
      if ((age > 5000 || forceSnap) && !frameMode) {
        frameMode = true; pump();
        try { call && call.close(); } catch (e) {} call = null; // free the TV's video decoder
      }
      const dataPath = conn && conn.peerConnection ? await pathType(conn.peerConnection) : '?';
      video(frameMode ? `Video: SNAPSHOTS ${fps} fps (live call ${ice}, link ${dataPath})` : `Video: starting (call ${ice})`);
    }

    function pump() {
      if (!frameMode) return;
      const stream = getStream && getStream();
      if (!stream || !conn || !conn.open) { setTimeout(pump, 500); return; }
      if (waitAck && Date.now() - ackAt < 2000) { setTimeout(pump, 40); return; }
      if (!grabVid) {
        grabVid = document.createElement('video');
        grabVid.muted = true; grabVid.playsInline = true; grabVid.setAttribute('playsinline', '');
        grabVid.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
        document.body.appendChild(grabVid);
        grabCv = document.createElement('canvas');
      }
      if (grabVid.srcObject !== stream) grabVid.srcObject = stream;
      if (grabVid.paused) grabVid.play().catch(() => {});
      const vw = grabVid.videoWidth, vh = grabVid.videoHeight;
      if (!vw) { setTimeout(pump, 200); return; }
      const w = 480, h = Math.round(w * vh / vw);
      grabCv.width = w; grabCv.height = h;
      grabCv.getContext('2d').drawImage(grabVid, 0, 0, w, h);
      const t0 = Date.now();
      grabCv.toBlob(async b => {
        try {
          if (b && conn && conn.open) {
            const buf = await b.arrayBuffer();
            waitAck = true; ackAt = Date.now();
            conn.send({ t: 'frame', b: buf });
            frames++;
            if (Date.now() - fpsAt > 2000) { fps = Math.round(frames * 1000 / (Date.now() - fpsAt)); frames = 0; fpsAt = Date.now(); }
          }
        } catch (e) {}
        setTimeout(pump, Math.max(0, 90 - (Date.now() - t0)));
      }, 'image/jpeg', 0.6);
    }

    function teardown() {
      try { conn && conn.close(); } catch (e) {}
      try { call && call.close(); } catch (e) {}
      conn = null; call = null;
    }

    function send(msg) { if (conn && conn.open) { try { conn.send(msg); } catch (e) {} } }

    // Re-send the camera (e.g. after switching cameras)
    function restream() { teardown(); waitAck = false; frameMode = false; connecting = false; tick(); }

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

  return { room, tvId, peerOptions, client, keepAwake, link, qs, videoSize, preferH264, quality };
})();
