// ===== Cấu hình nhãn độ (có thể sửa tuỳ quy ước của phòng xét nghiệm) =====
const GRADES = [
  { g: 0, label: 'Không' },
  { g: 1, label: 'Rất nhẹ' },
  { g: 2, label: 'Nhẹ' },
  { g: 3, label: 'Trung bình' },
  { g: 4, label: 'Đậm' },
  { g: 5, label: 'Rất đậm' },
];
const BUCKET = 'plasma';
const MAX_SIDE = 1600;      // cạnh dài tối đa khi nén ảnh
const JPEG_QUALITY = 0.88;
const PARALLEL = 4;         // số ảnh tải lên song song
const URL_TTL = 60 * 60 * 6; // link ảnh riêng tư có hiệu lực 6 giờ

const $ = s => document.querySelector(s);
const cfg = window.PG_CONFIG || {};
const configured = /^https:\/\/.+\.supabase\.co/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith('DAN_');
if (!configured) $('#setupNote').classList.remove('hidden');
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const state = { mode: 'login', user: null, batches: [], batchId: null, images: [], currentId: null, filter: 'all', channel: null, urls: new Map() };

// ---------- helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeStr = iso => new Date(iso).toLocaleTimeString('vi-VN');
const dateStr = iso => new Date(iso).toLocaleDateString('vi-VN');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function check({ data, error }) { if (error) throw new Error(viError(error.message)); return data; }
function viError(m = '') {
  if (/Invalid login credentials/i.test(m)) return 'Sai email hoặc mật khẩu';
  if (/already registered|already exists/i.test(m)) return 'Email này đã có tài khoản';
  if (/Email not confirmed/i.test(m)) return 'Email chưa được xác nhận – kiểm tra hộp thư';
  if (/Password should be/i.test(m)) return 'Mật khẩu tối thiểu 6 ký tự';
  if (/rate limit/i.test(m)) return 'Thao tác quá nhanh, vui lòng thử lại sau ít phút';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Mất kết nối mạng';
  return m || 'Có lỗi xảy ra';
}
// lấy toàn bộ dòng (Supabase trả tối đa 1000 dòng/lần)
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ---------- AUTH ----------
function showAuth() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('.confirm').classList.toggle('hidden', mode !== 'register');
  $('#authForm').confirm.required = mode === 'register';
  $('#authForm').password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = mode === 'register' ? 'Tạo tài khoản' : 'Đăng nhập';
  $('#authError').textContent = '';
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, err = $('#authError');
  err.textContent = ''; err.style.color = '';
  if (state.mode === 'register' && f.password.value !== f.confirm.value) return (err.textContent = 'Mật khẩu nhập lại không khớp');
  $('#authSubmit').disabled = true;
  try {
    const creds = { email: f.email.value.trim(), password: f.password.value };
    if (state.mode === 'register') {
      const data = check(await sb.auth.signUp(creds));
      if (!data.session) {
        err.style.color = 'var(--accent)';
        err.textContent = 'Đã tạo tài khoản! Kiểm tra email để xác nhận rồi đăng nhập.';
        setMode('login'); f.email.value = creds.email;
      }
    } else {
      check(await sb.auth.signInWithPassword(creds));
    }
  } catch (ex) { err.textContent = ex.message; }
  $('#authSubmit').disabled = false;
};
$('#logoutBtn').onclick = () => sb.auth.signOut();

// ---------- APP ----------
async function startApp(user) {
  if (state.user?.id === user.id && !$('#app').classList.contains('hidden')) return;
  state.user = user;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#username').textContent = user.email; $('#avatar').textContent = (user.email || '?')[0];
  buildGradeButtons();
  connectLive();
  await loadBatches();
  const saved = Number(localStorage.getItem('batchId'));
  const first = state.batches.find(b => b.id === saved) || state.batches[0];
  if (first) openBatch(first.id);
}

function connectLive() {
  if (state.channel) sb.removeChannel(state.channel);
  const live = $('#liveStatus');
  const uid = state.user.id;
  const refreshBatches = debounce(loadBatches, 400);
  const refreshCurrent = debounce(() => state.batchId && refreshImages(), 500);
  state.channel = sb.channel('pg-' + uid)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'images', filter: `user_id=eq.${uid}` }, p => {
      const d = p.new, img = state.images.find(i => i.id === d.id);
      if (img && (img.grade !== d.grade || img.note !== d.note)) {
        Object.assign(img, { grade: d.grade, note: d.note, graded_at: d.graded_at });
        renderAll();
        if (d.id === state.currentId) { showCurrent(); }
      }
      refreshBatches();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images', filter: `user_id=eq.${uid}` }, p => {
      if (p.new.batch_id === state.batchId && !state.images.some(i => i.id === p.new.id)) refreshCurrent();
      refreshBatches();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'images' }, p => {
      if (state.images.some(i => i.id === p.old.id)) {
        state.images = state.images.filter(i => i.id !== p.old.id);
        if (state.currentId === p.old.id) state.currentId = view()[0]?.id ?? null;
        renderAll(); showCurrent();
      }
      refreshBatches();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'batches' }, async () => {
      await loadBatches();
      if (state.batchId && !state.batches.some(b => b.id === state.batchId)) closeBatch();
      else renderAll();
    })
    .subscribe(status => {
      const ok = status === 'SUBSCRIBED';
      live.className = 'live ' + (ok ? 'on' : 'off');
      live.querySelector('span').textContent = ok ? 'Đồng bộ thời gian thực' : 'Mất kết nối – đang thử lại…';
    });
}

async function loadBatches() {
  state.batches = check(await sb.from('batch_stats').select('*').order('id', { ascending: false }));
  renderBatches();
}
function renderBatches() {
  const ul = $('#batchList');
  if (!state.batches.length) ul.innerHTML = '<li class="muted" style="cursor:default">Chưa có lô nào</li>';
  else ul.innerHTML = state.batches.map(b => {
    const pct = b.total ? Math.round(b.graded / b.total * 100) : 0;
    return `<li data-id="${b.id}" class="${b.id === state.batchId ? 'active' : ''}">
      <div class="bn" title="${esc(b.name)}">${esc(b.name)}</div>
      <div class="bm"><span>${b.graded}/${b.total} ảnh · ${dateStr(b.created_at)}</span>
        ${pct === 100 && b.total ? '<span class="done">Xong</span>' : `<span>${pct}%</span>`}</div>
      <div class="bar"><i style="width:${pct}%"></i></div></li>`;
  }).join('');
  ul.querySelectorAll('li[data-id]').forEach(li => li.onclick = () => openBatch(Number(li.dataset.id)));
  $('#emptyState').classList.toggle('hidden', !!state.batchId);
}

async function fetchImages(batchId) {
  const imgs = await fetchAll(() => sb.from('images')
    .select('id, batch_id, filename, rel_path, storage_path, grade, note, graded_at')
    .eq('batch_id', batchId).order('rel_path').order('id'));
  await signUrls(imgs);
  return imgs;
}
async function signUrls(imgs) {
  const now = Date.now();
  const need = imgs.filter(i => !(state.urls.get(i.storage_path)?.exp > now)).map(i => i.storage_path);
  for (let k = 0; k < need.length; k += 500) {
    const rows = check(await sb.storage.from(BUCKET).createSignedUrls(need.slice(k, k + 500), URL_TTL));
    rows.forEach(r => r.signedUrl && state.urls.set(r.path, { url: r.signedUrl, exp: now + (URL_TTL - 300) * 1000 }));
  }
}
const urlOf = img => state.urls.get(img.storage_path)?.url || '';

async function openBatch(id) {
  state.batchId = id; state.filter = 'all';
  localStorage.setItem('batchId', id);
  renderBatches();
  try { state.images = await fetchImages(id); } catch (e) { return toast(e.message); }
  state.currentId = (state.images.find(i => i.grade === null) || state.images[0])?.id ?? null;
  $('#workspace').classList.remove('hidden'); $('#emptyState').classList.add('hidden');
  renderAll(); showCurrent();
}
async function refreshImages() {
  const imgs = await fetchImages(state.batchId);
  state.images = imgs;
  if (!imgs.some(i => i.id === state.currentId)) state.currentId = imgs[0]?.id ?? null;
  renderAll(); showCurrent();
}
function closeBatch() {
  state.batchId = null; state.images = []; state.currentId = null;
  localStorage.removeItem('batchId');
  $('#workspace').classList.add('hidden'); renderBatches();
}

// ---------- workspace rendering ----------
const batch = () => state.batches.find(b => b.id === state.batchId);
const current = () => state.images.find(i => i.id === state.currentId);
function view() {
  const f = state.filter;
  if (f === 'all') return state.images;
  if (f === 'none') return state.images.filter(i => i.grade === null);
  return state.images.filter(i => i.grade === Number(f));
}

function renderAll() {
  const b = batch(); if (!b) return;
  if (document.activeElement !== $('#batchName')) $('#batchName').value = b.name;
  const total = state.images.length, graded = state.images.filter(i => i.grade !== null).length;
  $('#batchMeta').textContent = `${total} ảnh · tạo ngày ${dateStr(b.created_at)}`;
  $('#progressText').textContent = `${graded}/${total}`;
  $('#progressBar').style.width = (total ? graded / total * 100 : 0) + '%';

  const counts = GRADES.map(({ g }) => state.images.filter(i => i.grade === g).length);
  const max = Math.max(1, ...counts);
  $('#distribution').innerHTML = GRADES.map(({ g }, k) => `
    <div class="d"><div class="top"><span>Độ ${g}</span><b>${counts[k]}</b></div>
    <div class="track"><i data-g="${g}" style="width:${counts[k] / max * 100}%"></i></div></div>`).join('');

  const chips = [['all', 'Tất cả', total], ['none', 'Chưa chấm', total - graded], ...GRADES.map(({ g }, k) => [String(g), 'Độ ' + g, counts[k]])];
  $('#filters').innerHTML = chips.map(([k, l, c]) =>
    `<button class="chip ${state.filter === k ? 'active' : ''}" data-f="${k}">${l}<span class="c">${c}</span></button>`).join('');
  $('#filters').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    state.filter = c.dataset.f;
    const v = view();
    if (!v.some(i => i.id === state.currentId) && v[0]) state.currentId = v[0].id;
    renderAll(); showCurrent();
  });
  renderThumbs();
  renderGradeSelection();
}

function renderThumbs() {
  const v = view(), box = $('#thumbs');
  if (!v.length) { box.innerHTML = '<div class="none-msg">Không có ảnh nào trong bộ lọc này</div>'; return; }
  box.innerHTML = v.map(i => `
    <div class="thumb ${i.id === state.currentId ? 'current' : ''}" data-id="${i.id}" title="${esc(i.rel_path)}">
      <img loading="lazy" src="${esc(urlOf(i))}" alt="" />
      <button class="del" data-del="${i.id}" title="Xoá ảnh">✕</button>
      ${i.grade === null ? '<span class="badge none">–</span>' : `<span class="badge" data-g="${i.grade}">${i.grade}</span>`}
    </div>`).join('');
  box.querySelectorAll('.thumb').forEach(t => t.onclick = e => {
    if (e.target.dataset.del) return deleteImage(Number(e.target.dataset.del));
    select(Number(t.dataset.id));
  });
  box.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function showCurrent() {
  const img = current(), v = view();
  $('#stage').classList.toggle('hidden', !img);
  if (!img) { $('#fname').textContent = 'Không có ảnh'; $('#saveState').textContent = ''; return; }
  const u = urlOf(img);
  if ($('#mainImg').getAttribute('src') !== u) $('#mainImg').src = u;
  $('#fname').textContent = img.rel_path; $('#fname').title = img.rel_path;
  const pos = v.findIndex(i => i.id === img.id);
  $('#counter').textContent = pos >= 0 ? `${pos + 1} / ${v.length}` : `${state.images.indexOf(img) + 1} / ${state.images.length}`;
  if (document.activeElement !== $('#note')) $('#note').value = img.note || '';
  setSave(img.graded_at ? 'ok' : '', img.graded_at ? 'Đã lưu lúc ' + timeStr(img.graded_at) : 'Chưa chấm');
  renderGradeSelection();
}

function select(id) {
  state.currentId = id;
  showCurrent();
  document.querySelectorAll('.thumb').forEach(t => t.classList.toggle('current', Number(t.dataset.id) === id));
  document.querySelector('.thumb.current')?.scrollIntoView({ block: 'nearest' });
}
function step(d) {
  const v = view(); if (!v.length) return;
  let pos = v.findIndex(i => i.id === state.currentId);
  pos = pos < 0 ? 0 : Math.min(v.length - 1, Math.max(0, pos + d));
  select(v[pos].id);
}

// ---------- grading (lưu tức thì) ----------
function buildGradeButtons() {
  $('#grades').innerHTML = GRADES.map(({ g, label }) =>
    `<button class="grade-btn" data-g="${g}" data-grade="${g}"><span class="n">${g}</span><span class="t">${label}</span></button>`).join('');
  $('#grades').querySelectorAll('.grade-btn').forEach(b => b.onclick = () => setGrade(Number(b.dataset.grade)));
}
function renderGradeSelection() {
  const img = current();
  document.querySelectorAll('.grade-btn').forEach(b => b.classList.toggle('selected', !!img && img.grade === Number(b.dataset.grade)));
}
function setSave(cls, text) { const s = $('#saveState'); s.className = 'save-state ' + cls; s.textContent = text; }

async function save(img, patch) {
  setSave('saving', 'Đang lưu…');
  try {
    const r = check(await sb.from('images').update(patch).eq('id', img.id).select('grade, note, graded_at').single());
    Object.assign(img, r);
    if (img.id === state.currentId) setSave('ok', r.graded_at ? 'Đã lưu lúc ' + timeStr(r.graded_at) : 'Đã lưu');
    return true;
  } catch (e) {
    if (img.id === state.currentId) setSave('err', '⚠ Lưu thất bại: ' + e.message);
    toast('Không lưu được – kiểm tra kết nối');
    return false;
  }
}

async function setGrade(g) {
  const img = current(); if (!img) return;
  const pos = view().findIndex(i => i.id === img.id);
  const prev = img.grade;
  img.grade = g; // cập nhật lạc quan
  const ok = await save(img, { grade: g, graded_at: g === null ? null : new Date().toISOString() });
  if (!ok) img.grade = prev;
  const nv = view();
  renderAll();
  if (ok && $('#autoNext').checked && g !== null) {
    const nextPos = nv.some(i => i.id === img.id) ? pos + 1 : pos;
    if (nv[nextPos]) select(nv[nextPos].id);
    else { if (!state.images.some(i => i.grade === null)) toast('🎉 Đã chấm xong toàn bộ lô!'); showCurrent(); }
  } else showCurrent();
  loadBatches();
}
$('#clearGrade').onclick = () => setGrade(null);

let noteTimer;
$('#note').addEventListener('input', () => {
  const img = current(); if (!img) return;
  const value = $('#note').value;
  img.note = value;
  setSave('saving', 'Đang lưu…');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => save(img, { note: value }), 700);
});

async function deleteImage(id) {
  if (!confirm('Xoá ảnh này khỏi lô?')) return;
  const img = state.images.find(i => i.id === id);
  try {
    check(await sb.from('images').delete().eq('id', id));
    await sb.storage.from(BUCKET).remove([img.storage_path]);
  } catch (e) { return toast(e.message); }
  state.images = state.images.filter(i => i.id !== id);
  if (state.currentId === id) state.currentId = view()[0]?.id ?? null;
  renderAll(); showCurrent(); loadBatches();
}

$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
$('#mainImg').onclick = () => { $('#lightImg').src = $('#mainImg').src; $('#lightbox').classList.remove('hidden'); };
$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

document.addEventListener('keydown', e => {
  if ($('#app').classList.contains('hidden') || !state.batchId) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (e.key === 'Escape') return $('#lightbox').classList.add('hidden');
  if (/^[0-5]$/.test(e.key)) { e.preventDefault(); setGrade(Number(e.key)); }
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'Backspace' || e.key === 'Delete') setGrade(null);
});

// ---------- batch actions ----------
$('#batchName').addEventListener('change', async e => {
  const name = e.target.value.trim().slice(0, 120); if (!name) return renderAll();
  try { check(await sb.from('batches').update({ name }).eq('id', state.batchId)); toast('Đã đổi tên lô'); loadBatches(); }
  catch (ex) { toast(ex.message); }
});
$('#batchName').addEventListener('keydown', e => e.key === 'Enter' && e.target.blur());
$('#deleteBatch').onclick = async () => {
  const b = batch();
  if (!confirm(`Xoá lô "${b.name}" cùng toàn bộ ${b.total} ảnh và kết quả? Không thể hoàn tác.`)) return;
  try {
    const paths = state.images.map(i => i.storage_path);
    for (let k = 0; k < paths.length; k += 100) await sb.storage.from(BUCKET).remove(paths.slice(k, k + 100));
    check(await sb.from('batches').delete().eq('id', b.id));
  } catch (e) { return toast(e.message); }
  closeBatch(); await loadBatches();
  if (state.batches[0]) openBatch(state.batches[0].id);
};

// ---------- export CSV ----------
async function exportCsv(batchId) {
  try {
    const rows = await fetchAll(() => {
      let q = sb.from('images').select('rel_path, filename, grade, note, graded_at, batch_id, batches(name)').order('batch_id').order('rel_path');
      return batchId ? q.eq('batch_id', batchId) : q;
    });
    const e = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Lô', 'Đường dẫn', 'Tên file', 'Độ', 'Ghi chú', 'Thời gian chấm'].map(e).join(',')];
    rows.forEach(r => lines.push([r.batches?.name, r.rel_path, r.filename, r.grade, r.note,
      r.graded_at ? new Date(r.graded_at).toLocaleString('vi-VN') : ''].map(e).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = batchId ? `ket-qua-${(batch()?.name || 'lo').replace(/[\\/:*?"<>|]/g, '_')}.csv` : 'ket-qua-tat-ca.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (ex) { toast(ex.message); }
}
$('#exportAll').onclick = () => exportCsv(null);
$('#exportBatch').onclick = () => exportCsv(state.batchId);

// ---------- upload ----------
let uploadTarget = null; // null = lô mới, số = thêm vào lô hiện tại
$('#pickFiles').onclick = () => { uploadTarget = null; $('#fileInput').click(); };
$('#pickFolder').onclick = () => { uploadTarget = null; $('#folderInput').click(); };
$('#addToBatch').onclick = () => { uploadTarget = state.batchId; $('#fileInput').click(); };
$('#fileInput').onchange = e => { handleFiles([...e.target.files].map(f => ({ file: f, path: f.name }))); e.target.value = ''; };
$('#folderInput').onchange = e => {
  handleFiles([...e.target.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name })));
  e.target.value = '';
};

const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async e => {
  uploadTarget = null;
  const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return handleFiles([...e.dataTransfer.files].map(f => ({ file: f, path: f.name })));
  const out = [];
  await Promise.all(items.map(en => walk(en, '', out)));
  handleFiles(out);
});
async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + file.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let list;
    do {
      list = await new Promise((res, rej) => reader.readEntries(res, rej));
      await Promise.all(list.map(en => walk(en, prefix + entry.name + '/', out)));
    } while (list.length);
  }
}

const isImage = f => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|tiff?|heic)$/i.test(f.name);

// thu nhỏ ảnh để tiết kiệm dung lượng; nếu trình duyệt không đọc được định dạng thì giữ nguyên
async function prepare(file) {
  if (!$('#compress').checked || !/^image\/(jpeg|png|webp|bmp)$/.test(file.type)) return { blob: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 600 * 1024) { bmp.close(); return { blob: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() }; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
    return blob && blob.size < file.size ? { blob, ext: 'jpg' } : { blob: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() };
  } catch { return { blob: file, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() }; }
}

async function handleFiles(list) {
  list = list.filter(x => isImage(x.file));
  if (!list.length) return toast('Không tìm thấy file ảnh hợp lệ');
  const uid = state.user.id;
  const root = list[0].path.includes('/') ? list[0].path.split('/')[0] : '';
  const name = (root || (list.length === 1 ? list[0].file.name : 'Tải lên ' + new Date().toLocaleString('vi-VN'))).slice(0, 120);

  const prog = $('#uploadProgress');
  prog.classList.remove('hidden');
  const setP = (n, label) => {
    const pct = Math.round(n / list.length * 100);
    $('#uploadBar').style.width = pct + '%'; $('#uploadPct').textContent = pct + '%';
    $('#uploadLabel').textContent = label;
  };
  let batchId = uploadTarget, done = 0, failed = 0;
  try {
    if (!batchId) batchId = check(await sb.from('batches').insert({ name }).select('id').single()).id;
    setP(0, `Đang tải 0/${list.length} ảnh…`);
    const rows = [];
    const flush = async (force) => {
      if (rows.length && (force || rows.length >= 25)) {
        const part = rows.splice(0, rows.length);
        check(await sb.from('images').insert(part));
      }
    };
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const x = list[next++];
        try {
          const { blob, ext } = await prepare(x.file);
          const path = `${uid}/${batchId}/${crypto.randomUUID()}.${ext}`;
          check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false }));
          rows.push({ batch_id: batchId, filename: x.file.name, rel_path: x.path, storage_path: path });
          await flush(false);
        } catch (e) { failed++; console.error(x.path, e); }
        done++;
        setP(done, `Đang tải ${done}/${list.length} ảnh…`);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    await flush(true);
    setP(list.length, failed ? `Xong – ${failed} ảnh lỗi` : 'Hoàn tất');
    toast(failed ? `Đã tải ${list.length - failed} ảnh, ${failed} ảnh lỗi` : `Đã tải lên ${list.length} ảnh`);
    await loadBatches();
    await openBatch(batchId);
  } catch (e) { toast(e.message); $('#uploadLabel').textContent = '⚠ ' + e.message; }
  setTimeout(() => prog.classList.add('hidden'), 2000);
}

// ---------- boot ----------
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    // tránh gọi API Supabase trực tiếp trong callback (theo khuyến nghị của supabase-js)
    setTimeout(() => {
      if (session?.user) startApp(session.user);
      else { state.user = null; closeBatch(); setMode('login'); showAuth(); }
    }, 0);
  });
}
