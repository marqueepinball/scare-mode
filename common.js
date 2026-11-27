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


  /* Camera picker shared by the camera pages.
   * Lists every video input (phone cameras, a laptop's built-in webcam, or a
   * GoPro / other USB camera in webcam mode), remembers the pick per page, and
   * switches back to it automatically when it is plugged in again.
   * The first entry is the page's default (phone back or front camera), so
   * phones work exactly as before with nothing picked. */
  function camera({ select, button, note, storageKey, facing, size, defaultLabel, onStream, onError }) {
    const md = navigator.mediaDevices;
    const store = {
      get() { try { return JSON.parse(localStorage.getItem(storageKey) || 'null') || legacy(); } catch (e) { return legacy(); } },
      set(v) { try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch (e) {} },
    };
    // Older versions stored a bare deviceId string under the same key
    function legacy() { try { const v = localStorage.getItem(storageKey); return v && v[0] !== '{' ? { id: v, label: '' } : { id: '', label: '' }; } catch (e) { return { id: '', label: '' }; } }

    let want = store.get();         // what the user picked: { id, label }, id '' = default
    let stream = null, devs = [], starting = null, restartTimer = null;
    const say = t => { if (note) note.textContent = t || ''; };
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    // Find the wanted camera in the current device list. deviceIds can change
    // between visits on some browsers, so fall back to matching the name.
    function resolve() {
      if (!want.id) return null;
      return devs.find(d => d.deviceId === want.id) || (want.label && devs.find(d => d.label === want.label)) || null;
    }

    async function list() {
      if (!md || !md.enumerateDevices) return;
      devs = (await md.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId);
      const cur = resolve();
      let opts = `<option value="">${esc(defaultLabel)}</option>` +
        devs.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
      // Keep showing a remembered camera that is unplugged right now
      if (want.id && !cur) opts += `<option value="${esc(want.id)}">${esc((want.label || 'Saved camera') + ' (not connected)')}</option>`;
      select.innerHTML = opts;
      select.value = cur ? cur.deviceId : want.id;
    }

    function activeId() {
      const t = stream && stream.getVideoTracks()[0];
      return t && t.readyState === 'live' ? (t.getSettings().deviceId || '') : null;
    }

    async function open(dev) {
      const video = dev ? { deviceId: { exact: dev.deviceId }, ...size } : { facingMode: { ideal: facing }, ...size };
      return md.getUserMedia({ audio: false, video });
    }

    async function start() {
      if (starting) return starting;
      starting = (async () => {
        clearTimeout(restartTimer);
        if (!md || !md.getUserMedia) { onError && onError(new Error('This browser has no camera access. Open the page over https in Safari or Chrome.')); return; }
        if (stream) stream.getTracks().forEach(t => t.stop());
        stream = null;
        await list().catch(() => {});
        const dev = resolve();
        let usedDefault = !dev;
        try {
          if (want.id && !dev) throw Object.assign(new Error('not connected'), { name: 'NotFoundError' });
          stream = await open(dev);
        } catch (e) {
          if (!want.id || !['NotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError'].includes(e.name)) { onError && onError(e); return; }
          // Picked camera is unplugged or busy: run on the default camera for now,
          // keep the pick, and switch back when it shows up again.
          try { stream = await open(null); usedDefault = true; }
          catch (e2) { onError && onError(e2); return; }
          say(`${want.label || 'Picked camera'} is not available${e.name === 'NotReadableError' ? ' (another app may be using it)' : ''}. Using the default camera until it is connected.`);
        }
        if (!usedDefault || !want.id) say('');
        // Now that permission is granted, names and ids are visible: refresh the
        // list, and if the picked camera only shows up now, switch to it.
        await list().catch(() => {});
        const late = usedDefault && resolve();
        if (late) {
          try {
            const s2 = await open(late);
            stream.getTracks().forEach(t => t.stop());
            stream = s2; usedDefault = false; say('');
            want = { id: late.deviceId, label: late.label || want.label }; store.set(want);
            select.value = late.deviceId;
          } catch (e) { /* stay on the default camera */ }
        }
        if (dev) { want = { id: dev.deviceId, label: dev.label || want.label }; store.set(want); }
        stream.getVideoTracks().forEach(t => t.onended = () => { restartTimer = setTimeout(start, 1000); });
        if (button) button.textContent = 'Restart camera';
        onStream && onStream(stream);
      })();
      try { await starting; } finally { starting = null; }
    }

    function pick() {
      const id = select.value;
      const d = devs.find(x => x.deviceId === id);
      want = id ? { id, label: d ? d.label : want.label } : { id: '', label: '' };
      store.set(want);
      start();
    }

    select.onchange = pick;
    if (button) button.onclick = start;
    // USB camera plugged in or out
    if (md && md.addEventListener) md.addEventListener('devicechange', async () => {
      await list().catch(() => {});
      const dev = resolve(), act = activeId();
      if (dev && act !== dev.deviceId) start();          // picked camera came back
      else if (act === null && !starting) start();        // current camera vanished
    });

    return { start, list, get stream() { return stream; } };
  }

  return { room, tvId, peerOptions, client, keepAwake, link, qs, camera };
})();
