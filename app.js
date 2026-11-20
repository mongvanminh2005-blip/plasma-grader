// ===== Cấu hình nhãn độ (có thể sửa tuỳ quy ước của phòng xét nghiệm) =====
const GRADES = [
  { g: 0, label: 'Trong' },
  { g: 1, label: 'Đục nhẹ' },
  { g: 2, label: 'Đục vừa' },
  { g: 3, label: 'Đục rõ' },
  { g: 4, label: 'Đục nặng' },
];
const BUCKET = 'plasma';
let rawBusy = false;      // đang chuyển RAW → JPEG
const MAX_SIDE = 1600;      // cạnh dài tối đa khi nén ảnh
const JPEG_QUALITY = 0.88;
const PARALLEL = 4;         // số ảnh tải lên song song
const URL_TTL = 60 * 60 * 6; // link ảnh riêng tư có hiệu lực 6 giờ

const $ = s => document.querySelector(s);
const cfg = window.PG_CONFIG || {};
const configured = /^https:\/\/.+\.supabase\.co/.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith('DAN_');
if (!configured) $('#setupNote').classList.remove('hidden');
// "Ghi nhớ đăng nhập": lưu phiên vào localStorage (giữ lâu) hoặc sessionStorage (mất khi đóng trình duyệt)
const REMEMBER_KEY = 'pg-remember';
const authStorage = {
  store: () => (localStorage.getItem(REMEMBER_KEY) === '0' ? sessionStorage : localStorage),
  getItem: k => authStorage.store().getItem(k),
  setItem: (k, v) => authStorage.store().setItem(k, v),
  removeItem: k => { localStorage.removeItem(k); sessionStorage.removeItem(k); },
};
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { storage: authStorage, persistSession: true, autoRefreshToken: true },
}) : null;

// Tài khoản dùng tên đăng nhập; bên trong Supabase lưu dưới dạng email nội bộ (không gửi thư)
const USER_DOMAIN = 'users.plasma-grader.app';
const toEmail = u => (u.includes('@') ? u : `${u}@${USER_DOMAIN}`).toLowerCase();
const displayName = email => (email || '').endsWith('@' + USER_DOMAIN) ? email.split('@')[0] : (email || '');

const state = { mode: 'login', user: null, batches: [], batchId: null, images: [], currentId: null, filter: 'all', channel: null, urls: new Map(),
  isAdmin: false, scope: 'me', users: [], adminOpen: false };

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
  if (/Invalid login credentials/i.test(m)) return 'Sai tên đăng nhập hoặc mật khẩu';
  if (/already registered|already exists/i.test(m)) return 'Tên đăng nhập này đã có người dùng';
  if (/Email not confirmed/i.test(m)) return 'Tài khoản chưa được xác nhận – cần tắt "Confirm email" trong Supabase';
  if (/invalid format|Unable to validate email/i.test(m)) return 'Tên đăng nhập không hợp lệ';
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
    const name = f.username.value.trim().toLowerCase();
    if (!name.includes('@') && !/^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){1,30}[a-z0-9]$/.test(name)) throw new Error('Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số và _ . -');
    localStorage.setItem(REMEMBER_KEY, f.remember.checked ? '1' : '0');
    const creds = { email: toEmail(name), password: f.password.value };
    if (state.mode === 'register') {
      const data = check(await sb.auth.signUp(creds));
      if (!data.session && !(await sb.auth.signInWithPassword(creds)).error) return; // đăng nhập luôn nếu không cần xác nhận
      if (!data.session) {
        err.style.color = 'var(--accent)';
        err.textContent = 'Đã tạo tài khoản nhưng hệ thống đang yêu cầu xác nhận email – báo quản trị viên tắt "Confirm email".';
        setMode('login'); f.username.value = name;
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
  const dn = displayName(user.email); $('#username').textContent = dn; $('#avatar').textContent = (dn || '?')[0];
  buildGradeButtons();
  state.isAdmin = !!(await sb.rpc('is_admin')).data;
  state.scope = state.isAdmin ? (localStorage.getItem('pg-scope') || 'me') : 'me';
  $('#adminBtn').classList.toggle('hidden', !state.isAdmin);
  $('#scopeBox').classList.toggle('hidden', !state.isAdmin);
  if (state.isAdmin) await loadUsers().catch(e => { console.error(e); renderScope(); });
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'images', ...(state.isAdmin ? {} : { filter: `user_id=eq.${uid}` }) }, p => {
      const d = p.new, img = state.images.find(i => i.id === d.id);
      const editingThis = seg.editing && d.id === state.currentId;
      const regChanged = img && !editingThis && JSON.stringify(img.regions ?? null) !== JSON.stringify(d.regions ?? null);
      if (img && (img.grade !== d.grade || img.note !== d.note || regChanged)) {
        Object.assign(img, { grade: d.grade, note: d.note, graded_at: d.graded_at });
        if (regChanged) Object.assign(img, { regions: d.regions, regions_source: d.regions_source, regions_at: d.regions_at });
        renderAll();
        if (d.id === state.currentId) { showCurrent(); }
      }
      refreshBatches();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images', ...(state.isAdmin ? {} : { filter: `user_id=eq.${uid}` }) }, p => {
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
  let q = sb.from('batch_stats').select('*').order('id', { ascending: false });
  if (state.scope === 'me') q = q.eq('user_id', state.user.id);
  else if (state.scope !== 'all') q = q.eq('user_id', state.scope);
  state.batches = check(await q);
  renderBatches();
}
function renderBatches() {
  const ul = $('#batchList');
  if (!state.batches.length) ul.innerHTML = '<li class="muted" style="cursor:default">Chưa có lô nào</li>';
  else ul.innerHTML = state.batches.map(b => {
    const pct = b.total ? Math.round(b.graded / b.total * 100) : 0;
    return `<li data-id="${b.id}" class="${b.id === state.batchId ? 'active' : ''}">
      <div class="bn" title="${esc(b.name)}">${b.user_id !== state.user?.id ? `<span class="owner-tag">${esc(b.owner || '?')}</span>` : ''}${esc(b.name)}</div>
      <div class="bm"><span>${b.graded}/${b.total} ảnh · ${dateStr(b.created_at)}</span>
        ${pct === 100 && b.total ? '<span class="done">Xong</span>' : `<span>${pct}%</span>`}</div>
      <div class="bar"><i style="width:${pct}%"></i></div></li>`;
  }).join('');
  ul.querySelectorAll('li[data-id]').forEach(li => li.onclick = () => openBatch(Number(li.dataset.id)));
  $('#emptyState').classList.toggle('hidden', !!state.batchId || state.adminOpen);
}

async function fetchImages(batchId) {
  const imgs = await fetchAll(() => sb.from('images')
    .select('id, batch_id, filename, rel_path, storage_path, grade, note, graded_at, regions, regions_source, regions_at')
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
  closeAdmin();
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
  const other = b.user_id !== state.user.id;
  $('#batchMeta').textContent = `${total} ảnh · tạo ngày ${dateStr(b.created_at)}` + (other ? ` · của tài khoản ${b.owner || '?'}` : '');
  $('#addToBatch').classList.toggle('hidden', other);
  const raws = state.images.filter(i => RAW_EXT.test(i.storage_path));
  $('#rawBanner').classList.toggle('hidden', !raws.length || rawBusy);
  if (raws.length) $('#rawText').textContent = `${raws.length} ảnh đang lưu ở dạng RAW (trình duyệt không hiển thị được và tốn dung lượng). Chuyển sang JPEG để xem, chấm và giải phóng dung lượng — kết quả đã chấm được giữ nguyên.`;
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
    <div class="thumb ${i.id === state.currentId ? 'current' : ''} ${RAW_EXT.test(i.storage_path) ? 'raw' : ''}" data-id="${i.id}" title="${esc(i.rel_path)}">
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
  if (seg.shownId !== img.id) { seg.shownId = img.id; seg.sel = -1; seg.drawing = null; updateDrawBtn(); }
  renderOverlay();
  if (!seg.busy.has(img.id)) setSeg('', segSummary(img));
  maybeAutoSeg();
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
  if (seg.editing && handleSegKey(e)) return;
  if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) return $('#segZoom').click();
  if (e.key === 'Escape') return $('#lightbox').classList.add('hidden');
  if (GRADES.some(x => String(x.g) === e.key)) { e.preventDefault(); setGrade(Number(e.key)); }
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
// owner: undefined = theo phạm vi đang xem, 'all' = mọi tài khoản (quản trị)
async function exportCsv(batchId, owner) {
  try {
    const scope = owner || (state.isAdmin ? state.scope : 'me');
    const rows = await fetchAll(() => {
      let q = sb.from('images').select('user_id, rel_path, filename, grade, note, graded_at, regions, regions_source, batch_id, batches(name)').order('batch_id').order('rel_path');
      if (batchId) return q.eq('batch_id', batchId);
      if (scope === 'me') return q.eq('user_id', state.user.id);
      return scope === 'all' ? q : q.eq('user_id', scope);
    });
    if (state.isAdmin && !state.users.length) await loadUsers().catch(() => {});
    const nameOf = id => id === state.user.id ? displayName(state.user.email) : (state.users.find(u => u.id === id)?.username || id);
    const labelOf = g => GRADES.find(x => x.g === g)?.label || '';
    const e = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Lô', 'Đường dẫn', 'Tên file', 'Độ', 'Mức', 'Ghi chú', 'Thời gian chấm', 'Khoanh vùng', 'Số vùng', 'Plasma / (plasma + hồng cầu) theo chiều cao (%)'];
    if (state.isAdmin) head.unshift('Người tải');
    const lines = [head.map(e).join(',')];
    rows.forEach(r => {
      const row = [r.batches?.name, r.rel_path, r.filename, r.grade, labelOf(r.grade), r.note,
        r.graded_at ? new Date(r.graded_at).toLocaleString('vi-VN') : '',
        r.regions ? (r.regions_source === 'manual' ? 'Chỉnh tay' : 'AI') : '', r.regions ? r.regions.length : '', plasmaRatio(r.regions)];
      if (state.isAdmin) row.unshift(nameOf(r.user_id));
      lines.push(row.map(e).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = batchId ? `ket-qua-${(batch()?.name || 'lo').replace(/[\\/:*?"<>|]/g, '_')}.csv` : 'ket-qua-tat-ca.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (ex) { toast(ex.message); }
}
$('#exportAll').onclick = () => exportCsv(null);
$('#exportBatch').onclick = () => exportCsv(state.batchId);


// ---------- QUẢN TRỊ ----------
const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const FREE_STORAGE = 1024 ** 3, FREE_DB = 500 * 1024 ** 2;

async function loadUsers() {
  state.users = check(await sb.rpc('admin_list_users'));
  renderScope();
}
function renderScope() {
  const sel = $('#scopeSelect');
  const others = state.users.filter(u => u.id !== state.user.id);
  sel.innerHTML = `<option value="me">Của tôi</option><option value="all">Tất cả tài khoản</option>` +
    others.map(u => `<option value="${u.id}">${esc(u.username)}</option>`).join('');
  if (![...sel.options].some(o => o.value === state.scope)) state.scope = 'me';
  sel.value = state.scope;
}
$('#scopeSelect').onchange = async e => {
  state.scope = e.target.value;
  localStorage.setItem('pg-scope', state.scope);
  closeBatch(); await loadBatches();
  if (!state.adminOpen && state.batches[0]) openBatch(state.batches[0].id);
};
function viewUserData(uid) {
  state.scope = uid === state.user.id ? 'me' : uid;
  localStorage.setItem('pg-scope', state.scope);
  renderScope(); closeBatch();
  loadBatches().then(() => state.batches[0] ? openBatch(state.batches[0].id) : (closeAdmin(), toast('Tài khoản này chưa có lô ảnh nào')));
}

function closeAdmin() {
  state.adminOpen = false;
  $('#adminPanel').classList.add('hidden'); $('#adminBtn').classList.remove('active');
}
async function openAdmin() {
  state.adminOpen = true;
  $('#adminBtn').classList.add('active');
  $('#workspace').classList.add('hidden'); $('#emptyState').classList.add('hidden');
  $('#adminPanel').classList.remove('hidden');
  state.batchId = null; renderBatches();
  await refreshAdmin();
}
$('#adminBtn').onclick = () => state.adminOpen ? (closeAdmin(), state.batches[0] ? openBatch(state.batches[0].id) : renderBatches()) : openAdmin();
$('#adminRefresh').onclick = () => refreshAdmin();
$('#adminExport').onclick = () => exportCsv(null, 'all');
$('#adminDashboard').href = 'https://supabase.com/dashboard/project/' + (cfg.SUPABASE_URL || '').replace(/^https:\/\/|\.supabase\.co.*$/g, '');

async function refreshAdmin() {
  try {
    const [ov] = await Promise.all([sb.rpc('admin_overview').then(check), loadUsers()]);
    const sPct = Math.min(100, ov.storage_bytes / FREE_STORAGE * 100), dPct = Math.min(100, ov.db_bytes / FREE_DB * 100);
    const card = (k, v, sub = '', pct = null) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>
      ${sub ? `<div class="k">${sub}</div>` : ''}${pct !== null ? `<div class="bar lg ${pct > 80 ? 'warn' : ''}"><i style="width:${pct}%"></i></div>` : ''}</div>`;
    $('#adminCards').innerHTML =
      card('Tài khoản', ov.users) + card('Lô ảnh', ov.batches) +
      card('Ảnh đã tải', ov.images, `${ov.graded} đã chấm (${ov.images ? Math.round(ov.graded / ov.images * 100) : 0}%)`) +
      card('Dung lượng ảnh', fmtBytes(ov.storage_bytes), `${sPct.toFixed(1)}% của 1 GB miễn phí`, sPct) +
      card('Cơ sở dữ liệu', fmtBytes(ov.db_bytes), `${dPct.toFixed(1)}% của 500 MB miễn phí`, dPct);
    renderUsers();
  } catch (e) { toast(e.message); }
}
function renderUsers() {
  $('#adminUserCount').textContent = state.users.length + ' tài khoản';
  $('#adminUsers').innerHTML = state.users.map(u => {
    const me = u.id === state.user.id;
    return `<tr data-id="${u.id}">
      <td><span class="uname">${esc(u.username)}</span>${u.is_admin ? '<span class="role">Quản trị</span>' : ''}${me ? '<span class="you">(bạn)</span>' : ''}</td>
      <td>${dateStr(u.created_at)}</td>
      <td>${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('vi-VN') : '<span class="muted">chưa đăng nhập</span>'}</td>
      <td class="num">${u.batches}</td><td class="num">${u.images}</td><td class="num">${u.graded}</td>
      <td class="num">${fmtBytes(u.storage_bytes)}</td>
      <td><div class="actions">
        <button class="btn outline" data-act="view">Xem dữ liệu</button>
        <button class="btn outline" data-act="pass">Đặt lại mật khẩu</button>
        ${me ? '' : `<button class="btn outline" data-act="role">${u.is_admin ? 'Bỏ quản trị' : 'Cấp quản trị'}</button>
        <button class="btn danger-ghost" data-act="del">Xoá</button>`}
      </div></td></tr>`;
  }).join('');
  $('#adminUsers').querySelectorAll('button[data-act]').forEach(b => b.onclick = () =>
    adminAction(b.dataset.act, state.users.find(u => u.id === b.closest('tr').dataset.id)));
}
async function adminAction(act, u) {
  try {
    if (act === 'view') return viewUserData(u.id);
    if (act === 'pass') {
      const p = prompt(`Nhập mật khẩu mới cho "${u.username}" (tối thiểu 6 ký tự):`);
      if (p === null) return;
      if (p.length < 6) return toast('Mật khẩu tối thiểu 6 ký tự');
      check(await sb.rpc('admin_set_password', { target: u.id, new_password: p }));
      return toast(`Đã đổi mật khẩu cho ${u.username}`);
    }
    if (act === 'role') {
      if (!confirm(u.is_admin ? `Bỏ quyền quản trị của "${u.username}"?` : `Cấp quyền quản trị cho "${u.username}"? Người này sẽ xem và sửa được toàn bộ dữ liệu.`)) return;
      check(await sb.rpc('admin_set_admin', { target: u.id, make_admin: !u.is_admin }));
      toast('Đã cập nhật quyền'); return refreshAdmin();
    }
    if (act === 'del') {
      if (!confirm(`Xoá vĩnh viễn tài khoản "${u.username}" cùng ${u.batches} lô, ${u.images} ảnh và toàn bộ kết quả? Không thể hoàn tác.`)) return;
      const imgs = await fetchAll(() => sb.from('images').select('storage_path').eq('user_id', u.id).order('id'));
      const paths = imgs.map(i => i.storage_path);
      for (let k = 0; k < paths.length; k += 100) check(await sb.storage.from(BUCKET).remove(paths.slice(k, k + 100)));
      check(await sb.rpc('admin_delete_user', { target: u.id }));
      if (state.scope === u.id) { state.scope = 'me'; localStorage.setItem('pg-scope', 'me'); }
      toast(`Đã xoá tài khoản ${u.username}`);
      await refreshAdmin(); await loadBatches();
    }
  } catch (e) { toast(e.message); }
}

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

const RAW_EXT = /\.(cr2|cr3|nef|nrw|arw|dng|orf|rw2|raf|pef|srw)$/i;
const isImage = f => f.type.startsWith('image/') || RAW_EXT.test(f.name) || /\.(jpe?g|png|gif|webp|bmp|tiff?|heic)$/i.test(f.name);
const extOf = f => (f.name.split('.').pop() || 'jpg').toLowerCase();

// ----- Đọc ảnh RAW (.cr2, .nef, .arw, .dng…): lấy ảnh JPEG mà máy ảnh nhúng sẵn trong file -----
function rawPreviewCandidates(buf) {
  const dv = new DataView(buf), size = buf.byteLength, out = [];
  let orientation = 1;
  const bo = size > 8 ? dv.getUint16(0) : 0;
  if (bo === 0x4949 || bo === 0x4d4d) {               // file dạng TIFF (CR2, NEF, ARW, DNG, ORF, PEF…)
    const le = bo === 0x4949, u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    const seen = new Set();
    const readIfd = (off, depth, first) => {
      if (!off || off + 2 > size || seen.has(off) || depth > 4) return 0;
      seen.add(off);
      const n = u16(off), t = {};
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12; if (e + 12 > size) break;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        t[tag] = { cnt, val: type === 3 && cnt === 1 ? u16(e + 8) : u32(e + 8) };
      }
      if (first && t[0x112]) orientation = t[0x112].val || 1;
      if (t[0x201] && t[0x202]) out.push([t[0x201].val, t[0x202].val]);
      if (t[0x111] && t[0x117] && t[0x111].cnt === 1) out.push([t[0x111].val, t[0x117].val]);
      if (t[0x14a]) { const c = t[0x14a]; if (c.cnt === 1) readIfd(c.val, depth + 1); else for (let k = 0; k < c.cnt && c.val + k * 4 + 4 <= size; k++) readIfd(u32(c.val + k * 4), depth + 1); }
      if (t[0x8769]) readIfd(t[0x8769].val, depth + 1);
      const nx = off + 2 + n * 12; return nx + 4 <= size ? u32(nx) : 0;
    };
    try { if (u16(2) === 42) { let next = u32(4), i = 0; while (next && i < 8) next = readIfd(next, 0, i++ === 0); } } catch { /* file lỗi */ }
  }
  const okJpeg = ([o, l]) => l > 1000 && o + l <= size && dv.getUint16(o) === 0xffd8;
  let cands = out.filter(okJpeg).map(([o, l]) => ({ o, l }));
  if (!cands.length) {                                 // định dạng khác (CR3, RAF…): dò các ảnh JPEG nằm trong file
    const b = new Uint8Array(buf);
    for (let i = 0; i < size - 3 && cands.length < 12; i++)
      if (b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff) { cands.push({ o: i, l: size - i }); i += 1024; }
  }
  cands.sort((a, b) => b.l - a.l);
  return { cands, orientation };
}

async function decodeRaw(file) {
  const buf = await file.arrayBuffer();
  const { cands, orientation } = rawPreviewCandidates(buf);
  let best = null;
  for (const c of cands) {
    try {
      const bmp = await createImageBitmap(new Blob([buf.slice(c.o, c.o + c.l)], { type: 'image/jpeg' }));
      if (!best || bmp.width * bmp.height > best.width * best.height) { best?.close(); best = bmp; } else bmp.close();
      if (best.width >= 2000 && cands.length > 3) break;
    } catch { /* không giải mã được (ví dụ dữ liệu RAW thô), thử ứng viên tiếp theo */ }
  }
  if (!best) throw new Error('Không đọc được ảnh xem trước trong file ' + file.name);
  return { bmp: best, orientation };
}

function drawToJpeg(bmp, orientation, maxSide, quality) {
  const rot = orientation === 6 || orientation === 8;
  const w0 = bmp.width, h0 = bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = rot ? h : w; c.height = rot ? w : h;
  const ctx = c.getContext('2d');
  if (orientation === 3) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  else if (orientation === 6) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else if (orientation === 8) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(bmp, 0, 0, w, h);
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}

// chuẩn bị ảnh trước khi tải: RAW → JPEG; ảnh thường thì thu nhỏ nếu bật "Nén ảnh"
async function prepare(file) {
  const compress = $('#compress').checked;
  if (RAW_EXT.test(file.name)) {
    const { bmp, orientation } = await decodeRaw(file);
    const blob = await drawToJpeg(bmp, orientation, compress ? MAX_SIDE : 4000, compress ? JPEG_QUALITY : 0.93);
    bmp.close();
    return { blob, ext: 'jpg' };
  }
  if (!compress || !/^image\/(jpeg|png|webp|bmp)$/.test(file.type)) return { blob: file, ext: extOf(file) };
  try {
    const bmp = await createImageBitmap(file);
    if (Math.max(bmp.width, bmp.height) <= MAX_SIDE && file.size < 600 * 1024) { bmp.close(); return { blob: file, ext: extOf(file) }; }
    const blob = await drawToJpeg(bmp, 1, MAX_SIDE, JPEG_QUALITY); bmp.close();
    return blob && blob.size < file.size ? { blob, ext: 'jpg' } : { blob: file, ext: extOf(file) };
  } catch { return { blob: file, ext: extOf(file) }; }
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
    const hasRaw = list.some(x => RAW_EXT.test(x.file.name));
    await Promise.all(Array.from({ length: hasRaw ? 2 : PARALLEL }, worker));
    await flush(true);
    setP(list.length, failed ? `Xong – ${failed} ảnh lỗi` : 'Hoàn tất');
    toast(failed ? `Đã tải ${list.length - failed} ảnh, ${failed} ảnh lỗi` : `Đã tải lên ${list.length} ảnh`);
    await loadBatches();
    await openBatch(batchId);
  } catch (e) { toast(e.message); $('#uploadLabel').textContent = '⚠ ' + e.message; }
  setTimeout(() => prog.classList.add('hidden'), 2000);
}


// ---------- chuyển ảnh RAW đã tải lên trước đây sang JPEG ----------
$('#rawConvert').onclick = async () => {
  const raws = state.images.filter(i => RAW_EXT.test(i.storage_path));
  if (!raws.length || rawBusy) return;
  rawBusy = true; $('#rawBanner').classList.add('hidden');
  const prog = $('#uploadProgress'); prog.classList.remove('hidden');
  let done = 0, failed = 0;
  const setP = () => {
    $('#uploadBar').style.width = Math.round(done / raws.length * 100) + '%';
    $('#uploadPct').textContent = Math.round(done / raws.length * 100) + '%';
    $('#uploadLabel').textContent = `Đang chuyển RAW → JPEG ${done}/${raws.length}…`;
  };
  setP();
  await signUrls(raws);
  let next = 0;
  const worker = async () => {
    while (next < raws.length) {
      const img = raws[next++];
      try {
        const res = await fetch(urlOf(img));
        if (!res.ok) throw new Error('Không tải được ' + img.rel_path);
        const file = new File([await res.blob()], img.filename);
        const { blob } = await prepare(file);
        const folder = img.storage_path.split('/').slice(0, -1).join('/');
        const path = `${folder}/${crypto.randomUUID()}.jpg`;
        check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
        check(await sb.from('images').update({ storage_path: path }).eq('id', img.id));
        await sb.storage.from(BUCKET).remove([img.storage_path]);
        img.storage_path = path;
      } catch (e) { failed++; console.error(img.rel_path, e); }
      done++; setP();
    }
  };
  await Promise.all([worker(), worker()]);
  rawBusy = false;
  $('#uploadLabel').textContent = failed ? `Xong – ${failed} ảnh lỗi` : 'Đã chuyển xong';
  setTimeout(() => prog.classList.add('hidden'), 2000);
  toast(failed ? `Đã chuyển ${raws.length - failed} ảnh, ${failed} ảnh lỗi` : `Đã chuyển ${raws.length} ảnh RAW sang JPEG`);
  await refreshImages(); loadBatches();
};


// ---------- KHOANH VÙNG: AI + chỉnh tay ----------
const REGION_CLASSES = [
  { name: 'cap', label: 'Nắp', hex: '#2563eb' },
  { name: 'Headspace', label: 'Headspace', hex: '#0ea5e9' },
  { name: 'plasma', label: 'Plasma', hex: '#eab308' },
  { name: 'bloodcell', label: 'Hồng cầu', hex: '#dc2626' },
];
const regClass = r => REGION_CLASSES.find(c => c.name === r.name) || { label: r.name, hex: '#a855f7' };
const seg = { hidden: new Set(JSON.parse(localStorage.getItem('pg-seg-hidden') || '[]')), editing: false, drawing: null, sel: -1, busy: new Set(), drag: null, shownId: null };
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.min.js';
let ortLoading = null;
const loadOrt = () => window.ort ? Promise.resolve() : (ortLoading ||= new Promise((res, rej) => {
  const sc = document.createElement('script'); sc.src = ORT_URL; sc.onload = res;
  sc.onerror = () => { ortLoading = null; rej(new Error('Không tải được thư viện AI')); };
  document.head.appendChild(sc);
}));
async function ensureModel() {
  await loadOrt();
  if (!TubeSeg.ready) await TubeSeg.load(p => setSeg('busy', `Đang tải mô hình AI… ${Math.round(p * 100)}%`));
}
function setSeg(cls, text) { const el = $('#segStatus'); el.className = 'seg-status ' + (cls || ''); el.textContent = text || ''; }
const segSummary = img => !img.regions ? (RAW_EXT.test(img.storage_path) ? '' : 'Chưa khoanh vùng')
  : img.regions.length ? `${img.regions.length} vùng · ${img.regions_source === 'manual' ? 'đã chỉnh tay' : 'AI khoanh'}` : 'Không có vùng';
const bboxOf = pts => {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
// tỉ lệ chiều cao plasma so với plasma + hồng cầu (dùng khung bao)
function plasmaRatio(regions) {
  const h = n => { const r = (regions || []).filter(x => x.name === n).map(x => bboxOf(x.pts)); return r.length ? Math.max(...r.map(b => b[3] - b[1])) : 0; };
  const p = h('plasma'), c = h('bloodcell');
  return p && c ? Math.round(p / (p + c) * 1000) / 10 : '';
}

const autoSegBox = $('#autoSeg');
autoSegBox.checked = localStorage.getItem('pg-autoseg') !== '0';
autoSegBox.onchange = () => { localStorage.setItem('pg-autoseg', autoSegBox.checked ? '1' : '0'); if (autoSegBox.checked) maybeAutoSeg(); };

async function segmentImage(img) {
  if (seg.busy.has(img.id)) return null;
  seg.busy.add(img.id);
  try {
    await ensureModel();
    if (img.id === state.currentId) setSeg('busy', 'AI đang khoanh vùng…');
    await signUrls([img]);
    const res = await fetch(urlOf(img));
    if (!res.ok) throw new Error('Không tải được ảnh');
    const bmp = await createImageBitmap(await res.blob());
    const regions = await TubeSeg.run(bmp); bmp.close();
    await saveRegions(img, regions, 'ai');
    return regions;
  } finally { seg.busy.delete(img.id); }
}
async function saveRegions(img, regions, source) {
  img.regions = regions; img.regions_source = source; img.regions_at = new Date().toISOString();
  if (img.id === state.currentId) { renderOverlay(); setSeg('busy', 'Đang lưu vùng…'); }
  check(await sb.from('images').update({ regions, regions_source: source, regions_at: img.regions_at }).eq('id', img.id));
  if (img.id === state.currentId) setSeg('', segSummary(img));
}
const saveManualSoon = debounce(img => saveRegions(img, img.regions, 'manual').catch(e => setSeg('', '⚠ ' + e.message)), 500);
function markManual(img, i) {
  const r = img.regions[i]; if (r) { r.src = 'manual'; r.box = bboxOf(r.pts); }
  img.regions_source = 'manual'; renderOverlay(); saveManualSoon(img);
}

async function runCurrent(force) {
  const img = current(); if (!img) return;
  if (RAW_EXT.test(img.storage_path)) return toast('Ảnh còn ở dạng RAW – hãy chuyển sang JPEG trước');
  if (force && img.regions_source === 'manual' && !confirm('Ảnh này đã được chỉnh tay. Chạy lại AI sẽ ghi đè các vùng đã chỉnh. Tiếp tục?')) return;
  try {
    const r = await segmentImage(img);
    if (r && img.id === state.currentId && !r.length) setSeg('', 'AI không tìm thấy ống nghiệm');
  } catch (e) { if (img.id === state.currentId) setSeg('', '⚠ ' + e.message); }
}
$('#segRun').onclick = () => runCurrent(true);
function maybeAutoSeg() {
  const img = current();
  if (img && autoSegBox.checked && img.regions == null && !RAW_EXT.test(img.storage_path) && !seg.busy.has(img.id)) runCurrent(false);
}

$('#segBatch').onclick = async () => {
  const todo = state.images.filter(i => i.regions == null && !RAW_EXT.test(i.storage_path));
  if (!todo.length) return toast('Tất cả ảnh trong lô đã được khoanh vùng');
  const prog = $('#uploadProgress'); prog.classList.remove('hidden');
  let done = 0, failed = 0;
  const setP = () => {
    const pct = Math.round(done / todo.length * 100);
    $('#uploadBar').style.width = pct + '%'; $('#uploadPct').textContent = pct + '%';
    $('#uploadLabel').textContent = `AI khoanh vùng ${done}/${todo.length} ảnh…`;
  };
  setP();
  try { await ensureModel(); } catch (e) { prog.classList.add('hidden'); return toast(e.message); }
  for (const img of todo) {
    try { await segmentImage(img); } catch (e) { failed++; console.error(img.rel_path, e); }
    done++; setP();
  }
  $('#uploadLabel').textContent = failed ? `Xong – ${failed} ảnh lỗi` : 'Đã khoanh xong';
  setTimeout(() => prog.classList.add('hidden'), 2000);
  toast(failed ? `Đã khoanh ${todo.length - failed} ảnh, ${failed} ảnh lỗi` : `Đã khoanh vùng ${todo.length} ảnh`);
  showCurrent();
};

// ----- vẽ vùng đè lên ảnh -----
function renderOverlay() {
  const svg = $('#overlay'), img = current(), el = $('#mainImg');
  const W = el.naturalWidth, H = el.naturalHeight;
  svg.classList.toggle('editing', seg.editing); svg.classList.toggle('drawing', !!seg.drawing);
  renderLegend();
  if (!img || !W || !H || el.getAttribute('src') !== urlOf(img) || !el.complete) { svg.innerHTML = ''; $('#zoomer').style.transform = ''; return; }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  applyZoom();
  const rect = svg.getBoundingClientRect();
  const upp = Math.max(W / (rect.width || W), H / (rect.height || H)); // đơn vị ảnh trên mỗi pixel màn hình
  const regs = img.regions || [];
  let html = '';
  regs.forEach((r, i) => {
    if (seg.hidden.has(r.name) || !r.pts?.length) return;
    const c = regClass(r);
    html += `<polygon data-i="${i}" class="${i === seg.sel ? 'sel' : ''}" style="fill:${c.hex};stroke:${c.hex}" points="${r.pts.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ')}"/>`;
  });
  regs.forEach(r => {
    if (seg.hidden.has(r.name) || !r.pts?.length) return;
    const b = bboxOf(r.pts), c = regClass(r);
    html += `<text x="${(b[2] * W + 6 * upp).toFixed(1)}" y="${(((b[1] + b[3]) / 2) * H + 4 * upp).toFixed(1)}" font-size="${(12 * upp).toFixed(1)}" stroke-width="${(3 * upp).toFixed(1)}">${c.label}${r.conf != null && r.src !== 'manual' ? ' ' + Math.round(r.conf * 100) + '%' : ''}</text>`;
  });
  if (seg.editing) regs.forEach((r, i) => {
    if (seg.hidden.has(r.name) || (seg.sel !== -1 && seg.sel !== i)) return;
    const c = regClass(r);
    r.pts.forEach(([x, y], j) => { html += `<circle class="h" data-i="${i}" data-j="${j}" cx="${(x * W).toFixed(1)}" cy="${(y * H).toFixed(1)}" r="${(5 * upp).toFixed(1)}" style="stroke:${c.hex}"/>`; });
  });
  if (seg.drawing) {
    const c = REGION_CLASSES.find(k => k.name === seg.drawing.name);
    html += `<polyline class="draft" points="${seg.drawing.pts.map(([x, y]) => `${x * W},${y * H}`).join(' ')}"/>`;
    seg.drawing.pts.forEach(([x, y]) => { html += `<circle class="h" cx="${x * W}" cy="${y * H}" r="${(4 * upp).toFixed(1)}" style="stroke:${c.hex}"/>`; });
  }
  svg.innerHTML = html;
}
function renderLegend() {
  const img = current(), counts = {};
  (img?.regions || []).forEach(r => { counts[r.name] = (counts[r.name] || 0) + 1; });
  $('#segLegend').innerHTML = REGION_CLASSES.map(c =>
    `<button class="seg-chip ${seg.hidden.has(c.name) ? 'off' : ''}" data-n="${c.name}" title="Bật/tắt hiển thị ${c.label}"><i style="background:${c.hex}"></i>${c.label}${counts[c.name] ? `<span class="c">${counts[c.name]}</span>` : ''}</button>`).join('');
  $('#segLegend').querySelectorAll('.seg-chip').forEach(b => b.onclick = () => {
    seg.hidden.has(b.dataset.n) ? seg.hidden.delete(b.dataset.n) : seg.hidden.add(b.dataset.n);
    localStorage.setItem('pg-seg-hidden', JSON.stringify([...seg.hidden]));
    renderOverlay();
  });
}
$('#mainImg').addEventListener('load', renderOverlay);
window.addEventListener('resize', debounce(renderOverlay, 100));

// ----- chỉnh tay -----
$('#segNewCls').innerHTML = REGION_CLASSES.map(c => `<option value="${c.name}">${c.label}</option>`).join('');
function setEditing(on) {
  seg.editing = on; seg.sel = -1; seg.drawing = null;
  $('#segEdit').classList.toggle('active', on);
  $('#segEditBar').classList.toggle('hidden', !on);
  updateDrawBtn(); renderOverlay();
}
function updateDrawBtn() { $('#segDraw').textContent = seg.drawing ? '✓ Hoàn tất vùng' : '+ Vẽ vùng mới'; $('#overlay').classList.toggle('drawing', !!seg.drawing); }
$('#segEdit').onclick = () => {
  const img = current(); if (!img) return;
  if (RAW_EXT.test(img.storage_path)) return toast('Ảnh còn ở dạng RAW – hãy chuyển sang JPEG trước');
  setEditing(!seg.editing);
};
$('#segDone').onclick = () => { if (seg.drawing) finishDraw(); setEditing(false); };
$('#segDraw').onclick = () => {
  if (seg.drawing) return finishDraw();
  seg.sel = -1; seg.drawing = { name: $('#segNewCls').value, pts: [] };
  updateDrawBtn(); renderOverlay();
  toast('Bấm lần lượt các điểm quanh vùng · bấm đúp hoặc Enter để hoàn tất');
};
$('#segDel').onclick = () => deleteSelectedRegion();
function deleteSelectedRegion() {
  const img = current(); if (!img || seg.sel < 0 || !img.regions?.[seg.sel]) return toast('Chưa chọn vùng nào');
  img.regions.splice(seg.sel, 1); seg.sel = -1; markManual(img, -1);
}
function finishDraw() {
  const img = current(), d = seg.drawing; seg.drawing = null; updateDrawBtn();
  if (!img || !d) return renderOverlay();
  // bỏ các điểm trùng do bấm đúp
  const pts = d.pts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 0.002);
  if (pts.length < 3) { toast('Cần ít nhất 3 điểm để tạo vùng'); return renderOverlay(); }
  const cls = REGION_CLASSES.findIndex(c => c.name === d.name);
  img.regions = img.regions || [];
  img.regions.push({ cls, name: d.name, conf: null, box: bboxOf(pts), pts, src: 'manual' });
  seg.sel = img.regions.length - 1;
  markManual(img, seg.sel);
}
function handleSegKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); if (seg.drawing) { seg.drawing = null; updateDrawBtn(); renderOverlay(); } else setEditing(false); return true; }
  if (e.key === 'Enter' && seg.drawing) { e.preventDefault(); finishDraw(); return true; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && seg.sel >= 0) { e.preventDefault(); deleteSelectedRegion(); return true; }
  return false;
}
const svgPoint = e => {
  const svg = $('#overlay'), el = $('#mainImg');
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return [Math.min(1, Math.max(0, p.x / el.naturalWidth)), Math.min(1, Math.max(0, p.y / el.naturalHeight))].map(v => Math.round(v * 1e5) / 1e5);
};
$('#overlay').addEventListener('pointerdown', e => {
  if (!seg.editing) return;
  const img = current(); if (!img) return;
  e.preventDefault();
  if (seg.drawing) { seg.drawing.pts.push(svgPoint(e)); renderOverlay(); return; }
  const t = e.target;
  if (t.classList.contains('h') && t.dataset.j !== undefined) {
    seg.drag = { i: +t.dataset.i, j: +t.dataset.j }; seg.sel = +t.dataset.i;
    $('#overlay').setPointerCapture(e.pointerId); return;
  }
  seg.sel = t.tagName === 'polygon' ? +t.dataset.i : -1;
  renderOverlay();
});
$('#overlay').addEventListener('pointermove', e => {
  if (!seg.drag) return;
  const img = current(), r = img?.regions?.[seg.drag.i]; if (!r) return;
  r.pts[seg.drag.j] = svgPoint(e); renderOverlay();
});
$('#overlay').addEventListener('pointerup', e => {
  if (!seg.drag) return;
  const i = seg.drag.i; seg.drag = null;
  try { $('#overlay').releasePointerCapture(e.pointerId); } catch { /* đã nhả */ }
  markManual(current(), i);
});
$('#overlay').addEventListener('dblclick', e => { if (seg.drawing) { e.preventDefault(); finishDraw(); } });


// ----- phóng to vào ống nghiệm -----
seg.zoom = localStorage.getItem('pg-seg-zoom') !== '0';
function applyZoom() {
  const z = $('#zoomer'), img = current(), el = $('#mainImg'), st = $('#stage');
  const regs = (img?.regions || []).filter(r => r.pts?.length);
  $('#segZoom').classList.toggle('active', seg.zoom);
  if (!seg.zoom || !regs.length || !el.naturalWidth) { z.style.transform = ''; z.style.setProperty('--zf', 1); return; }
  const W = el.naturalWidth, H = el.naturalHeight, sw = st.clientWidth, sh = st.clientHeight;
  const k = Math.min(sw / W, sh / H), ox = (sw - W * k) / 2, oy = (sh - H * k) / 2;
  let [x1, y1, x2, y2] = bboxOf(regs.flatMap(r => r.pts));
  x1 = ox + x1 * W * k; x2 = ox + x2 * W * k; y1 = oy + y1 * H * k; y2 = oy + y2 * H * k;
  const pad = 0.12 * Math.max(x2 - x1, y2 - y1);
  const bw = x2 - x1 + 2 * pad, bh = y2 - y1 + 2 * pad;
  const f = Math.max(1, Math.min(sw / bw, sh / bh, 10));
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  z.style.transform = `translate(${sw / 2 - cx * f}px, ${sh / 2 - cy * f}px) scale(${f})`;
  z.style.setProperty('--zf', f);
}
$('#zoomer').addEventListener('transitionend', () => renderOverlay());
$('#segZoom').onclick = () => { seg.zoom = !seg.zoom; localStorage.setItem('pg-seg-zoom', seg.zoom ? '1' : '0'); applyZoom(); };

// ---------- boot ----------
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    // tránh gọi API Supabase trực tiếp trong callback (theo khuyến nghị của supabase-js)
    setTimeout(() => {
      if (session?.user) startApp(session.user);
      else { closeAdmin(); closeBatch(); state.batches = []; state.users = []; state.isAdmin = false; state.user = null; renderBatches(); setMode('login'); showAuth(); }
    }, 0);
  });
}
