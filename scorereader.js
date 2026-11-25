/* Scare Mode score reader.
 * Turns a phone-camera frame of a pinball score display (DMD or LCD) into digits,
 * entirely in the browser. No OCR library: the operator marks the screen corners,
 * boxes the score, and teaches the machine's own digit font a few times. Each
 * glyph is then matched against those examples (nearest template), and anything
 * that does not look clearly like a known digit is rejected rather than guessed.
 */
const ScoreReader = (() => {
  const GW = 12, GH = 18, N = GW * GH;

  /* Projective map from the unit square onto a quad [TL, TR, BR, BL] in pixels. */
  function quadMap(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let a, b, c = x0, d, e, f = y0, g = 0, h = 0;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      a = x1 - x0; b = x2 - x1; d = y1 - y0; e = y2 - y1;
    } else {
      const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
      a = x1 - x0 + g * x1; b = x3 - x0 + h * x3;
      d = y1 - y0 + g * y1; e = y3 - y0 + h * y3;
    }
    return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
  }

  /* Sample sub-rect r (0..1 of the display) through map M into a W x H RGBA image.
   * src is ImageData whose top-left sits at (ox, oy) in camera pixels. */
  function rectify(src, ox, oy, M, r, W, H) {
    const out = new Uint8ClampedArray(W * H * 4), sd = src.data, sw = src.width, sh = src.height;
    for (let j = 0; j < H; j++) {
      const v = r.y + (j + .5) / H * r.h;
      for (let i = 0; i < W; i++) {
        const u = r.x + (i + .5) / W * r.w;
        const pt = M(u, v), x = pt[0] - ox - .5, y = pt[1] - oy - .5, o = (j * W + i) * 4;
        out[o + 3] = 255;
        if (!(x >= 0 && y >= 0 && x < sw - 1 && y < sh - 1)) continue;
        const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, p = (yi * sw + xi) * 4, q = p + sw * 4;
        for (let k = 0; k < 3; k++) {
          const t = sd[p + k] + (sd[p + 4 + k] - sd[p + k]) * fx, bt = sd[q + k] + (sd[q + 4 + k] - sd[q + k]) * fx;
          out[o + k] = t + (bt - t) * fy;
        }
      }
    }
    return { width: W, height: H, data: out };
  }

  /* DMD helper: snap a box (0..1) to whole dots of a cols x rows panel. */
  function dotBox(r, cols, rows) {
    const x0 = Math.max(0, Math.floor(r.x * cols)), y0 = Math.max(0, Math.floor(r.y * rows));
    const x1 = Math.min(cols, Math.ceil((r.x + r.w) * cols)), y1 = Math.min(rows, Math.ceil((r.y + r.h) * rows));
    return { nx: Math.max(1, x1 - x0), ny: Math.max(1, y1 - y0), r: { x: (x0 - .5) / cols, y: (y0 - .5) / rows, w: (x1 - x0 + 1) / cols, h: (y1 - y0 + 1) / rows } };
  }

  /* DMD helper: img covers (nx+1) x (ny+1) dots at P px per dot (half a dot of margin
   * each side). Find the grid phase where dots are sharpest, read each dot's centre,
   * and return a clean bitmap with each dot drawn as an S x S block. Gaps between
   * glyphs stay exactly one dot wide, so digits look identical every time. */
  function dotSample(img, nx, ny, P = 4, S = 3) {
    const { width: w, data: d } = img;
    const lum = new Float32Array(img.width * img.height);
    for (let i = 0; i < lum.length; i++) lum[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const cell = (px, py, i, j) => {
      const x = px + i * P + (P >> 1) - 1, y = py + j * P + (P >> 1) - 1, p = y * w + x;
      return (lum[p] + lum[p + 1] + lum[p + w] + lum[p + w + 1]) / 4;
    };
    let best = -1, bx = 0, by = 0;
    for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) {
      let s = 0, s2 = 0, n = 0;
      for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) { const v = cell(px, py, i, j); s += v; s2 += v * v; n++; }
      const v = s2 / n - (s / n) * (s / n);
      if (v > best) { best = v; bx = px; by = py; }
    }
    const W = nx * S, H = ny * S, out = new Uint8ClampedArray(W * H * 4);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      // average the RGB of the dot centre, keep colour for colour-match mode
      const x = bx + i * P + (P >> 1) - 1, y = by + j * P + (P >> 1) - 1, c = [0, 0, 0];
      for (const q of [0, 1, w, w + 1]) { const p = (y * w + x + q) * 4; c[0] += d[p]; c[1] += d[p + 1]; c[2] += d[p + 2]; }
      for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
        const o = ((j * S + yy) * W + i * S + xx) * 4; out[o] = c[0] / 4; out[o + 1] = c[1] / 4; out[o + 2] = c[2] / 4; out[o + 3] = 255;
      }
    }
    return { width: W, height: H, data: out };
  }

  function boxBlur(f, w, h, r) {
    if (r < 1) return f;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let k = -r; k <= r; k++) s += f[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / n;
        s += f[row + Math.min(w - 1, x + r + 1)] - f[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /* How much each pixel looks like "digit ink", 0..255. */
  function inkMap(img, o) {
    const { width: w, height: h, data: d } = img, f = new Float32Array(w * h);
    const c = o.color || [255, 255, 255], tol = o.tol || 70;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], mx = Math.max(r, g, b);
      if (o.mode === 'dark') f[i] = 255 - mx;
      else if (o.mode === 'color') f[i] = Math.max(0, 255 * (1 - Math.hypot(r - c[0], g - c[1], b - c[2]) / (2 * tol)));
      else f[i] = mx;
    }
    return boxBlur(f, w, h, o.blur | 0);
  }

  function otsu(f) {
    const hist = new Float64Array(256);
    for (let i = 0; i < f.length; i++) hist[Math.max(0, Math.min(255, f[i] | 0))]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wb = 0, sb = 0, best = -1, t = 128, m0 = 0, m1 = 0;
    for (let i = 0; i < 256; i++) {
      wb += hist[i]; if (!wb) continue;
      const wf = f.length - wb; if (!wf) break;
      sb += i * hist[i];
      const mb = sb / wb, mf = (sum - sb) / wf, v = wb * wf * (mb - mf) * (mb - mf);
      if (v > best) { best = v; t = i; m0 = mb; m1 = mf; }
    }
    return { t, contrast: m1 - m0 };
  }

  /* Split the binary mask into glyphs, left to right, using connected blobs.
   * Blobs inside a digit's box (e.g. the dot in a slashed zero) join that digit;
   * small blobs outside (commas, dots, specks) are dropped; touching digits are
   * split by the typical digit width. */
  function segment(mask, w, h) {
    const lab = new Int32Array(w * h), comps = [], st = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      const id = comps.length + 1, c = { ids: [id], x0: w, x1: -1, y0: h, y1: -1, n: 0 };
      lab[i] = id; st.push(i);
      while (st.length) {
        const p = st.pop(), x = p % w, y = (p - x) / w; c.n++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; st.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; st.push(p + 1); }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; st.push(p - w); }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; st.push(p + w); }
      }
      comps.push(c);
      if (comps.length > 400) return { glyphs: [], lab, busy: true };
    }
    if (!comps.length) return { glyphs: [], lab };
    const H = b => b.y1 - b.y0 + 1, Wd = b => b.x1 - b.x0 + 1;
    const maxH = Math.max(...comps.map(H));
    let big = comps.filter(c => H(c) >= .62 * maxH).sort((p, q) => p.x0 - q.x0);
    // tall blobs that overlap heavily in x are one broken glyph
    const merged = [];
    for (const c of big) {
      const m = merged[merged.length - 1];
      if (m && Math.min(m.x1, c.x1) - Math.max(m.x0, c.x0) + 1 >= .5 * Math.min(Wd(m), Wd(c))) {
        m.ids.push(...c.ids); m.x0 = Math.min(m.x0, c.x0); m.x1 = Math.max(m.x1, c.x1); m.y0 = Math.min(m.y0, c.y0); m.y1 = Math.max(m.y1, c.y1);
      } else merged.push(c);
    }
    big = merged;
    for (const c of comps) {
      if (H(c) >= .62 * maxH) continue;
      const g = big.find(g => c.x0 >= g.x0 - 1 && c.x1 <= g.x1 + 1 && c.y0 >= g.y0 - 1 && c.y1 <= g.y1 + 1);
      if (g) g.ids.push(...c.ids);
    }
    const wide = big.filter(b => Wd(b) >= .45 * H(b)).map(Wd).sort((p, q) => p - q);
    const medW = wide.length ? wide[wide.length >> 1] : 0;
    let glyphs = big;
    if (medW) {
      glyphs = [];
      for (const b of big) {
        const n = Math.round(Wd(b) / medW);
        if (Wd(b) > 1.6 * medW && n > 1) {
          for (let k = 0; k < n; k++) {
            const x0 = Math.round(b.x0 + k * Wd(b) / n), x1 = Math.round(b.x0 + (k + 1) * Wd(b) / n) - 1;
            let y0 = h, y1 = -1;
            for (let y = b.y0; y <= b.y1; y++) for (let x = x0; x <= x1; x++) if (b.ids.includes(lab[y * w + x])) { if (y < y0) y0 = y; y1 = y; }
            if (y1 >= 0) glyphs.push({ ids: b.ids, x0, x1, y0, y1 });
          }
        } else glyphs.push(b);
      }
    }
    return { glyphs, lab };
  }

  /* Sample a glyph onto a GW x GH grid. All glyphs in a reading share the line's
   * top/bottom and scale, so a "1" stays narrow and a comma-free row stays aligned. */
  function features(ink, w, H, b, line, lab) {
    const ids = new Set(b.ids);
    const lh = line.y1 - line.y0 + 1, s = GH / lh, cx = (b.x0 + b.x1 + 1) / 2;
    const f = new Float32Array(N);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      let acc = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const X = Math.floor(cx + (gx + (sx + .5) / 3 - GW / 2) / s), Y = Math.floor(line.y0 + (gy + (sy + .5) / 3) / s);
        if (X >= b.x0 && X <= b.x1 && Y >= line.y0 && Y <= line.y1 && ids.has(lab[Y * w + X])) acc += ink[Y * w + X];
      }
      f[gy * GW + gx] = acc / 9;
    }
    return { f, a: (b.x1 - b.x0 + 1) / lh, s: lh / H };
  }

  function dist(x, t) {
    let s = 0; for (let i = 0; i < N; i++) s += Math.abs(x.f[i] - t.f[i]);
    s = s / N + .3 * Math.abs(Math.log(x.a / t.a));
    // Fonts change size as scores grow; a template taught at another size should not match.
    if (t.s && x.s) s += .6 * Math.max(0, Math.abs(Math.log(x.s / t.s)) - .12);
    return s;
  }

  function classify(x, T) {
    let best = null, bd = 9, sd = 9;
    for (const d in T) {
      let m = 9; for (const t of T[d]) m = Math.min(m, dist(x, t));
      if (m < bd) { sd = bd; bd = m; best = d; } else if (m < sd) sd = m;
    }
    return { d: best, dist: bd, margin: sd - bd };
  }

  /* Read one score image. o: {mode, color, tol, blur, maxDist, minMargin, minContrast} */
  function read(img, o, T) {
    const { width: w, height: h } = img, f = inkMap(img, o);
    const th = o.mode === 'color' ? { t: 127, contrast: 255 } : otsu(f);
    const mask = new Uint8Array(w * h);
    const soft = new Float32Array(w * h), k = 2 / Math.max(20, th.contrast);
    for (let i = 0; i < f.length; i++) { mask[i] = f[i] > th.t ? 1 : 0; soft[i] = Math.max(0, Math.min(1, (f[i] - th.t) * k + .5)); }
    const res = { ok: false, text: '', glyphs: [], mask, w, h, conf: 0, reason: '' };
    if (th.contrast < (o.minContrast || 40)) { res.reason = 'No clear digits'; return res; }
    const seg = segment(mask, w, h), boxes = seg.glyphs;
    if (seg.busy) { res.reason = 'Too busy'; return res; }
    if (!boxes.length || boxes[0].y1 - boxes[0].y0 < 6) { res.reason = 'No clear digits'; return res; }
    if (boxes.length > 16) { res.reason = 'Too busy'; return res; }
    res.edge = boxes[0].x0 <= 0 || boxes[boxes.length - 1].x1 >= w - 1;
    const learned = T && Object.keys(T).length;
    const maxD = o.maxDist || .14, minM = o.minMargin == null ? .025 : o.minMargin;
    let conf = 1;
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    const line = { y0: med(boxes.map(b => b.y0)), y1: med(boxes.map(b => b.y1)) };
    // Measure each glyph's width from its upper 80% only, so a comma touching
    // its foot does not widen it.
    const cut = line.y0 + Math.floor(.8 * (line.y1 - line.y0 + 1));
    for (const b of boxes) {
      const ids = new Set(b.ids); let x0 = w, x1 = -1;
      for (let y = Math.max(0, line.y0); y < cut; y++) for (let x = b.x0; x <= b.x1; x++) if (ids.has(seg.lab[y * w + x])) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      if (x1 >= x0) { b.x0 = x0; b.x1 = x1; }
    }
    for (const b of boxes) {
      const x = features(soft, w, h, b, line, seg.lab), g = { box: b, x, d: null, ok: false };
      if (learned) {
        const c = classify(x, T); g.d = c.d; g.dist = c.dist;
        g.ok = c.dist <= maxD && (Object.keys(T).length < 2 || c.margin >= minM);
        conf = Math.min(conf, Math.max(0, 1 - c.dist / maxD), Math.min(1, c.margin / .1));
      }
      res.glyphs.push(g);
    }
    res.text = res.glyphs.map(g => g.ok ? g.d : '?').join('');
    res.ok = !!learned && !res.edge && res.glyphs.every(g => g.ok);
    res.conf = res.ok ? conf : 0;
    if (!learned) res.reason = 'Teach the digits';
    else if (res.edge) res.reason = 'A digit touches the edge of the box';
    else if (!res.ok) res.reason = 'Unsure: ' + res.text;
    return res;
  }

  /* Store the glyphs of a frozen reading as examples of the digits typed in. */
  function learn(reading, typed, T, cap = 6) {
    const digits = String(typed).replace(/\D/g, '');
    const n = reading.glyphs.length;
    if (!digits.length) return { ok: false, msg: 'Type the digits you see.' };
    if (reading.edge) return { ok: false, msg: 'A digit touches the edge of the score box. Make the box a little wider so the whole score fits inside.' };
    if (digits.length !== n) return { ok: false, msg: `I see ${n} digit${n === 1 ? '' : 's'} in the box but you typed ${digits.length}. Adjust the box or color, or wait for a clearer frame.` };
    reading.glyphs.forEach((g, i) => {
      const d = digits[i], list = T[d] || (T[d] = []);
      list.push({ f: Array.from(g.x.f, v => Math.round(v * 100) / 100), a: Math.round(g.x.a * 1000) / 1000, s: Math.round(g.x.s * 1000) / 1000 });
      if (list.length > cap) list.shift();
    });
    return { ok: true, msg: `Learned ${digits}.` };
  }

  /* Coarse whole-screen signature for recognising mode/award screens. */
  function sceneSig(img, cols = 48) {
    const { width: w, height: h, data: d } = img, rows = Math.max(4, Math.round(cols * h / w));
    const s = new Float32Array(cols * rows), n = new Float32Array(cols * rows);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, k = Math.floor(y * rows / h) * cols + Math.floor(x * cols / w);
      s[k] += Math.max(d[p], d[p + 1], d[p + 2]); n[k]++;
    }
    let m = 0; for (let i = 0; i < s.length; i++) { s[i] /= n[i] || 1; m += s[i]; }
    m /= s.length; let v = 0;
    for (let i = 0; i < s.length; i++) { s[i] -= m; v += s[i] * s[i]; }
    v = Math.sqrt(v) || 1; for (let i = 0; i < s.length; i++) s[i] /= v;
    return { cols, rows, s: Array.from(s, x => Math.round(x * 1e4) / 1e4), flat: v < 1e-3 * s.length };
  }
  function sceneMatch(a, b) {
    if (!a || !b || a.s.length !== b.s.length) return 0;
    let c = 0; for (let i = 0; i < a.s.length; i++) c += a.s[i] * b.s[i];
    return c;
  }

  /* Turns noisy per-frame readings into a trustworthy score.
   * A value must repeat on consecutive frames. Scores only go up during a game,
   * so a lower value is accepted only after it has persisted for a few seconds
   * (that covers a misread that slipped through, or a new game). */
  function Tracker(opts = {}) {
    const need = opts.repeat || 2, lowerMs = opts.lowerMs || 3000;
    let value = null, cand = null, count = 0, lowerSince = 0;
    return {
      get value() { return value; },
      reset() { value = null; cand = null; count = 0; lowerSince = 0; },
      push(reading, now = Date.now()) {
        if (!reading || !reading.ok || !reading.text) { count = 0; cand = null; return false; }
        const v = Number(reading.text);
        if (!Number.isFinite(v)) return false;
        if (v === cand) count++; else { cand = v; count = 1; }
        if (value === null || v >= value) {
          lowerSince = 0;
          if (count >= need && v !== value) { value = v; return true; }
          return false;
        }
        if (!lowerSince) lowerSince = now;
        if (now - lowerSince >= lowerMs && count >= need) { value = v; lowerSince = 0; return true; }
        return false;
      }
    };
  }

  return { quadMap, rectify, dotBox, dotSample, read, learn, sceneSig, sceneMatch, Tracker, inkMap, segment };
})();
if (typeof module !== 'undefined') module.exports = ScoreReader;
