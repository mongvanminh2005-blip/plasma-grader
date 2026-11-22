// Phân tích màu huyết tương – chuyển từ analyze_color.py (D:\BME4) sang trình duyệt.
// Cách lấy màu giống bản Python: mask plasma (AI) -> co viền -> lọc L (40..220) và loá (xám >= 240)
// -> trung vị Lab/RGB/HSV kiểu OpenCV 8-bit. Mô hình dự đoán: model/color-model.json.
const PlasmaColor = (() => {
  const L_MIN = 40, L_MAX = 220, GLARE = 240, MIN_PIXELS = 50, ERODE_R = 2;

  // sRGB 8-bit -> tuyến tính (giống bảng tra của OpenCV)
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const clamp8 = v => Math.max(0, Math.min(255, Math.round(v)));
  function lab8(r, g, b) {   // giống cv2.COLOR_RGB2LAB với ảnh uint8
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456;
    const Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
    const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
    const fy = f(Y);
    const L = Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y;
    return [clamp8(L * 255 / 100), clamp8(500 * (f(X) - fy) + 128), clamp8(200 * (fy - f(Z)) + 128)];
  }
  const median = arr => { if (!arr.length) return NaN; const a = Float64Array.from(arr).sort(); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  function colorName(L, a, b) {   // giống classify_color() của analyze_color.py
    const Ls = L * 100 / 255, as = a - 128, bs = b - 128, C = Math.hypot(as, bs);
    const h = ((Math.atan2(bs, as) * 180 / Math.PI) % 360 + 360) % 360;
    if (C < 10) return Ls > 60 ? 'Trắng/Trong suốt' : Ls > 25 ? 'Xám' : 'Đen';
    if (h >= 345 || h < 55) return 'Đỏ/Hồng';
    if (h < 110) return 'Cam/Vàng';
    if (h < 180) return 'Xanh lá';
    if (h < 240) return 'Xanh lơ';
    if (h < 315) return 'Xanh dương';
    return 'Tím';
  }

  // bitmap: ImageBitmap / HTMLImageElement; regions: [{name, conf, pts:[[x,y] 0..1]}]
  function analyze(bitmap, regions) {
    const pl = (regions || []).filter(r => r.name === 'plasma' && r.pts?.length >= 3).sort((a, b) => (b.conf || 0) - (a.conf || 0))[0];
    if (!pl) return { error: 'Không có vùng plasma' };
    const W = bitmap.width, H = bitmap.height;
    const xs = pl.pts.map(p => p[0] * W), ys = pl.pts.map(p => p[1] * H);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 2), y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 2);
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return { error: 'Vùng plasma quá nhỏ' };
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    // mask đa giác
    const mc = document.createElement('canvas'); mc.width = w; mc.height = h;
    const mx = mc.getContext('2d', { willReadFrequently: true });
    mx.fillStyle = '#fff'; mx.beginPath();
    pl.pts.forEach(([x, y], i) => (i ? mx.lineTo : mx.moveTo).call(mx, x * W - x0, y * H - y0));
    mx.closePath(); mx.fill();
    const md = mx.getImageData(0, 0, w, h).data;
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = md[i * 4 + 3] > 127 ? 1 : 0;
    // co viền (tương đương cv2.erode kernel 5x5)
    for (let it = 0; it < ERODE_R; it++) {
      const m2 = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        m2[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w] & mask[i - w - 1] & mask[i - w + 1] & mask[i + w - 1] & mask[i + w + 1];
      }
      mask = m2;
    }
    const Ls = [], As = [], Bs = [], Rs = [], Gs = [], BBs = [], Ss = [], gch = [], rch = [];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      if (gray >= GLARE) continue;
      const [L, a, bb] = lab8(r, g, b);
      if (L < L_MIN || L > L_MAX) continue;
      Ls.push(L); As.push(a); Bs.push(bb); Rs.push(r); Gs.push(g); BBs.push(b);
      const mxv = Math.max(r, g, b), mnv = Math.min(r, g, b);
      Ss.push(mxv ? Math.round((mxv - mnv) * 255 / mxv) : 0);
      const t = r + g + b || 1; gch.push(g / t); rch.push(r / t);
    }
    if (Ls.length < MIN_PIXELS) return { error: `Quá ít điểm ảnh hợp lệ (${Ls.length})` };
    const L = median(Ls), a = median(As), b = median(Bs);
    const C = Math.hypot(a - 128, b - 128), hue = Math.atan2(b - 128, a - 128) * 180 / Math.PI;
    const ratio = (() => {
      const hgt = n => { const r = regions.filter(x => x.name === n).map(x => Math.max(...x.pts.map(p => p[1])) - Math.min(...x.pts.map(p => p[1]))); return r.length ? Math.max(...r) : 0; };
      const hp = hgt('plasma'), hb = hgt('bloodcell'); return hb ? hp / (hp + hb) : null;
    })();
    return {
      n: Ls.length, L, a, b, C, h: hue,
      R: median(Rs), G: median(Gs), B: median(BBs),
      S: median(Ss), g_chrom: median(gch), r_chrom: median(rch),
      color: colorName(L, a, b), ratio,
    };
  }

  // ---- mô hình ----
  let model = null;
  async function loadModel() {
    if (model) return model;
    const r = await fetch('model/color-model.json?v=1');
    if (!r.ok) throw new Error('Không tải được mô hình màu');
    return (model = await r.json());
  }
  const zs = (part, feat, names) => names.map((k, j) => (feat[k] - part.mean[j]) / part.scale[j]);
  function predict(feat) {
    if (!model || !feat || feat.error) return null;
    const names = model.features;
    if (names.some(k => !Number.isFinite(feat[k]))) return null;
    const rj = model.reject, z = zs(rj, feat, names);
    const pLoai = 1 / (1 + Math.exp(-(rj.intercept + z.reduce((s, v, j) => s + v * rj.coef[j], 0))));
    const gm = model.grade, zg = zs(gm, feat, names);
    const sc = gm.coef.map((cf, k) => gm.intercept[k] + zg.reduce((s, v, j) => s + v * cf[j], 0));
    const mx = Math.max(...sc), ex = sc.map(v => Math.exp(v - mx)), sum = ex.reduce((s, v) => s + v, 0);
    const probs = ex.map(v => v / sum);
    const k = probs.indexOf(Math.max(...probs));
    return { pLoai, loai: pLoai >= rj.threshold, grade: gm.classes[k], gradeProb: probs[k], probs };
  }
  return { analyze, loadModel, predict, colorName, get model() { return model; } };
})();
