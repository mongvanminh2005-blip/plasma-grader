// =====================================================================
// TubeSeg — chạy mô hình YOLO segment (ONNX) ngay trong trình duyệt
// Khoanh vùng: nắp, headspace, plasma, hồng cầu
// =====================================================================
(() => {
  const MODEL_URL = 'model/tube-seg.onnx?v=1';
  const META_URL = 'model/meta.json?v=1';
  const CONF = 0.25, IOU = 0.7, MASK_THR = 0.5, MAX_DET = 30;

  let session = null, meta = null, loading = null;

  async function load(onProgress) {
    if (session) return;
    if (loading) return loading;
    loading = (async () => {
      meta = await (await fetch(META_URL)).json();
      ort.env.wasm.numThreads = 1;
      // tải mô hình kèm tiến độ
      const res = await fetch(MODEL_URL);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader(); const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); got += value.length; if (total && onProgress) onProgress(got / total);
      }
      const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    try { await loading; } finally { loading = null; }
  }

  // letterbox giống Ultralytics: giữ tỉ lệ, đệm màu 114 ở giữa
  function preprocess(bmp, S) {
    const r = Math.min(S / bmp.width, S / bmp.height);
    const nw = Math.round(bmp.width * r), nh = Math.round(bmp.height * r);
    const dx = (S - nw) / 2, dy = (S - nh) / 2;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(bmp, Math.round(dx - 0.1), Math.round(dy - 0.1), nw, nh);
    const px = ctx.getImageData(0, 0, S, S).data, N = S * S, t = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { t[i] = px[i * 4] / 255; t[N + i] = px[i * 4 + 1] / 255; t[2 * N + i] = px[i * 4 + 2] / 255; }
    return { tensor: new ort.Tensor('float32', t, [1, 3, S, S]), r, dx: Math.round(dx - 0.1), dy: Math.round(dy - 0.1) };
  }

  const iou = (a, b) => {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
  };

  // dò đường viền ngoài của vùng lớn nhất trong mặt nạ nhị phân (Moore neighbour tracing)
  function traceContour(mask, w, h) {
    // chọn thành phần liên thông lớn nhất
    const lab = new Int32Array(w * h); let best = -1, bestN = 0, id = 0;
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i] || lab[i]) continue;
      id++; let n = 0; stack.push(i); lab[i] = id;
      while (stack.length) {
        const p = stack.pop(); n++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = id; }
    }
    if (best < 0) return [];
    const inR = (x, y) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === best;
    let sx = -1, sy = -1;
    outer: for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inR(x, y)) { sx = x; sy = y; break outer; }
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const pts = [[sx, sy]]; let cx = sx, cy = sy, d = 6, guard = 0;
    do {
      let found = false;
      for (let k = 0; k < 8; k++) {
        const nd = (d + 6 + k) % 8, nx = cx + dirs[nd][0], ny = cy + dirs[nd][1];
        if (inR(nx, ny)) { cx = nx; cy = ny; d = nd; found = true; break; }
      }
      if (!found) break;
      pts.push([cx, cy]);
    } while ((cx !== sx || cy !== sy) && ++guard < 20000);
    return pts;
  }

  // đơn giản hoá đường viền khép kín: tách thành 2 nửa tại điểm xa điểm đầu nhất
  function simplifyClosed(pts, eps) {
    if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts = pts.slice(0, -1);
    if (pts.length < 4) return pts;
    let far = 0, fd = -1;
    pts.forEach((p, i) => { const d = (p[0] - pts[0][0]) ** 2 + (p[1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } });
    const a = simplify(pts.slice(0, far + 1), eps), b = simplify(pts.slice(far).concat([pts[0]]), eps);
    return a.concat(b.slice(1, -1));
  }

  // đơn giản hoá đường gấp khúc (Douglas–Peucker)
  function simplify(pts, eps) {
    if (pts.length < 4) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1;
      for (let i = a + 1; i < b; i++) {
        const dd = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / L;
        if (dd > md) { md = dd; mi = i; }
      }
      if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  async function run(bmp) {
    const S = meta.imgsz, nc = meta.nc, nm = meta.nm;
    const { tensor, r, dx, dy } = preprocess(bmp, S);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const o0 = out[session.outputNames[0]], o1 = out[session.outputNames[1]];
    const [, C, N] = o0.dims, d0 = o0.data;
    const [, , ph, pw] = o1.dims, protos = o1.data;

    // 1. lọc theo độ tin cậy
    let cands = [];
    for (let i = 0; i < N; i++) {
      let best = 0, cls = -1;
      for (let c = 0; c < nc; c++) { const s = d0[(4 + c) * N + i]; if (s > best) { best = s; cls = c; } }
      if (best < CONF) continue;
      const cx = d0[i], cy = d0[N + i], w = d0[2 * N + i], h = d0[3 * N + i];
      const coef = new Float32Array(nm); for (let k = 0; k < nm; k++) coef[k] = d0[(4 + nc + k) * N + i];
      cands.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], conf: best, cls, coef });
    }
    // 2. NMS theo từng lớp
    cands.sort((a, b) => b.conf - a.conf);
    const keep = [];
    for (const c of cands) {
      if (keep.length >= MAX_DET) break;
      if (keep.every(k => k.cls !== c.cls || iou(k.box, c.box) <= IOU)) keep.push(c);
    }
    // 3. mặt nạ: hệ số × prototype, lấy mẫu song tuyến ở độ phân giải đầu vào, cắt trong khung
    const sx = pw / S, sy = ph / S, W0 = bmp.width, H0 = bmp.height;
    const regions = [];
    for (const k of keep) {
      const [bx1, by1, bx2, by2] = k.box.map(v => Math.max(0, Math.min(S, v)));
      const x0 = Math.floor(bx1), y0 = Math.floor(by1), mw = Math.max(1, Math.ceil(bx2) - x0), mh = Math.max(1, Math.ceil(by2) - y0);
      // logit mặt nạ trên lưới prototype (chỉ trong vùng khung, có viền 1 ô)
      const gx0 = Math.max(0, Math.floor(bx1 * sx) - 1), gy0 = Math.max(0, Math.floor(by1 * sy) - 1);
      const gx1 = Math.min(pw - 1, Math.ceil(bx2 * sx) + 1), gy1 = Math.min(ph - 1, Math.ceil(by2 * sy) + 1);
      const gw = gx1 - gx0 + 1, gh = gy1 - gy0 + 1, grid = new Float32Array(gw * gh);
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        let v = 0; const off = (gy0 + gy) * pw + gx0 + gx;
        for (let m = 0; m < nm; m++) v += k.coef[m] * protos[m * ph * pw + off];
        grid[gy * gw + gx] = v;
      }
      const mask = new Uint8Array(mw * mh);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const px = x0 + x + 0.5, py = y0 + y + 0.5;
        if (px < bx1 || px > bx2 || py < by1 || py > by2) continue;
        const fx = Math.min(gw - 1.001, Math.max(0, px * sx - 0.5 - gx0)), fy = Math.min(gh - 1.001, Math.max(0, py * sy - 0.5 - gy0));
        const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
        const v = grid[iy * gw + ix] * (1 - ax) * (1 - ay) + grid[iy * gw + ix + 1] * ax * (1 - ay)
                + grid[(iy + 1) * gw + ix] * (1 - ax) * ay + grid[(iy + 1) * gw + ix + 1] * ax * ay;
        mask[y * mw + x] = 1 / (1 + Math.exp(-v)) > MASK_THR ? 1 : 0;
      }
      let pts = simplifyClosed(traceContour(mask, mw, mh), 0.6);
      if (pts.length < 3) continue;
      // về toạ độ ảnh gốc, chuẩn hoá 0..1
      const toOrig = (x, y) => [Math.min(1, Math.max(0, ((x0 + x + 0.5) - dx) / r / W0)), Math.min(1, Math.max(0, ((y0 + y + 0.5) - dy) / r / H0))];
      pts = pts.map(([x, y]) => toOrig(x, y).map(v => Math.round(v * 1e5) / 1e5));
      const box = [(bx1 - dx) / r / W0, (by1 - dy) / r / H0, (bx2 - dx) / r / W0, (by2 - dy) / r / H0].map(v => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5);
      regions.push({ cls: k.cls, name: meta.names[k.cls], conf: Math.round(k.conf * 1000) / 1000, box, pts, src: 'ai' });
    }
    return regions;
  }

  window.TubeSeg = { load, run, get names() { return meta?.names || ['cap', 'Headspace', 'plasma', 'bloodcell']; }, get ready() { return !!session; } };
})();
