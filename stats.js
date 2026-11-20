// =====================================================================
// Chỉ số đồng thuận giữa người chấm (thang thứ bậc 0..K-1)
//  - Cohen's kappa (không trọng số / trọng số bậc hai) cho từng cặp
//  - Fleiss' kappa cho các ảnh được TẤT CẢ người chấm cùng chấm
//  - Krippendorff's alpha (thứ bậc / định danh) – chấp nhận thiếu dữ liệu
// Không tính độ 5 ("Cân nhắc lựa chọn") vì không nằm trên thang độ đục.
// =====================================================================
(function (root) {
  // a, b: mảng điểm cùng độ dài (cặp điểm trên cùng ảnh); K: số mức
  function cohen(a, b, K, weighted) {
    const n = a.length; if (n < 2) return null;
    const O = Array.from({ length: K }, () => new Float64Array(K));
    const ra = new Float64Array(K), rb = new Float64Array(K);
    for (let i = 0; i < n; i++) { O[a[i]][b[i]]++; ra[a[i]]++; rb[b[i]]++; }
    let num = 0, den = 0;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
      const w = weighted ? ((i - j) * (i - j)) / ((K - 1) * (K - 1)) : (i === j ? 0 : 1);
      num += w * O[i][j] / n;
      den += w * (ra[i] / n) * (rb[j] / n);
    }
    if (den === 0) return num === 0 ? 1 : null; // mọi người cùng một mức duy nhất
    return 1 - num / den;
  }

  // items: mảng các mảng điểm (mỗi ảnh một mảng, cùng số người chấm m)
  function fleiss(items, K) {
    const N = items.length; if (N < 2) return null;
    const m = items[0].length; if (m < 2) return null;
    const pj = new Float64Array(K); let Pbar = 0;
    for (const it of items) {
      const c = new Float64Array(K); it.forEach(g => c[g]++);
      let s = 0; for (let j = 0; j < K; j++) { s += c[j] * c[j]; pj[j] += c[j]; }
      Pbar += (s - m) / (m * (m - 1));
    }
    Pbar /= N;
    let Pe = 0; for (let j = 0; j < K; j++) { const p = pj[j] / (N * m); Pe += p * p; }
    if (Pe === 1) return Pbar === 1 ? 1 : null;
    return (Pbar - Pe) / (1 - Pe);
  }

  // units: mảng các mảng điểm (số người chấm mỗi ảnh có thể khác nhau, ≥ 2)
  function kripp(units, K, level) {
    const o = Array.from({ length: K }, () => new Float64Array(K));
    let used = 0;
    for (const u of units) {
      const m = u.length; if (m < 2) continue; used++;
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) o[u[i]][u[j]] += 1 / (m - 1);
    }
    if (used < 1) return null;
    const nc = o.map(r => r.reduce((s, v) => s + v, 0));
    const n = nc.reduce((s, v) => s + v, 0);
    const d2 = (c, k) => {
      if (level === 'nominal') return c === k ? 0 : 1;
      if (level === 'interval') return (c - k) ** 2;
      const lo = Math.min(c, k), hi = Math.max(c, k);   // ordinal
      let s = 0; for (let g = lo; g <= hi; g++) s += nc[g];
      return (s - (nc[c] + nc[k]) / 2) ** 2;
    };
    let Do = 0, De = 0;
    for (let c = 0; c < K; c++) for (let k = 0; k < K; k++) {
      if (c === k) continue;
      const d = d2(c, k);
      Do += o[c][k] * d;
      De += nc[c] * nc[k] * d;
    }
    if (De === 0) return Do === 0 ? 1 : null;
    return 1 - (n - 1) * Do / De;
  }

  // diễn giải theo Landis & Koch (1977)
  function label(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return { text: 'chưa đủ dữ liệu', cls: 'na' };
    if (v < 0) return { text: 'kém hơn ngẫu nhiên', cls: 'poor' };
    if (v <= 0.2) return { text: 'rất thấp', cls: 'poor' };
    if (v <= 0.4) return { text: 'thấp', cls: 'fair' };
    if (v <= 0.6) return { text: 'trung bình', cls: 'mod' };
    if (v <= 0.8) return { text: 'khá cao', cls: 'good' };
    return { text: 'gần như hoàn toàn', cls: 'great' };
  }

  const api = { cohen, fleiss, kripp, label };
  if (typeof module !== 'undefined') module.exports = api; else root.Agree = api;
})(typeof window !== 'undefined' ? window : globalThis);
