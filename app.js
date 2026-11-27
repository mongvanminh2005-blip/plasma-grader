// chặn trang bị nhúng trong iframe của trang khác (clickjacking)
if (window.top !== window.self) { try { window.top.location = window.location.href; } catch { document.documentElement.style.display = 'none'; } }

// ===== Cấu hình nhãn độ (có thể sửa tuỳ quy ước của phòng xét nghiệm) =====
const GRADES = [
  { g: 0, label: 'Trong' },
  { g: 1, label: 'Đục nhẹ' },
  { g: 2, label: 'Đục vừa' },
  { g: 3, label: 'Đục rõ' },
  { g: 4, label: 'Đục nặng' },
  { g: 5, label: 'Cân nhắc lựa chọn' },
];
const BUCKET = 'plasma';
let rawBusy = false;      // đang chuyển RAW → JPEG
const MAX_SIDE = 1600;      // cạnh dài tối đa khi nén ảnh
const JPEG_QUALITY = 0.88;
const TUBE_MAX_H = 1200;     // chiều cao tối đa ảnh ống nghiệm đã cắt
const TUBE_PAD = 0.12;       // lề quanh ống (tỉ lệ chiều cao ống)
const TUBE_QUALITY = 0.88;
const PARALLEL = 4;         // số ảnh tải lên song song
const URL_TTL = 60 * 60 * 2; // link ảnh riêng tư có hiệu lực 2 giờ

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

const state = { pick: null, merge: null, profiles: [], view: 'grade', mode: 'login', user: null, batches: [], batchId: null, images: [], currentId: null, filter: 'all', channel: null, urls: new Map(),
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
  if (/Password should|weak password|password.*(length|characters)/i.test(m)) return 'Mật khẩu cần ít nhất 6 ký tự (giới hạn tối thiểu của hệ thống đăng nhập)';
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
function showPending(user) {
  state.user = null;
  $('#auth').classList.add('hidden'); $('#app').classList.add('hidden'); $('#pending').classList.remove('hidden');
  $('#pendingUser').textContent = displayName(user.email);
}
$('#pendingLogout').onclick = () => sb.auth.signOut();
$('#pendingCheck').onclick = async () => {
  const { data } = await sb.auth.getSession();
  if (!data.session) return showAuth();
  const ok = await sb.rpc('is_approved');
  if (ok.data) startApp(data.session.user); else toast('Tài khoản vẫn đang bị khoá');
};
function showAuth() {
  $('#pending').classList.add('hidden');
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
}
// mật khẩu: không đặt yêu cầu riêng; chỉ báo trước giới hạn tối thiểu 6 ký tự của Supabase
function passwordProblem(p) {
  return p.length < 6 ? 'Mật khẩu cần ít nhất 6 ký tự (giới hạn tối thiểu của hệ thống đăng nhập)' : '';
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('.confirm').classList.toggle('hidden', mode !== 'register');
  $('#rolePick').classList.toggle('hidden', mode !== 'register');
  $('#authForm').confirm.required = mode === 'register';
  $('#authForm').password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  // yêu cầu độ mạnh chỉ áp dụng khi tạo tài khoản (người cũ có thể còn mật khẩu ngắn)
  const pw = $('#authForm').password;
  pw.removeAttribute('minlength'); pw.placeholder = 'Mật khẩu';
  $('#authSubmit').textContent = mode === 'register' ? 'Tạo tài khoản' : 'Đăng nhập';
  $('#authError').textContent = '';
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, err = $('#authError');
  err.textContent = ''; err.style.color = '';
  if (state.mode === 'register' && f.password.value !== f.confirm.value) return (err.textContent = 'Mật khẩu nhập lại không khớp');
  if (state.mode === 'register' && passwordProblem(f.password.value)) return (err.textContent = passwordProblem(f.password.value));
  $('#authSubmit').disabled = true;
  try {
    const name = f.username.value.trim().toLowerCase();
    if (!name.includes('@') && !/^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){1,30}[a-z0-9]$/.test(name)) throw new Error('Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số và _ . -');
    localStorage.setItem(REMEMBER_KEY, f.remember.checked ? '1' : '0');
    const creds = { email: toEmail(name), password: f.password.value };
    if (state.mode === 'register') {
      const role = f.role.value === 'doctor' ? 'doctor' : 'student';
      const data = check(await sb.auth.signUp({ ...creds, options: { data: { role } } }));
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
  $('#pending').classList.add('hidden');
  state.user = user;
  startIdleTimer();
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  const dn = displayName(user.email); $('#username').textContent = dn; $('#avatar').textContent = (dn || '?')[0];
  buildGradeButtons();
  state.isAdmin = !!(await sb.rpc('is_admin')).data;
  state.scope = localStorage.getItem('pg-scope') || 'all';
  $('#adminBtn').classList.toggle('hidden', !state.isAdmin);
  $('#scopeBox').classList.remove('hidden');
  await loadProfiles().catch(e => { console.error(e); state.profiles = []; renderScope(); });
  $('#pendBadge').classList.add('hidden');
  applySegOn();
  applyAdminUi();
  if (state.isAdmin) purgeTrash().catch(e => console.error('purge', e)).finally(updateTrashCount);
  connectLive();
  await loadBatches();
  const saved = Number(localStorage.getItem('batchId'));
  if (await openFromHash()) return;
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
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'images' }, p => {
      const d = p.new, img = state.images.find(i => i.id === d.id);
      if (img && d.deleted_at) {
        state.images = state.images.filter(i => i.id !== d.id);
        if (state.currentId === d.id) state.currentId = view()[0]?.id ?? null;
        renderAll(); showCurrent(); return;
      }
      const editingThis = seg.editing && d.id === state.currentId;
      if (img && !editingThis && JSON.stringify(img.regions ?? null) !== JSON.stringify(d.regions ?? null)) {
        Object.assign(img, { regions: d.regions, regions_source: d.regions_source, regions_at: d.regions_at });
        renderAll();
        if (d.id === state.currentId) showCurrent();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, p => {
      const d = p.new && p.new.image_id ? p.new : null;
      if (d && d.user_id === uid) {   // điểm của tôi thay đổi ở thiết bị khác
        const img = state.images.find(i => i.id === d.image_id);
        if (img && (img.grade !== d.grade || img.note !== d.note)) {
          Object.assign(img, { grade: d.grade, note: d.note, graded_at: d.graded_at });
          renderAll(); if (d.image_id === state.currentId) showCurrent();
        }
      } else {
        const id = d?.image_id ?? p.old?.image_id, img = state.images.find(i => i.id === id);
        if (img && p.eventType === 'DELETE') refreshCurrent();
        else if (img && d) {
          const before = isDiff(img);
          if (d.grade === null) img.others.delete(d.user_id); else img.others.set(d.user_id, d.grade);
          if (before !== isDiff(img) || id === state.currentId) { renderAll(); if (id === state.currentId) renderDiffBar(img); }
        }
      }
      refreshBatches();
      if (state.view === 'summary') refreshSummarySoon();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images' }, p => {
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
    const canMerge = state.isAdmin;
    const pick = state.merge ? (canMerge ? `<input type="checkbox" class="mpick" ${state.merge.has(b.id) ? 'checked' : ''} />` : '<span class="mpick-x" title="Chỉ quản trị viên gộp lô">—</span>') : '';
    return `<li data-id="${b.id}" class="${b.id === state.batchId && !state.merge ? 'active' : ''} ${state.merge ? 'picking' : ''} ${state.merge?.has(b.id) ? 'picked' : ''} ${state.merge && !canMerge ? 'nopick' : ''}">${pick}<div class="bbody">
      <div class="bn" title="${esc(b.name)}">${!state.merge && canMerge ? `<button class="bren" data-ren="${b.id}" title="Đổi tên lô">✎</button>` : ''}${b.user_id !== state.user?.id ? `<span class="owner-tag">${esc(b.owner || '?')}</span>` : (b.shared ? '' : '<span class="owner-tag lock" title="Lô riêng">🔒</span>')}${esc(b.name)}</div>
      <div class="bm"><span>Tôi: ${b.graded}/${b.total} · 👥 ${b.raters || 0} · ${dateStr(b.created_at)}</span>
        ${pct === 100 && b.total ? '<span class="done">Xong</span>' : `<span>${pct}%</span>`}</div>
      <div class="bar"><i style="width:${pct}%"></i></div></div></li>`;
  }).join('');
  ul.querySelectorAll('li[data-id]').forEach(li => li.onclick = e => {
    if (e.target.dataset.ren) { e.stopPropagation(); return renameBatch(Number(e.target.dataset.ren)); }
    state.merge ? toggleMergePick(Number(li.dataset.id)) : openBatch(Number(li.dataset.id));
  });
  $('#emptyState').classList.toggle('hidden', !!state.batchId || state.view !== 'grade');
}

// ---------- xáo ảnh: mỗi người một thứ tự ngẫu nhiên riêng, cố định qua các lần mở ----------
const isShuffled = () => localStorage.getItem('pg-shuffle') !== '0';
function hash32(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return h >>> 0; }
function orderImages(imgs) {
  if (isShuffled()) {
    const key = state.user.id + ':';
    imgs.forEach(i => { i._k = hash32(key + i.id); });
    imgs.sort((a, b) => a._k - b._k || a.id - b.id);
  } else imgs.sort((a, b) => (a.rel_path < b.rel_path ? -1 : a.rel_path > b.rel_path ? 1 : a.id - b.id));
  return imgs;
}
const shownName = img => isShuffled() ? `Ảnh ${state.images.indexOf(img) + 1}/${state.images.length} · tên tệp được ẩn khi xáo` : img.rel_path;
function updateShuffleBtn() {
  const on = isShuffled();
  $('#shuffleBtn').classList.toggle('on', on);
  $('#shuffleBtn').textContent = on ? '🔀 Đang xáo ảnh' : '🔀 Xáo ảnh';
}
$('#shuffleBtn').onclick = () => {
  localStorage.setItem('pg-shuffle', isShuffled() ? '0' : '1');
  orderImages(state.images); updateShuffleBtn();
  toast(isShuffled() ? 'Đã xáo ảnh: thứ tự ngẫu nhiên riêng của bạn, ẩn tên tệp' : 'Đã tắt xáo: xếp theo tên tệp');
  renderAll(); showCurrent();
};
async function fetchImages(batchId) {
  const imgs = await fetchAll(() => sb.from('images')
    .select('id, batch_id, user_id, filename, rel_path, storage_path, regions, regions_source, regions_at')
    .eq('batch_id', batchId).is('deleted_at', null).order('rel_path').order('id'));
  // điểm của mọi người trong lô (mỗi người có điểm riêng)
  const all = await fetchAll(() => sb.from('ratings')
    .select('image_id, user_id, grade, note, graded_at, images!inner(batch_id)')
    .eq('images.batch_id', batchId).order('image_id').order('user_id'));
  const uid = state.user.id, byId = new Map(), others = new Map();
  all.forEach(r => {
    if (r.user_id === uid) byId.set(r.image_id, r);
    else if (r.grade !== null) { if (!others.has(r.image_id)) others.set(r.image_id, new Map()); others.get(r.image_id).set(r.user_id, r.grade); }
  });
  imgs.forEach(i => { const r = byId.get(i.id); i.grade = r?.grade ?? null; i.note = r?.note ?? ''; i.graded_at = r?.graded_at ?? null; i.others = others.get(i.id) || new Map(); });
  await signUrls(imgs);
  return orderImages(imgs);
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
  if (state.pick) setPick(false);
  if (state.view !== 'grade') { state.view = 'grade'; document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.view === 'grade')); $('#summaryPanel').classList.add('hidden'); $('#trashPanel').classList.add('hidden'); $('#colorPanel').classList.add('hidden'); $('#trashBtn').classList.remove('active'); }
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
// ảnh lệch: mình đã phân loại, có người khác phân loại, và các kết quả không giống nhau
const isDiff = i => i.grade !== null && !!i.others?.size && [...i.others.values()].some(g => g !== i.grade);
// độ bác sĩ (không tính mình) cho ảnh mình đã phân loại
const docOf = i => i.grade === null || !i.others?.size ? null : doctorRef([...i.others.entries()]);
const isDocDiff = i => { const d = docOf(i); return d !== null && d !== i.grade; };
function view() {
  const f = state.filter;
  if (f === 'all') return state.images;
  if (f === 'diff') return state.images.filter(isDiff);
  if (f === 'docdiff') return state.images.filter(isDocDiff);
  if (f === 'stumiss') return state.images.filter(i => stuMatch(i) === false);
  if (f === 'none') return state.images.filter(i => i.grade === null);
  return state.images.filter(i => i.grade === Number(f));
}

function renderAll() {
  const b = batch(); if (!b) return;
  if (document.activeElement !== $('#batchName')) $('#batchName').value = b.name;
  const total = state.images.length, graded = state.images.filter(i => i.grade !== null).length;
  const other = b.user_id !== state.user.id;
  $('#batchMeta').textContent = `${total} ảnh · tạo ngày ${dateStr(b.created_at)}`;
  $('#addToBatch').classList.toggle('hidden', other);
  const canManage = state.isAdmin;   // chỉ quản trị viên kiểm soát dữ liệu
  $('#sharedBox').classList.toggle('hidden', !canManage);
  $('#renameBatch').classList.toggle('hidden', !canManage);
  $('#batchShared').checked = !!b.shared;
  $('#deleteBatch').classList.toggle('hidden', !canManage);
  $('#batchName').readOnly = !canManage;
  if (other) $('#batchMeta').textContent = `${total} ảnh · lô chung của ${b.owner || '?'} · ${b.raters || 0} người đã phân loại`;
  else $('#batchMeta').textContent += ` · ${b.shared ? 'lô chung' : 'lô riêng'} · ${b.raters || 0} người đã phân loại`;
  const raws = state.images.filter(i => RAW_EXT.test(i.storage_path));
  $('#rawBanner').classList.toggle('hidden', !raws.length || rawBusy || !state.isAdmin);
  if (raws.length) $('#rawText').textContent = `${raws.length} ảnh đang lưu ở dạng RAW (trình duyệt không hiển thị được và tốn dung lượng). Chuyển sang JPEG để xem, phân loại và giải phóng dung lượng — kết quả phân loại được giữ nguyên.`;
  $('#progressText').textContent = `${graded}/${total}`;
  $('#progressBar').style.width = (total ? graded / total * 100 : 0) + '%';

  const counts = GRADES.map(({ g }) => state.images.filter(i => i.grade === g).length);
  const max = Math.max(1, ...counts);
  $('#distribution').innerHTML = GRADES.map(({ g }, k) => `
    <div class="d"><div class="top"><span>Độ ${g}</span><b>${counts[k]}</b></div>
    <div class="track"><i data-g="${g}" style="width:${counts[k] / max * 100}%"></i></div></div>`).join('');

  const nDiff = state.images.filter(isDiff).length, nDoc = amDoctor() ? 0 : state.images.filter(isDocDiff).length;
  const nMiss = state.images.filter(i => stuMatch(i) === false).length;
  if ((state.filter === 'diff' && !nDiff) || (state.filter === 'docdiff' && !nDoc) || (state.filter === 'stumiss' && !nMiss)) state.filter = 'all';
  const chips = [['all', 'Tất cả', total], ['none', 'Chưa phân loại', total - graded], ...(nDiff ? [['diff', '⚠ Lệch nhau', nDiff]] : []), ...(nDoc ? [['docdiff', '🩺 Khác bác sĩ', nDoc]] : []), ...(nMiss ? [['stumiss', '✗ Không khớp sinh viên', nMiss]] : []), ...GRADES.map(({ g }, k) => [String(g), 'Độ ' + g, counts[k]])];
  $('#filters').innerHTML = chips.map(([k, l, c]) =>
    `<button class="chip ${['diff', 'docdiff', 'stumiss'].includes(k) ? 'diffchip' : ''} ${state.filter === k ? 'active' : ''}" data-f="${k}" ${k === 'diff' ? 'title="Ảnh bạn đã phân loại mà người khác chọn độ khác"' : ''}>${l}<span class="c">${c}</span></button>`).join('');
  $('#filters').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    state.filter = c.dataset.f;
    const v = view();
    if (!v.some(i => i.id === state.currentId) && v[0]) state.currentId = v[0].id;
    renderAll(); showCurrent();
  });
  updateShuffleBtn();
  renderThumbs();
  renderGradeSelection();
}

function renderThumbs() {
  const v = view(), box = $('#thumbs');
  if (!v.length) { box.innerHTML = '<div class="none-msg">Không có ảnh nào trong bộ lọc này</div>'; return; }
  box.innerHTML = v.map(i => `
    <div class="thumb ${i.id === state.currentId ? 'current' : ''} ${RAW_EXT.test(i.storage_path) ? 'raw' : ''} ${isDiff(i) ? 'diff' : ''} ${state.pick?.has(i.id) ? 'picked' : ''}" data-id="${i.id}" ${isShuffled() ? '' : `title="${esc(i.rel_path)}"`}>
      <img loading="lazy" src="${esc(urlOf(i))}" alt="" />
      ${state.pick ? (canDelete(i) ? `<input type="checkbox" class="tpick" ${state.pick.has(i.id) ? 'checked' : ''} />` : '') : (canDelete(i) ? `<button class="del" data-del="${i.id}" title="Xoá ảnh">✕</button>` : '')}
      ${i.grade === null ? '<span class="badge none">–</span>' : `<span class="badge" data-g="${i.grade}">${i.grade}</span>`}
    </div>`).join('');
  box.querySelectorAll('.thumb').forEach(t => t.onclick = e => {
    const id = Number(t.dataset.id);
    if (e.target.dataset.del) return deleteImages([id]);
    if (state.pick) { const img = state.images.find(i => i.id === id); if (!canDelete(img)) return toast('Chỉ quản trị viên được xoá ảnh'); state.pick.has(id) ? state.pick.delete(id) : state.pick.add(id); updatePickBar(); return renderThumbs(); }
    select(id);
  });
  box.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function showCurrent() {
  const img = current(), v = view();
  $('#stage').classList.toggle('hidden', !img);
  if (!img) { $('#fname').textContent = 'Không có ảnh'; $('#saveState').textContent = ''; $('#delImg').classList.add('hidden'); return; }
  const u = urlOf(img);
  if ($('#mainImg').getAttribute('src') !== u) $('#mainImg').src = u;
  $('#fname').textContent = shownName(img); $('#fname').title = isShuffled() ? '' : img.rel_path;
  const pos = v.findIndex(i => i.id === img.id);
  $('#counter').textContent = pos >= 0 ? `${pos + 1} / ${v.length}` : `${state.images.indexOf(img) + 1} / ${state.images.length}`;
  if (document.activeElement !== $('#note')) $('#note').value = img.note || '';
  setSave(img.graded_at ? 'ok' : '', img.graded_at ? 'Đã lưu lúc ' + timeStr(img.graded_at) : 'Chưa phân loại');
  renderGradeSelection();
  renderDiffBar(img);
  $('#delImg').classList.toggle('hidden', !canDelete(img));
  if (seg.shownId !== img.id) { seg.shownId = img.id; seg.sel = -1; seg.drawing = null; seg.pan = [0, 0]; if (seg.zoomFree) { seg.zoomFree = false; seg.zoomMode = sessionStorage.getItem('pg-zoom') || '1'; } updateDrawBtn(); }
  renderOverlay();
  if (!seg.busy.has(img.id)) setSeg('', segSummary(img));
  maybeAutoSeg();
}

function renderDiffBar(img) {
  const bar = $('#diffBar');
  bar.classList.remove('agree', 'miss');
  if (img && amDoctor() && img.grade !== null) {   // bác sĩ: phân loại xong thấy ngay kết quả sinh viên
    const sl = studentLine(img), list = state.images.filter(i => stuMatch(i) === false), k = list.indexOf(img);
    if (sl.cls) bar.classList.add(sl.cls);
    bar.innerHTML = `${sl.html}<span class="dact">${list.length && (k < 0 || list.length > 1) ? `<button class="link" id="diffNext">Ảnh không khớp ${k >= 0 ? 'tiếp theo ' : ''}(${list.length}) →</button>` : ''}
      <button class="link" id="diffLink" title="Sao chép đường dẫn mở thẳng tới ảnh này">🔗 Sao chép đường dẫn</button></span>`;
    bar.classList.remove('hidden');
    $('#diffNext')?.addEventListener('click', () => { state.filter = 'stumiss'; renderAll(); select(list[(k + 1) % list.length].id); });
    $('#diffLink').onclick = () => copyImageLink(img);
    return;
  }
  const doc = img ? docOf(img) : null;
  if (!img || (!isDiff(img) && doc === null)) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const list = state.images.filter(isDiff), k = list.indexOf(img);
  const who = [[state.user.id, img.grade], ...[...img.others].sort((a, b) => isDoctor(b[0]) - isDoctor(a[0]))].map(([u, g]) =>
    `<span class="dchip ${isDoctor(u) ? 'doc' : ''}">${roleTag(u)} ${u === state.user.id ? 'Bạn' : esc(nameOfUser(u))}: <b>${g}</b></span>`).join('');
  const msg = doc === null ? '<span class="dmsg">⚠ Ảnh này được phân loại khác nhau</span>'
    : doc === img.grade ? `<span class="dmsg ok">🩺 Trùng kết quả bác sĩ (độ ${doc})</span>`
    : `<span class="dmsg">🩺 Bác sĩ chọn độ ${doc}, bạn chọn độ ${img.grade}</span>`;
  bar.classList.toggle('agree', doc !== null && doc === img.grade && !isDiff(img));
  bar.innerHTML = `${msg}${who}
    <span class="dact">${k >= 0 && list.length > 1 ? `<button class="link" id="diffNext">Ảnh lệch tiếp theo (${k + 1}/${list.length}) →</button>` : ''}
    <button class="link" id="diffLink" title="Sao chép đường dẫn mở thẳng tới ảnh này">🔗 Sao chép đường dẫn</button></span>`;
  bar.classList.remove('hidden');
  $('#diffNext')?.addEventListener('click', () => select(list[(k + 1) % list.length].id));
  $('#diffLink').onclick = () => copyImageLink(img);
}
function imageLink(img) { return `${location.origin}${location.pathname}#lo=${img.batch_id}&anh=${img.id}`; }
async function copyImageLink(img) {
  const url = imageLink(img);
  try { await navigator.clipboard.writeText(url); toast('Đã sao chép đường dẫn tới ảnh'); }
  catch { prompt('Đường dẫn tới ảnh:', url); }
}
// mở ảnh từ đường dẫn #lo=..&anh=..
async function openFromHash() {
  const m = /lo=(\d+)&anh=(\d+)/.exec(location.hash); if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try { await openImageFromSummary(Number(m[1]), Number(m[2])); } catch (e) { toast(e.message); }
  if (!state.images.some(i => i.id === Number(m[2]))) toast('Không tìm thấy ảnh trong đường dẫn (có thể đã bị xoá hoặc bạn không có quyền xem)');
  return true;
}
window.addEventListener('hashchange', () => state.user && openFromHash());
function select(id) {
  if (id !== state.currentId) hideDocResult();
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
    const row = {
      image_id: img.id, user_id: state.user.id,
      grade: 'grade' in patch ? patch.grade : img.grade,
      note: 'note' in patch ? patch.note : (img.note || ''),
      graded_at: 'graded_at' in patch ? patch.graded_at : img.graded_at,
      updated_at: new Date().toISOString(),
    };
    const r = check(await sb.from('ratings').upsert(row, { onConflict: 'image_id,user_id' }).select('grade, note, graded_at').single());
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
  if (ok && g !== null && amDoctor()) {   // bác sĩ: không tự chuyển; chỉ hiện bảng lớn khi không khớp sinh viên
    showCurrent();
    if (stuMatch(img) === false && docPopupOn()) showDocResult(img);
    loadBatches(); return;
  }   // bác sĩ: xem kết quả, không tự chuyển
  if (ok && $('#autoNext').checked && g !== null) {
    const nextPos = nv.some(i => i.id === img.id) ? pos + 1 : pos;
    if (nv[nextPos]) select(nv[nextPos].id);
    else { if (!state.images.some(i => i.grade === null)) toast('🎉 Đã phân loại xong toàn bộ lô!'); showCurrent(); }
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

// ---------- XOÁ ẢNH ----------
const canDelete = img => !!img && state.isAdmin;
// giao diện chỉ quản trị viên mới thấy: xoá, gộp lô, thùng rác
function applyAdminUi() {
  const a = !!state.isAdmin;
  ['#pickMode', '#mergeBtn', '#trashBtn'].forEach(sel => $(sel)?.classList.toggle('hidden', !a));
}
async function deleteImages(ids) {
  const imgs = ids.map(id => state.images.find(i => i.id === id)).filter(canDelete);
  if (!imgs.length) return toast('Chỉ xoá được ảnh do bạn tải lên');
  const msg = imgs.length === 1
    ? `Chuyển ảnh "${imgs[0].rel_path}" vào thùng rác?\nCó thể khôi phục trong ${TRASH_DAYS} ngày (kèm điểm và vùng khoanh).`
    : `Chuyển ${imgs.length} ảnh đã chọn vào thùng rác?\nCó thể khôi phục trong ${TRASH_DAYS} ngày (kèm điểm và vùng khoanh).`;
  if (!confirm(msg)) return;
  const pos = view().findIndex(i => i.id === state.currentId);
  try {
    const now = new Date().toISOString();
    for (let k = 0; k < imgs.length; k += 100)
      check(await sb.from('images').update({ deleted_at: now }).in('id', imgs.slice(k, k + 100).map(i => i.id)));
  } catch (e) { return toast(e.message); }
  const gone = new Set(imgs.map(i => i.id));
  state.images = state.images.filter(i => !gone.has(i.id));
  if (gone.has(state.currentId)) { const v = view(); state.currentId = (v[Math.min(Math.max(pos, 0), v.length - 1)] || v[0])?.id ?? null; }
  if (state.pick) { gone.forEach(id => state.pick.delete(id)); updatePickBar(); }
  toast(imgs.length === 1 ? 'Đã chuyển ảnh vào thùng rác' : `Đã chuyển ${imgs.length} ảnh vào thùng rác`);
  updateTrashCount();
  renderAll(); showCurrent(); loadBatches();
}
$('#delImg').onclick = () => current() && deleteImages([state.currentId]);
function setPick(on) {
  state.pick = on ? new Set() : null;
  $('#pickBar').classList.toggle('hidden', !on);
  $('#pickMode').textContent = on ? '✕ Thôi chọn' : '☐ Chọn nhiều';
  updatePickBar(); renderThumbs();
}
function updatePickBar() {
  const n = state.pick?.size || 0;
  $('#pickCount').textContent = `Đã chọn ${n}`;
  $('#pickDel').disabled = !n;
  $('#pickDel').textContent = n ? `🗑 Xoá ${n} ảnh` : '🗑 Xoá';
}
$('#pickMode').onclick = () => setPick(!state.pick);
$('#pickAll').onclick = () => {
  const ok = view().filter(canDelete);
  const all = ok.every(i => state.pick.has(i.id));
  ok.forEach(i => all ? state.pick.delete(i.id) : state.pick.add(i.id));
  $('#pickAll').textContent = all ? 'Chọn tất cả' : 'Bỏ chọn tất cả';
  updatePickBar(); renderThumbs();
};
$('#pickDel').onclick = () => state.pick?.size && deleteImages([...state.pick]);

$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);

$('#lightbox').onclick = () => $('#lightbox').classList.add('hidden');

document.addEventListener('keydown', e => {
  if ($('#app').classList.contains('hidden') || !state.batchId) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (seg.editing && handleSegKey(e)) return;
  if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey) return setZoom(seg.zoomMode === 'fit' ? 1 : 'fit');
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
async function renameBatch(id) {
  const b = state.batches.find(x => x.id === id); if (!b) return;
  let name = prompt('Tên mới cho lô:', b.name);
  if (name === null) return;
  name = name.trim().slice(0, 120);
  if (!name) return toast('Tên lô không được để trống');
  if (name === b.name) return;
  try {
    check(await sb.from('batches').update({ name }).eq('id', id));
    toast(`Đã đổi tên lô thành "${name}"`);
    await loadBatches(); if (state.batchId === id) renderAll();
  } catch (e) { toast(e.message); }
}
$('#renameBatch').onclick = () => state.batchId && renameBatch(state.batchId);
$('#batchShared').onchange = async e => {
  try {
    check(await sb.from('batches').update({ shared: e.target.checked }).eq('id', state.batchId));
    toast(e.target.checked ? 'Lô chung: mọi người có thể xem và phân loại' : 'Lô riêng: chỉ bạn (và quản trị viên) thấy');
    loadBatches().then(renderAll);
  } catch (ex) { e.target.checked = !e.target.checked; toast(ex.message); }
};
$('#deleteBatch').onclick = async () => {
  const b = batch();
  if (!confirm(`Chuyển lô "${b.name}" (${b.total} ảnh) vào thùng rác?\nCó thể khôi phục nguyên vẹn trong ${TRASH_DAYS} ngày.`)) return;
  try { check(await sb.from('batches').update({ deleted_at: new Date().toISOString() }).eq('id', b.id)); }
  catch (e) { return toast(e.message); }
  toast(`Đã chuyển lô "${b.name}" vào thùng rác`); updateTrashCount();
  closeBatch(); await loadBatches();
  if (state.batches[0]) openBatch(state.batches[0].id);
};

// ---------- export CSV ----------
// ---------- dữ liệu điểm của mọi người ----------
// batchId: một lô; null: mọi lô đang xem được
async function loadRatingData(batchId) {
  // chỉ lấy lô / ảnh chưa nằm trong thùng rác
  const active = new Set((await fetchAll(() => sb.from('batch_stats').select('id').order('id'))).map(b => b.id));
  const images = (await fetchAll(() => {
    const q = sb.from('images').select('id, batch_id, user_id, filename, rel_path, storage_path, regions, regions_source').is('deleted_at', null).order('batch_id').order('rel_path').order('id');
    return batchId ? q.eq('batch_id', batchId) : q;
  })).filter(i => active.has(i.batch_id));
  const ids = new Set(images.map(i => i.id));
  const ratings = (await fetchAll(() => {
    const q = sb.from('ratings').select('image_id, user_id, grade, note, graded_at, images!inner(batch_id)').not('grade', 'is', null).order('image_id').order('user_id');
    return batchId ? q.eq('images.batch_id', batchId) : q;
  })).filter(r => ids.has(r.image_id));
  if (!state.profiles.length) await loadProfiles().catch(() => {});
  return { images, ratings };
}
const modeOf = arr => {
  const c = {}; arr.forEach(g => { c[g] = (c[g] || 0) + 1; });
  const max = Math.max(...Object.values(c));
  return Object.keys(c).filter(k => c[k] === max).map(Number);
};

// xuất CSV: mỗi ảnh một dòng, mỗi người phân loại một cột
async function exportCsv(batchId) {
  try {
    toast('Đang chuẩn bị file CSV…');
    const { text, name } = await buildCsv(batchId);
    downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
  } catch (ex) { toast(ex.message); }
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function buildCsv(batchId) {
  {
    const { images, ratings } = await loadRatingData(batchId);
    const batchName = new Map((await fetchAll(() => sb.from('batch_stats').select('id, name').order('id'))).map(b => [b.id, b.name]));
    const raters = [...new Set(ratings.map(r => r.user_id))].sort((a, b) => nameOfUser(a).localeCompare(nameOfUser(b)));
    const byImg = new Map(); ratings.forEach(r => { if (!byImg.has(r.image_id)) byImg.set(r.image_id, new Map()); byImg.get(r.image_id).set(r.user_id, r); });
    const labelOf = g => GRADES.find(x => x.g === g)?.label || '';
    const e = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const head = ['Lô', 'Người tải', 'Đường dẫn', 'Tên file', ...raters.map(u => `Độ – ${nameOfUser(u)} (${ROLE_LABEL[roleOf(u)]})`),
      'Số người phân loại', 'Độ phổ biến nhất', 'Mức', 'Đồng thuận', 'Chênh lệch (0–4)', 'Ghi chú',
      'Khoanh vùng', 'Plasma / (plasma + hồng cầu) theo chiều cao (%)'];
    const lines = [head.map(e).join(',')];
    images.forEach(im => {
      const m = byImg.get(im.id) || new Map();
      const gs = [...m.values()].map(r => r.grade);
      const num = gs.filter(g => g <= 4);
      const md = gs.length ? modeOf(gs) : [];
      const notes = [...m.entries()].filter(([, r]) => r.note).map(([u, r]) => `${nameOfUser(u)}: ${r.note}`).join(' | ');
      lines.push([batchName.get(im.batch_id), nameOfUser(im.user_id), im.rel_path, im.filename,
        ...raters.map(u => m.get(u)?.grade ?? ''), gs.length,
        md.length === 1 ? md[0] : md.join('/'), md.length === 1 ? labelOf(md[0]) : '',
        gs.length >= 2 ? (new Set(gs).size === 1 ? 'Đồng ý' : 'Khác nhau') : '',
        num.length >= 2 ? Math.max(...num) - Math.min(...num) : '', notes,
        im.regions ? (im.regions_source === 'manual' ? 'Chỉnh tay' : 'AI') : '', plasmaRatio(im.regions)].map(e).join(','));
    });
    return { text: '﻿' + lines.join('\r\n'),
      name: batchId ? `ket-qua-${(batchName.get(batchId) || 'lo').replace(/[\\/:*?"<>|]/g, '_')}.csv` : 'ket-qua-tat-ca.csv' };
  }
}
$('#exportAll').onclick = () => exportCsv(null);
$('#exportBatch').onclick = () => exportCsv(state.batchId);


// ---------- QUẢN TRỊ ----------
const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const FREE_STORAGE = 1024 ** 3, FREE_DB = 500 * 1024 ** 2;

async function loadUsers() {
  state.users = check(await sb.rpc('admin_list_users'));
}
async function loadProfiles() {
  state.profiles = check(await sb.from('profiles').select('id, username, role').order('username'));
  const me = state.profiles.find(p => p.id === state.user?.id);
  state.myRole = me?.role || 'student';
  $('#autoNextBox').classList.toggle('hidden', state.myRole === 'doctor');
  $('#docPopupBox').classList.toggle('hidden', state.myRole !== 'doctor');
  $('#docPopup').checked = docPopupOn();
  $('#myRole').textContent = ROLE_LABEL[state.myRole]; $('#myRole').dataset.r = state.myRole; $('#myRole').classList.remove('hidden');
  renderScope();
}
const ROLE_LABEL = { doctor: 'Bác sĩ', student: 'Sinh viên' };
const roleOf = id => (state.profiles.find(p => p.id === id)?.role) || 'student';
const isDoctor = id => roleOf(id) === 'doctor';
const roleTag = id => `<span class="role-tag" data-r="${roleOf(id)}">${roleOf(id) === 'doctor' ? 'BS' : 'SV'}</span>`;
// độ "đối chiếu" của bác sĩ: độ được các bác sĩ chọn nhiều nhất (không tính độ 5, hoà thì bỏ); exclude = bỏ một người
function doctorRef(entries, exclude) {
  const g = entries.filter(([u, x]) => u !== exclude && isDoctor(u) && x !== null && x !== 5).map(([, x]) => x);
  if (!g.length) return null;
  const m = modeOf(g); return m.length === 1 ? m[0] : null;
}
// kết quả của sinh viên cho một ảnh: độ được nhiều sinh viên chọn nhất (không tính độ 5)
function studentRef(entries) {
  const g = entries.filter(([u, x]) => !isDoctor(u) && x !== null && x !== 5).map(([, x]) => x);
  if (!g.length) return null;
  const counts = [0, 0, 0, 0, 0]; g.forEach(x => counts[x]++);
  const n = Math.max(...counts), top = counts.map((c, i) => c === n ? i : -1).filter(i => i >= 0);
  return { grade: top.length === 1 ? top[0] : null, top, n, total: g.length, counts };
}
const amDoctor = () => state.myRole === 'doctor';
// bác sĩ: so độ của mình với kết quả sinh viên -> true (khớp) / false (không khớp) / null (chưa so được)
function stuMatch(i) {
  if (!amDoctor() || i.grade === null || i.grade === 5) return null;
  const r = studentRef([...(i.others || new Map())]);
  return r && r.grade !== null ? r.grade === i.grade : null;
}
// bảng kết quả lớn cho bác sĩ ngay sau khi bấm phân loại
function showDocResult(img) {
  const box = $('#docResult'), r = studentRef([...(img.others || new Map())]), g = img.grade;
  let cls = 'none', icon = '🎓', title, sub = '';
  if (!r) { title = 'Chưa có sinh viên phân loại ảnh này'; sub = `Bạn chọn độ ${g}`; }
  else if (g === 5) { title = 'Bạn chọn “Cân nhắc lựa chọn”'; sub = r.grade !== null ? `Sinh viên chọn độ ${r.grade} (${r.n}/${r.total} phiếu)` : `Sinh viên hoà giữa độ ${r.top.join(' và ')}`; }
  else if (r.grade === null) { cls = 'tie'; icon = '≈'; title = 'Chưa xác định'; sub = `Sinh viên hoà giữa độ ${r.top.join(' và ')} (mỗi độ ${r.n}/${r.total} phiếu) · bạn chọn độ ${g}`; }
  else if (r.grade === g) { cls = 'ok'; icon = '✓'; title = 'KHỚP'; sub = `Sinh viên chọn độ ${r.grade} – ${r.n}/${r.total} phiếu (${Math.round(r.n / r.total * 100)}%) · bạn chọn độ ${g}`; }
  else { cls = 'bad'; icon = '✗'; title = 'KHÔNG KHỚP'; sub = `Sinh viên chọn độ ${r.grade} – ${r.n}/${r.total} phiếu (${Math.round(r.n / r.total * 100)}%) · bạn chọn độ ${g}`; }
  const bars = r ? `<div class="dr-votes">${r.counts.map((c, k) => `<div class="dr-v ${k === g ? 'mine' : ''} ${r.grade === k ? 'top' : ''}"><span>Độ ${k}</span><div class="qbar"><i class="cg${k}" style="width:${r.total ? c / r.total * 100 : 0}%"></i></div><b>${c}</b></div>`).join('')}</div>` : '';
  box.className = 'doc-result ' + cls;
  box.innerHTML = `<div class="dr-card"><div class="dr-icon">${icon}</div><div class="dr-title">${title}</div><div class="dr-sub">${esc(sub)}</div>${bars}
    <div class="dr-act"><button class="btn outline" id="drClose">Xem lại ảnh</button><button class="btn primary" id="drNext">Ảnh tiếp theo →</button></div>
    <label class="dr-keep"><input type="checkbox" id="drKeep" ${docPopupOn() ? 'checked' : ''} /> Tiếp tục hiện thông báo này khi không khớp</label>
    <div class="dr-hint">Enter: ảnh tiếp theo · Esc: đóng</div></div>`;
  $('#drKeep').onchange = e => setDocPopup(e.target.checked);
  $('#drClose').onclick = hideDocResult;
  $('#drNext').onclick = () => { hideDocResult(); step(1); };
  setTimeout(() => $('#drNext')?.focus(), 0);
}
const docPopupOn = () => localStorage.getItem('pg-docpopup') !== '0';
function setDocPopup(on) {
  localStorage.setItem('pg-docpopup', on ? '1' : '0');
  $('#docPopup').checked = on;
  toast(on ? 'Sẽ hiện bảng thông báo khi không khớp sinh viên' : 'Đã tắt bảng thông báo – kết quả chỉ hiện dưới ảnh (bật lại ở công tắc dưới ảnh)');
}
$('#docPopup').onchange = e => setDocPopup(e.target.checked);
function hideDocResult() { $('#docResult').classList.add('hidden'); $('#docResult').innerHTML = ''; }
document.addEventListener('keydown', e => {
  if ($('#docResult').classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hideDocResult(); }
  else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); hideDocResult(); step(1); }
}, true);
function studentLine(img) {
  const r = studentRef([...(img.others || new Map())]);
  if (!r) return { cls: '', html: '<span class="dmsg">🎓 Chưa có sinh viên nào phân loại ảnh này</span>' };
  const dist = r.counts.map((c, g) => c ? `<span class="dchip">Độ ${g}: <b>${c}</b></span>` : '').join('');
  if (img.grade === 5) return { cls: '', html: `<span class="dmsg">🎓 Bạn chọn “Cân nhắc” · sinh viên đa số chọn ${r.grade !== null ? 'độ ' + r.grade : 'hoà'}</span>${dist}` };
  if (r.grade === null) return { cls: '', html: `<span class="dmsg">🎓 Sinh viên hoà giữa độ ${r.top.join(' và ')} (mỗi độ ${r.n}/${r.total} phiếu) – chưa xác định</span>${dist}` };
  const share = `${r.n}/${r.total} phiếu, ${Math.round(r.n / r.total * 100)}%`;
  return r.grade === img.grade
    ? { cls: 'agree', html: `<span class="dmsg ok">✓ Khớp – sinh viên chọn độ ${r.grade} (${share})</span>${dist}` }
    : { cls: 'miss', html: `<span class="dmsg bad">✗ Không khớp – sinh viên chọn độ ${r.grade} (${share}), bạn chọn độ ${img.grade}</span>${dist}` };
}
const nameOfUser = id => id === state.user?.id ? displayName(state.user.email) : (state.profiles.find(p => p.id === id)?.username || '?');
function renderScope() {
  const sel = $('#scopeSelect');
  const others = (state.profiles || []).filter(u => u.id !== state.user.id);
  sel.innerHTML = `<option value="all">Tất cả (của tôi + lô chung)</option><option value="me">Lô của tôi</option>` +
    others.map(u => `<option value="${u.id}">Lô của ${esc(u.username)}</option>`).join('');
  if (![...sel.options].some(o => o.value === state.scope)) state.scope = 'all';
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

function setView(v) {
  state.view = v;
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#summaryPanel').classList.toggle('hidden', v !== 'summary');
  $('#colorPanel').classList.toggle('hidden', v !== 'color');
  $('#trashPanel').classList.toggle('hidden', v !== 'trash');
  $('#trashBtn').classList.toggle('active', v === 'trash');
  if (v !== 'admin') closeAdmin();
  if (v === 'grade') {
    $('#workspace').classList.toggle('hidden', !state.batchId);
    renderBatches();
    if (!state.batchId && state.batches[0]) openBatch(state.batches[0].id);
  } else {
    $('#workspace').classList.add('hidden'); $('#emptyState').classList.add('hidden');
  }
  if (v === 'summary') refreshSummary();
  if (v === 'color') refreshColor();
  if (v === 'trash') refreshTrash();
}
document.querySelectorAll('.nav-tab').forEach(b => b.onclick = () => setView(b.dataset.view));
function closeAdmin() {
  state.adminOpen = false;
  $('#adminPanel').classList.add('hidden'); $('#adminBtn').classList.remove('active');
}
async function openAdmin() {
  state.view = 'admin';
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  $('#summaryPanel').classList.add('hidden'); $('#trashPanel').classList.add('hidden'); $('#colorPanel').classList.add('hidden');
  state.adminOpen = true;
  $('#adminBtn').classList.add('active');
  $('#workspace').classList.add('hidden'); $('#emptyState').classList.add('hidden');
  $('#adminPanel').classList.remove('hidden');
  state.batchId = null; renderBatches();
  await refreshAdmin();
}
$('#adminBtn').onclick = () => state.adminOpen ? setView('grade') : openAdmin();
$('#adminRefresh').onclick = () => refreshAdmin();
$('#adminExport').onclick = () => exportCsv(null);
$('#adminDashboard').href = 'https://supabase.com/dashboard/project/' + (cfg.SUPABASE_URL || '').replace(/^https:\/\/|\.supabase\.co.*$/g, '');

async function refreshAdmin() {
  renderBackupNote();
  try {
    const [ov] = await Promise.all([sb.rpc('admin_overview').then(check), loadUsers()]);
    const sPct = Math.min(100, ov.storage_bytes / FREE_STORAGE * 100), dPct = Math.min(100, ov.db_bytes / FREE_DB * 100);
    const card = (k, v, sub = '', pct = null) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>
      ${sub ? `<div class="k">${sub}</div>` : ''}${pct !== null ? `<div class="bar lg ${pct > 80 ? 'warn' : ''}"><i style="width:${pct}%"></i></div>` : ''}</div>`;
    $('#adminCards').innerHTML =
      card('Tài khoản', ov.users) + card('Lô ảnh', ov.batches) +
      card('Ảnh đã tải', ov.images, `${ov.graded} đã phân loại (${ov.images ? Math.round(ov.graded / ov.images * 100) : 0}%)`) +
      card('Dung lượng ảnh', fmtBytes(ov.storage_bytes), `${sPct.toFixed(1)}% của 1 GB miễn phí`, sPct) +
      card('Cơ sở dữ liệu', fmtBytes(ov.db_bytes), `${dPct.toFixed(1)}% của 500 MB miễn phí`, dPct) +
      card('Thùng rác', ov.trash ?? 0, 'lô + ảnh chờ xoá hẳn');
    renderUsers();
  } catch (e) { toast(e.message); }
}
function renderUsers() {
  const nDoc = state.users.filter(u => isDoctor(u.id)).length;
  $('#adminUserCount').textContent = `${state.users.length} tài khoản · ${nDoc} bác sĩ · ${state.users.length - nDoc} sinh viên`;
  $('#pendBadge').classList.add('hidden');
  $('#adminUsers').innerHTML = state.users.map(u => {
    const me = u.id === state.user.id;
    return `<tr data-id="${u.id}">
      <td><span class="uname">${esc(u.username)}</span>${u.is_admin ? '<span class="role">Quản trị</span>' : ''}${me ? '<span class="you">(bạn)</span>' : ''}</td>
      <td><select class="role-sel" data-role="1">${['student', 'doctor'].map(r => `<option value="${r}" ${roleOf(u.id) === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></td>
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
  $('#adminUsers').querySelectorAll('select[data-role]').forEach(sel => sel.onchange = async () => {
    const u = state.users.find(x => x.id === sel.closest('tr').dataset.id);
    try {
      check(await sb.rpc('admin_set_role', { target: u.id, new_role: sel.value }));
      toast(`${u.username} giờ là ${ROLE_LABEL[sel.value]}`);
      await loadProfiles(); renderUsers();
    } catch (e) { toast(e.message); sel.value = roleOf(u.id); }
  });
  $('#adminUsers').querySelectorAll('button[data-act]').forEach(b => b.onclick = () =>
    adminAction(b.dataset.act, state.users.find(u => u.id === b.closest('tr').dataset.id)));
}
async function adminAction(act, u) {
  try {
    if (act === 'view') return viewUserData(u.id);
    if (act === 'pass') {
      const p = prompt(`Nhập mật khẩu mới cho "${u.username}":`);
      if (p === null) return;
      if (passwordProblem(p, u.username)) return toast(passwordProblem(p, u.username));
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
const HEIC_EXT = /\.(heic|heif|hif)$/i;
const isImage = f => f.type.startsWith('image/') || RAW_EXT.test(f.name) || /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|hif)$/i.test(f.name);
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

// xoay ảnh theo hướng EXIF của file RAW (ở độ phân giải gốc)
function orientCanvas(bmp, o) {
  if (!o || o === 1) return bmp;
  const rot = o === 6 || o === 8, w = bmp.width, h = bmp.height;
  const c = document.createElement('canvas'); c.width = rot ? h : w; c.height = rot ? w : h;
  const ctx = c.getContext('2d');
  if (o === 3) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  else if (o === 6) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else if (o === 8) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(bmp, 0, 0);
  return c;
}

// cắt sát ống nghiệm (= gộp nắp + headspace + plasma + hồng cầu) và đổi toạ độ vùng theo ảnh đã cắt
async function cropToTube(img, regions, maxH) {
  const W = img.width, H = img.height;
  const [x1, y1, x2, y2] = bboxOf(regions.flatMap(r => r.pts));
  const pad = TUBE_PAD * (y2 - y1) * H;
  const cx1 = Math.max(0, Math.floor(x1 * W - pad)), cy1 = Math.max(0, Math.floor(y1 * H - pad));
  const cx2 = Math.min(W, Math.ceil(x2 * W + pad)), cy2 = Math.min(H, Math.ceil(y2 * H + pad));
  const cw = cx2 - cx1, ch = cy2 - cy1, k = Math.min(1, maxH / ch);
  const c = document.createElement('canvas'); c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, cx1, cy1, cw, ch, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', TUBE_QUALITY));
  const map = ([x, y]) => [Math.round((x * W - cx1) / cw * 1e5) / 1e5, Math.round((y * H - cy1) / ch * 1e5) / 1e5];
  const out = regions.map(r => ({ ...r, pts: r.pts.map(map), box: [...map([r.box[0], r.box[1]]), ...map([r.box[2], r.box[3]])] }));
  return { blob, regions: out };
}

// chuẩn bị ảnh trước khi tải:
//  - RAW (.cr2…) luôn đổi sang JPEG
//  - "Chỉ lưu phần ống nghiệm": AI khoanh vùng rồi chỉ giữ phần ống (tiết kiệm nhất)
//  - "Nén ảnh": thu nhỏ ảnh còn lại về tối đa 1600px
async function prepare(file) {
  const raw = RAW_EXT.test(file.name), compress = $('#compress').checked, crop = segOn() && $('#cropTube').checked;
  const heic = HEIC_EXT.test(file.name) || /^image\/hei[cf]/.test(file.type);
  const decodable = raw || heic || /^image\/(jpeg|png|webp|bmp)$/.test(file.type);
  if (!decodable || (!raw && !heic && !compress && !crop)) return { blob: file, ext: extOf(file), regions: null };
  let src, orientation = 1;
  if (raw) ({ bmp: src, orientation } = await decodeRaw(file));
  else src = await decodeImageFile(file);
  const img = orientCanvas(src, orientation);
  try {
    let regions = null;
    if (crop) {
      try { await ensureModel(); regions = await TubeSeg.run(img); } catch (e) { console.error('AI', e); regions = null; }
      if (regions?.length) {
        const r = await cropToTube(img, regions, compress ? TUBE_MAX_H : 2400);
        return { blob: r.blob, ext: 'jpg', regions: r.regions };
      }
    }
    // không tìm thấy ống (hoặc tắt cắt): lưu cả ảnh
    if (!raw && Math.max(img.width, img.height) <= MAX_SIDE && file.size < 600 * 1024) return { blob: file, ext: extOf(file), regions };
    const blob = await drawToJpeg(img, 1, compress ? MAX_SIDE : 4000, compress ? JPEG_QUALITY : 0.93);
    if (!raw && blob.size >= file.size) return { blob: file, ext: extOf(file), regions };
    return { blob, ext: 'jpg', regions };
  } finally { if (src.close) src.close(); }
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
  let batchId = uploadTarget, done = 0, failed = 0, saved = 0;
  try {
    if (!batchId) batchId = check(await sb.from('batches').insert({ name }).select('id').single()).id;
    if (segOn() && $('#cropTube').checked) {
      setP(0, 'Đang tải mô hình AI…');
      try { await ensureModel(); } catch (e) { toast('Không tải được AI – sẽ lưu cả ảnh'); }
    }
    setP(0, `Đang xử lý 0/${list.length} ảnh…`);
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
          const { blob, ext, regions } = await prepare(x.file);
          const path = `${uid}/${batchId}/${crypto.randomUUID()}.${ext}`;
          check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false }));
          rows.push({ batch_id: batchId, filename: x.file.name, rel_path: x.path, storage_path: path,
            ...(regions ? { regions, regions_source: 'ai', regions_at: new Date().toISOString() } : {}) });
          saved += blob.size;
          await flush(false);
        } catch (e) { failed++; console.error(x.path, e); }
        done++;
        setP(done, `Đang xử lý ${done}/${list.length} ảnh · ${fmtBytes(saved)}`);
      }
    };
    const hasRaw = list.some(x => RAW_EXT.test(x.file.name));
    await Promise.all(Array.from({ length: hasRaw ? 2 : PARALLEL }, worker));
    await flush(true);
    setP(list.length, failed ? `Xong – ${failed} ảnh lỗi` : 'Hoàn tất');
    toast((failed ? `Đã tải ${list.length - failed} ảnh, ${failed} ảnh lỗi` : `Đã tải lên ${list.length} ảnh`) + ` · dung lượng ${fmtBytes(saved)}`);
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
const TUBE_LAYER = { name: 'tube', label: 'Ống nghiệm', hex: '#16a34a' };
const regClass = r => REGION_CLASSES.find(c => c.name === r.name) || { label: r.name, hex: '#a855f7' };
const seg = { hidden: new Set(JSON.parse(localStorage.getItem('pg-seg-hidden') || '[]')), editing: false, drawing: null, sel: -1, busy: new Set(), drag: null, shownId: null };
const ORT_URL = 'vendor/ort.wasm.min.js?v=1.31.1';
const ORT_SRI = 'sha384-tNxIwEqSlcdvKtUte98AsccPbDKM958LBXB/+3BLS42TTihXHKTWgdqPqXI/lot8';
let ortLoading = null;
const loadOrt = () => window.ort ? Promise.resolve() : (ortLoading ||= new Promise((res, rej) => {
  const sc = document.createElement('script'); sc.src = ORT_URL; sc.integrity = ORT_SRI; sc.onload = res;
  sc.onerror = () => { ortLoading = null; rej(new Error('Không tải được thư viện AI')); };
  document.head.appendChild(sc);
}));
// ---------- đọc ảnh: JPG/PNG… bằng trình duyệt, HEIC/HEIF (iPhone) bằng libheif ----------
const HEIF_URL = 'vendor/libheif/libheif.js?v=1.23.5', HEIF_SRI = 'sha384-VEbrgTthZ3xiJrRrD1QszeA+mvSzQAazOjulZBOV9mXAH+SfRdtQWjzL6E0JYlmP';
let heifLib = null, heifLoading = null;
function loadHeif() {
  return heifLib ? Promise.resolve(heifLib) : (heifLoading ||= (async () => {
    await new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = HEIF_URL; sc.integrity = HEIF_SRI; sc.onload = res;
      sc.onerror = () => rej(new Error('Không tải được bộ đọc ảnh HEIC'));
      document.head.appendChild(sc);
    });
    const wasmBinary = await (await fetch('vendor/libheif/libheif.wasm?v=1.23.5')).arrayBuffer();
    let lib = window.libheif({ wasmBinary }); if (lib && lib.then) lib = await lib;
    return (heifLib = lib);
  })().catch(e => { heifLoading = null; throw e; }));
}
async function isHeif(file) {
  const b = new Uint8Array(await file.slice(4, 12).arrayBuffer());
  const s = String.fromCharCode(...b);
  return s.startsWith('ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(s.slice(4));
}
async function decodeHeif(file) {
  const lib = await loadHeif();
  const imgs = new lib.HeifDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  if (!imgs?.length) throw new Error('Tệp HEIC không có ảnh');
  const im = imgs[0], w = im.get_width(), h = im.get_height(), data = new ImageData(w, h);
  await new Promise((res, rej) => im.display(data, d => d ? res() : rej(new Error('Không giải mã được ảnh HEIC'))));
  imgs.forEach(x => x.free?.());
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(data, 0, 0);
  return createImageBitmap(c);
}
async function decodeImageFile(file) {
  if (HEIC_EXT.test(file.name) || await isHeif(file).catch(() => false)) {
    try { return await createImageBitmap(file); } catch { return decodeHeif(file); }   // ảnh iPhone (kể cả HEIC đặt đuôi .JPG)
  }
  try { return await createImageBitmap(file); } catch (e) {
    try {   // thử lại bằng thẻ <img>
      const url = URL.createObjectURL(file), img = new Image(); img.src = url;
      try { await img.decode(); return await createImageBitmap(img); } finally { URL.revokeObjectURL(url); }
    } catch { throw new Error('Không đọc được ảnh này (định dạng chưa hỗ trợ hoặc tệp bị hỏng)'); }
  }
}
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

const segOnBox = $('#segOn');
const segOn = () => segOnBox.checked;
segOnBox.checked = localStorage.getItem('pg-seg-on') !== '0';
function applySegOn() {
  const on = segOn();
  $('#viewerBox').classList.toggle('seg-off', !on);
  $('#cropOpt').classList.toggle('disabled', !on);
  $('#cropTube').disabled = !on;
  if (!on && seg.editing) setEditing(false);
  renderOverlay();
}
segOnBox.onchange = () => { localStorage.setItem('pg-seg-on', segOn() ? '1' : '0'); applySegOn(); if (segOn()) maybeAutoSeg(); };
const cropBox = $('#cropTube');
cropBox.checked = localStorage.getItem('pg-crop') !== '0';
cropBox.onchange = () => localStorage.setItem('pg-crop', cropBox.checked ? '1' : '0');
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
  if (img && segOn() && autoSegBox.checked && img.regions == null && !RAW_EXT.test(img.storage_path) && !seg.busy.has(img.id)) runCurrent(false);
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
  if (!segOn()) { svg.innerHTML = ''; applyZoom(); return; }
  if (!img || !W || !H || el.getAttribute('src') !== urlOf(img) || !el.complete) { svg.innerHTML = ''; applyZoom(); return; }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  applyZoom();
  const rect = svg.getBoundingClientRect();
  const upp = Math.max(W / (rect.width || W), H / (rect.height || H)); // đơn vị ảnh trên mỗi pixel màn hình
  const regs = img.regions || [];
  let html = '';
  const tubeRegs = regs.filter(r => r.pts?.length);
  if (tubeRegs.length && !seg.hidden.has('blackout')) {
    const poly = r => r.pts.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(' ');
    html += `<defs><mask id="tubeMask" maskUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}">
      <rect x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}" fill="#fff"/>
      ${tubeRegs.map(r => `<polygon class="m" points="${poly(r)}" style="fill:#000;fill-opacity:1;stroke:#000;stroke-opacity:1;stroke-width:${(3 * upp).toFixed(1)}px" stroke-linejoin="round"/>`).join('')}
    </mask></defs><rect class="blackout" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}" mask="url(#tubeMask)"/>`;
  }
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
  const shown = regs.filter(r => r.pts?.length);
  if (shown.length && !seg.hidden.has('tube')) {
    const [x1, y1, x2, y2] = bboxOf(shown.flatMap(r => r.pts)), m = 4 * upp;
    html += `<rect class="tube" x="${(x1 * W - m).toFixed(1)}" y="${(y1 * H - m).toFixed(1)}" width="${((x2 - x1) * W + 2 * m).toFixed(1)}" height="${((y2 - y1) * H + 2 * m).toFixed(1)}" rx="${(4 * upp).toFixed(1)}"/>`;
    html += `<text x="${(x1 * W - m).toFixed(1)}" y="${(y1 * H - m - 5 * upp).toFixed(1)}" font-size="${(12 * upp).toFixed(1)}" stroke-width="${(3 * upp).toFixed(1)}">Ống nghiệm</text>`;
  }
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
  if ((img?.regions || []).length) counts.tube = 1;
  if ((img?.regions || []).length) counts.blackout = '';
  $('#segLegend').innerHTML = [{ name: 'blackout', label: 'Nền đen', hex: '#000' }, TUBE_LAYER, ...REGION_CLASSES].map(c =>
    `<label class="layer-cb" title="Hiện/ẩn ${c.label}"><input type="checkbox" data-n="${c.name}" ${seg.hidden.has(c.name) ? '' : 'checked'} /><i style="background:${c.hex}"></i>${c.label}${counts[c.name] ? `<span class="c">${counts[c.name]}</span>` : ''}</label>`).join('');
  $('#segLegend').querySelectorAll('input[data-n]').forEach(b => b.onchange = () => {
    b.checked ? seg.hidden.delete(b.dataset.n) : seg.hidden.add(b.dataset.n);
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


// ----- phóng to / di chuyển ảnh -----
// mức phóng: 'fit' = vừa ống nghiệm, hoặc số lần so với cả ảnh vừa khung (mặc định 3×), tâm = tâm ống nghiệm (hoặc tâm ảnh)
seg.zoomMode = '1';   // luôn mở ở 1×; mức chọn chỉ giữ trong phiên
seg.pan = [0, 0];
let lastZoom = { f: 1 };
function zoomTarget() {
  const img = current(), el = $('#mainImg'), st = $('#stage');
  const W = el.naturalWidth, H = el.naturalHeight, sw = st.clientWidth, sh = st.clientHeight;
  if (!W || !H) return null;
  const k = Math.min(sw / W, sh / H), ox = (sw - W * k) / 2, oy = (sh - H * k) / 2;
  const regs = segOn() ? (img?.regions || []).filter(r => r.pts?.length) : [];
  let cx = sw / 2, cy = sh / 2, f, fitF = Infinity;
  if (regs.length) {
    let [x1, y1, x2, y2] = bboxOf(regs.flatMap(r => r.pts));
    x1 = ox + x1 * W * k; x2 = ox + x2 * W * k; y1 = oy + y1 * H * k; y2 = oy + y2 * H * k;
    cx = (x1 + x2) / 2; cy = (y1 + y2) / 2;
    const pad = 0.08 * Math.max(x2 - x1, y2 - y1);
    fitF = Math.max(1, Math.min(sw / (x2 - x1 + 2 * pad), sh / (y2 - y1 + 2 * pad), 12));
    if (seg.zoomMode === 'fit') f = fitF;
  }
  if (!f) {
    f = seg.zoomMode === 'fit' ? 1 : Number(seg.zoomMode) || 1;
    // các mức có sẵn (1×–4×) không phóng quá mức "vừa ống" để luôn thấy trọn ống; lăn chuột thì không giới hạn
    if (!seg.zoomFree) f = Math.min(f, fitF);
  }
  return { f, cx, cy, sw, sh };
}
function applyZoom() {
  const z = $('#zoomer'), t = zoomTarget();
  const hasRegs = segOn() && (current()?.regions || []).some(r => r.pts?.length);
  $('#zoomCtl').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.z === seg.zoomMode);
    if (b.dataset.z === 'fit') b.disabled = !hasRegs;
  });
  if (!t) { z.style.transform = ''; z.style.setProperty('--zf', 1); return; }
  const { f, cx, cy, sw, sh } = t;
  // giới hạn kéo để ảnh không trôi hẳn ra ngoài
  const lim = Math.max(sw, sh) * f / 2;
  seg.pan = seg.pan.map(v => Math.max(-lim, Math.min(lim, v)));
  z.style.transform = `translate(${sw / 2 - cx * f + seg.pan[0]}px, ${sh / 2 - cy * f + seg.pan[1]}px) scale(${f})`;
  z.style.setProperty('--zf', f);
  lastZoom = { f };
}
function setZoom(mode) {
  seg.zoomMode = String(mode); seg.pan = [0, 0]; seg.zoomFree = false;
  sessionStorage.setItem('pg-zoom', seg.zoomMode);
  applyZoom();
}
$('#zoomCtl').querySelectorAll('button').forEach(b => b.onclick = e => { e.stopPropagation(); setZoom(b.dataset.z); });
$('#zoomer').addEventListener('transitionend', () => renderOverlay());
window.addEventListener('resize', debounce(applyZoom, 100));

// kéo để di chuyển, lăn chuột để phóng
(() => {
  const st = $('#stage'); let drag = null;
  st.addEventListener('pointerdown', e => {
    if (seg.editing || e.button !== 0 || e.target.closest('.nav, .zoom-ctl, .counter, .doc-result')) return;
    drag = { x: e.clientX, y: e.clientY, pan: [...seg.pan], moved: false };
    st.setPointerCapture(e.pointerId);
  });
  st.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; st.classList.add('dragging');
    seg.pan = [drag.pan[0] + dx, drag.pan[1] + dy]; applyZoom();
  });
  const end = () => { if (!drag) return; if (drag.moved) renderOverlay(); drag = null; st.classList.remove('dragging'); };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  st.addEventListener('dblclick', e => { if (seg.editing || e.target.closest('.nav, .zoom-ctl, .doc-result')) return; seg.pan = [0, 0]; applyZoom(); });
  st.addEventListener('wheel', e => {
    if ((seg.editing && seg.drawing) || e.target.closest('.doc-result')) return;
    e.preventDefault();
    const levels = [1, 1.5, 2, 3, 4, 6, 8];
    const cur = lastZoom.f;
    let i = levels.findIndex(v => v >= cur - 0.01); if (i < 0) i = levels.length - 1;
    i = Math.max(0, Math.min(levels.length - 1, i + (e.deltaY < 0 ? 1 : -1)));
    seg.zoomMode = String(levels[i]); seg.zoomFree = true;
    seg.pan = seg.pan.map(v => v * levels[i] / (cur || 1));
    applyZoom(); setTimeout(renderOverlay, 260);
  }, { passive: false });
})();


// ---------- TỔNG KẾT: mọi người phân loại thế nào ----------
const refreshSummarySoon = debounce(() => refreshSummary(true), 800);
let sumData = null, sumShowAll = false;
async function refreshSummary(quiet) {
  const sel = $('#sumBatch');
  try {
    if (!quiet) $('#sumBody').classList.add('loading');
    const batches = await fetchAll(() => sb.from('batch_stats').select('id, name, owner, total, raters').order('id', { ascending: false }));
    const cur = sel.value;
    sel.innerHTML = `<option value="">Tất cả lô (${batches.length})</option>` + batches.map(b => `<option value="${b.id}">${esc(b.name)} · ${esc(b.owner || '')} · ${b.total} ảnh</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
    const bid = sel.value ? Number(sel.value) : null;
    const { images, ratings } = await loadRatingData(bid);
    sumData = computeSummary(images, ratings, new Map(batches.map(b => [b.id, b.name])));
    sumData.batchRows = bid ? null : computeBatchRows(images, ratings, batches);
    sumData.scope = bid ? batches.find(b => b.id === bid) : { count: batches.length };
    renderSummary();
  } catch (e) { toast(e.message); }
  $('#sumBody').classList.remove('loading');
}
$('#sumBatch').onchange = () => { sumShowAll = false; refreshSummary(); };
function showSummaryFor(batchId) {
  $('#sumBatch').value = batchId ? String(batchId) : '';
  sumShowAll = false; refreshSummary();
  $('#main').scrollTop = 0;
}
// thống kê gộp theo từng lô
function computeBatchRows(images, ratings, batches) {
  const byImg = new Map();
  ratings.forEach(r => { if (!byImg.has(r.image_id)) byImg.set(r.image_id, []); byImg.get(r.image_id).push(r); });
  const rows = new Map(batches.map(b => [b.id, { b, images: 0, graded: 0, raters: new Set(), dist: [0, 0, 0, 0, 0, 0], multi: 0, full: 0 }]));
  images.forEach(im => {
    const row = rows.get(im.batch_id); if (!row) return;
    row.images++;
    const rs = byImg.get(im.id) || [];
    if (rs.length) row.graded++;
    rs.forEach(r => { row.raters.add(r.user_id); row.dist[r.grade]++; });
    if (rs.length >= 2) { row.multi++; if (new Set(rs.map(r => r.grade)).size === 1) row.full++; }
  });
  return [...rows.values()];
}
$('#sumRefresh').onclick = () => refreshSummary();
$('#sumExport').onclick = () => exportCsv($('#sumBatch').value ? Number($('#sumBatch').value) : null);

function computeSummary(images, ratings, batchNames) {
  const byImg = new Map();
  ratings.forEach(r => { if (!byImg.has(r.image_id)) byImg.set(r.image_id, new Map()); byImg.get(r.image_id).set(r.user_id, r.grade); });
  const raters = [...new Set(ratings.map(r => r.user_id))].sort((a, b) => nameOfUser(a).localeCompare(nameOfUser(b)));
  const per = new Map(raters.map(u => [u, { u, n: 0, dist: [0, 0, 0, 0, 0, 0], sum: 0, cnt04: 0, agree: 0, agreeN: 0, doc: 0, docN: 0 }]));
  let stuDoc = 0, stuDocN = 0, consOk = 0, consN = 0;
  let multi = 0, full = 0, within1 = 0, within1N = 0, review = 0;
  const disagree = [];
  const pair = new Map(); const pk = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  images.forEach(im => {
    const m = byImg.get(im.id); if (!m) return;
    const entries = [...m.entries()], gs = entries.map(([, g]) => g);
    if (gs.includes(5)) review++;
    entries.forEach(([u, g]) => { const p = per.get(u); p.n++; p.dist[g]++; if (g <= 4) { p.sum += g; p.cnt04++; } });
    { const dref = doctorRef(entries), sref = studentRef(entries);
      if (dref !== null && sref && sref.grade !== null) { consN++; if (dref === sref.grade) consOk++; } }
    entries.forEach(([u, g]) => {
      const ref = doctorRef(entries, u); if (ref === null) return;
      const p = per.get(u); p.docN++; if (g === ref) p.doc++;
      if (!isDoctor(u)) { stuDocN++; if (g === ref) stuDoc++; }
    });
    if (gs.length < 2) return;
    multi++;
    const same = new Set(gs).size === 1; if (same) full++;
    const num = gs.filter(g => g <= 4);
    if (num.length >= 2) { within1N++; if (Math.max(...num) - Math.min(...num) <= 1) within1++; }
    const md = modeOf(gs);
    entries.forEach(([u, g]) => { const p = per.get(u); p.agreeN++; if (md.includes(g)) p.agree++; });
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const k = pk(entries[i][0], entries[j][0]); const v = pair.get(k) || { n: 0, same: 0 };
      v.n++; if (entries[i][1] === entries[j][1]) v.same++; pair.set(k, v);
    }
    if (!same) disagree.push({ im, entries, spread: num.length >= 2 ? Math.max(...num) - Math.min(...num) : 0, has5: gs.includes(5), batch: batchNames.get(im.batch_id) });
  });
  disagree.sort((a, b) => b.spread - a.spread || b.entries.length - a.entries.length);
  return { images, ratings, raters, per, pair, pk, multi, full, within1, within1N, review, disagree, stuDoc, stuDocN, consOk, consN,
    gradedImgs: byImg.size, total: images.length };
}

const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
function renderSummary() {
  const d = sumData; if (!d) return;
  const sc = d.scope || {};
  $('#sumScope').innerHTML = d.batchRows
    ? `<span class="scope-chip all">📊 Đang xem: <b>Tổng các lô</b> (${sc.count || 0} lô)</span>`
    : `<span class="scope-chip one">📁 Đang xem lô: <b>${esc(sc.name || '')}</b>${sc.owner ? ` · của ${esc(sc.owner)}` : ''}</span><button class="link" id="sumBackAll">← Xem tổng các lô</button>`;
  $('#sumBackAll')?.addEventListener('click', () => showSummaryFor(null));
  $('#sumBatchesPanel').classList.toggle('hidden', !d.batchRows);
  if (d.batchRows) {
    const rows = d.batchRows;
    const distBar = dist => { const n = dist.reduce((a, c) => a + c, 0); return n ? `<div class="stack">${dist.map((c, g) => c ? `<i class="cg${g}" style="flex:${c}" title="Độ ${g} (${GRADES[g].label}): ${c} lượt (${pct(c, n)})"></i>` : '').join('')}</div>` : '<span class="muted">–</span>'; };
    const tot = rows.reduce((t, r) => { t.images += r.images; t.graded += r.graded; r.raters.forEach(u => t.raters.add(u)); r.dist.forEach((c, g) => t.dist[g] += c); t.multi += r.multi; t.full += r.full; return t; },
      { images: 0, graded: 0, raters: new Set(), dist: [0, 0, 0, 0, 0, 0], multi: 0, full: 0 });
    $('#sumBatches').innerHTML = rows.length ? rows.map(r => `
      <tr class="brow" data-b="${r.b.id}" title="Xem thống kê riêng lô này">
        <td class="uname">${esc(r.b.name)}</td><td>${esc(r.b.owner || '')}</td>
        <td class="num">${r.images}</td>
        <td class="num">${r.graded}<small> (${pct(r.graded, r.images)})</small></td>
        <td class="num">${r.raters.size}</td>
        <td class="num">${r.multi ? pct(r.full, r.multi) : '–'}${r.multi ? `<small> (${r.multi})</small>` : ''}</td>
        <td class="distcell">${distBar(r.dist)}</td>
        <td class="num"><span class="link">Xem →</span></td></tr>`).join('') + `
      <tr class="btotal"><td class="uname">Tổng cộng</td><td></td><td class="num">${tot.images}</td>
        <td class="num">${tot.graded}<small> (${pct(tot.graded, tot.images)})</small></td><td class="num">${tot.raters.size}</td>
        <td class="num">${tot.multi ? pct(tot.full, tot.multi) : '–'}</td><td class="distcell">${distBar(tot.dist)}</td><td></td></tr>`
      : '<tr><td colspan="8" class="muted empty-row">Chưa có lô nào</td></tr>';
    $('#sumBatches').querySelectorAll('tr.brow').forEach(tr => tr.onclick = () => showSummaryFor(Number(tr.dataset.b)));
  }
  const tile = (k, v, sub = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="k">${sub}</div>` : ''}</div>`;
  $('#sumCards').innerHTML =
    tile('Ảnh đã có người phân loại', `${d.gradedImgs}<small>/${d.total}</small>`) +
    tile('Người phân loại', d.raters.length) +
    tile('Lượt phân loại', d.ratings.length) +
    tile('Ảnh có ≥ 2 người phân loại', d.multi) +
    tile('Đồng thuận hoàn toàn', pct(d.full, d.multi), d.multi ? `${d.full}/${d.multi} ảnh mọi người cùng độ` : 'cần ≥ 2 người phân loại cùng ảnh') +
    tile('Lệch tối đa 1 độ', pct(d.within1, d.within1N), d.within1N ? `${d.within1}/${d.within1N} ảnh (không tính độ 5)` : '') +
    tile('Ảnh có người chọn “Cân nhắc”', d.review) +
    tile('Kết quả sinh viên khớp bác sĩ', pct(d.consOk, d.consN), d.consN ? `${d.consOk}/${d.consN} ảnh (độ sinh viên chọn nhiều nhất = độ bác sĩ)` : 'cần ảnh có cả bác sĩ và sinh viên phân loại') +
    tile('Từng lượt sinh viên trùng bác sĩ', pct(d.stuDoc, d.stuDocN), d.stuDocN ? `${d.stuDoc}/${d.stuDocN} lượt có kết quả bác sĩ để đối chiếu` : 'chưa có ảnh nào bác sĩ đã phân loại');

  // theo từng người phân loại
  $('#sumRaterLegend').innerHTML = GRADES.map(g => `<span class="lg"><i class="cg${g.g}"></i>${g.g} ${g.label}</span>`).join('');
  $('#sumRaters').innerHTML = d.raters.length ? [...d.per.values()].sort((a, b) => isDoctor(b.u) - isDoctor(a.u) || b.n - a.n).map(p => {
    const bar = p.dist.map((c, g) => c ? `<i class="cg${g}" style="flex:${c}" title="${esc(nameOfUser(p.u))} · Độ ${g} (${GRADES[g].label}): ${c} ảnh (${pct(c, p.n)})"></i>` : '').join('');
    const counts = p.dist.map((c, g) => c ? `<span><i class="cg${g}"></i>${g}: <b>${c}</b></span>` : '').join('');
    return `<tr><td class="uname">${roleTag(p.u)} ${esc(nameOfUser(p.u))}${p.u === state.user.id ? ' <span class="you">(bạn)</span>' : ''}</td>
      <td class="num">${p.n}</td>
      <td class="distcell"><div class="stack">${bar}</div><div class="dnum">${counts}</div></td>
      <td class="num">${p.cnt04 ? (p.sum / p.cnt04).toFixed(2) : '–'}</td>
      <td class="num">${p.agreeN ? pct(p.agree, p.agreeN) : '–'}<small>${p.agreeN ? ` (${p.agreeN})` : ''}</small></td>
      <td class="num">${p.docN ? pct(p.doc, p.docN) : '–'}<small>${p.docN ? ` (${p.docN})` : ''}</small></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="muted empty-row">Chưa có ai phân loại trong phạm vi này</td></tr>';

  // đồng thuận từng cặp
  const R = d.raters;
  if (R.length < 2) $('#sumMatrix').innerHTML = '<p class="muted empty-row">Cần ít nhất 2 người cùng phân loại để so sánh.</p>';
  else $('#sumMatrix').innerHTML = `<table class="matrix"><thead><tr><th></th>${R.map(u => `<th>${esc(nameOfUser(u))}</th>`).join('')}</tr></thead><tbody>${
    R.map(a => `<tr><th>${esc(nameOfUser(a))}</th>${R.map(b => {
      if (a === b) return '<td class="self">—</td>';
      const v = d.pair.get(d.pk(a, b));
      if (!v) return '<td class="na" title="Chưa phân loại chung ảnh nào">·</td>';
      const r = v.same / v.n;
      return `<td style="--a:${(0.08 + r * 0.72).toFixed(2)}" class="${r >= 0.6 ? 'hi' : ''}" title="${esc(nameOfUser(a))} & ${esc(nameOfUser(b))}: cùng độ ${v.same}/${v.n} ảnh chung">${Math.round(r * 100)}%<small>${v.n}</small></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;

  // ảnh được phân loại khác nhau
  const list = sumShowAll ? d.disagree : d.disagree.slice(0, 30);
  $('#sumDisCount').textContent = d.disagree.length ? `${d.disagree.length} ảnh` : '';
  $('#sumDis').innerHTML = d.disagree.length ? list.map(x => `
    <div class="dis" data-b="${x.im.batch_id}" data-i="${x.im.id}">
      <div class="dthumb"><img loading="lazy" data-path="${esc(x.im.storage_path)}" alt=""></div>
      <div class="dinfo"><div class="dname">${esc(x.im.rel_path)}</div><div class="muted">${esc(x.batch || '')}</div>
        <div class="dgrades">${x.entries.map(([u, g]) => `<span class="gchip" data-g="${g}" title="${esc(nameOfUser(u))}: ${GRADES[g].label}">${esc(nameOfUser(u))} <b>${g}</b></span>`).join('')}</div></div>
      <div class="dspread"><b>${x.spread}</b><span>độ lệch</span></div>
      <button class="btn outline sm">Mở ảnh</button>
    </div>`).join('') + (d.disagree.length > list.length ? `<button class="btn outline sm more" id="sumMore">Xem thêm ${d.disagree.length - list.length} ảnh</button>` : '')
    : '<p class="muted empty-row">Không có ảnh nào được phân loại khác nhau 🎉</p>';
  $('#sumMore')?.addEventListener('click', () => { sumShowAll = true; renderSummary(); });
  $('#sumDis').querySelectorAll('.dis').forEach(el => el.onclick = () => openImageFromSummary(Number(el.dataset.b), Number(el.dataset.i)));
  const imgs = [...$('#sumDis').querySelectorAll('img[data-path]')];
  signUrls(imgs.map(i => ({ storage_path: i.dataset.path }))).then(() => imgs.forEach(i => { i.src = state.urls.get(i.dataset.path)?.url || ''; })).catch(() => {});
}
async function openImageFromSummary(batchId, imageId) {
  if (!state.batches.some(b => b.id === batchId)) { state.scope = 'all'; localStorage.setItem('pg-scope', 'all'); renderScope(); await loadBatches(); }
  await openBatch(batchId);
  state.filter = 'all'; renderAll(); select(imageId);
}


// ---------- GỘP LÔ ----------
function updateMergeBox() {
  const n = state.merge?.size || 0;
  $('#mergeCount').textContent = n < 2 ? `Đã chọn ${n} – tick chọn ít nhất 2 lô` : `Đã chọn ${n} lô · ${state.batches.filter(b => state.merge.has(b.id)).reduce((s, b) => s + b.total, 0)} ảnh`;
  $('#mergeGo').disabled = n < 2;
}
function toggleMergePick(id) {
  const b = state.batches.find(x => x.id === id);
  if (!b || !(b.user_id === state.user.id || state.isAdmin)) return toast('Chỉ gộp được lô của bạn');
  state.merge.has(id) ? state.merge.delete(id) : state.merge.add(id);
  if (!state.mergeNameEdited || !$('#mergeName').value.trim()) {
    const first = state.batches.filter(x => state.merge.has(x.id)).sort((a, c) => a.id - c.id)[0];
    if (first) $('#mergeName').value = first.name;
  }
  renderBatches(); updateMergeBox();
}
function setMerge(on) {
  state.merge = on ? new Set() : null;
  $('#mergeBox').classList.toggle('hidden', !on);
  $('#mergeBtn').textContent = on ? 'Đang gộp…' : 'Gộp lô';
  $('#mergeName').value = ''; state.mergeNameEdited = false;
  renderBatches(); if (on) updateMergeBox();
}
$('#mergeName').addEventListener('input', () => { state.mergeNameEdited = true; });
$('#mergeBtn').onclick = () => setMerge(!state.merge);
$('#mergeCancel').onclick = () => setMerge(false);
$('#mergeGo').onclick = async () => {
  const ids = [...state.merge].sort((a, b) => a - b);
  if (ids.length < 2) return;
  const target = ids[0], name = $('#mergeName').value.trim();
  const picked = state.batches.filter(b => state.merge.has(b.id));
  const total = picked.reduce((s, b) => s + b.total, 0);
  if (!confirm(`Gộp ${ids.length} lô (${total} ảnh) thành một lô "${name || picked.find(b => b.id === target)?.name}"?\n\n${picked.map(b => '• ' + b.name + ' (' + b.total + ' ảnh)').join('\n')}`)) return;
  $('#mergeGo').disabled = true;
  try {
    const moved = check(await sb.rpc('merge_batches', { target, sources: ids.slice(1), new_name: name || null }));
    toast(`Đã gộp ${ids.length} lô · chuyển ${moved} ảnh`);
    setMerge(false);
    await loadBatches();
    await openBatch(target);
  } catch (e) { toast(e.message); $('#mergeGo').disabled = false; }
};


// ---------- tự đăng xuất sau 30 phút không thao tác (khi không ghi nhớ đăng nhập) ----------
const IDLE_MS = 30 * 60 * 1000;
let idleTimer = null;
function startIdleTimer() {
  if (localStorage.getItem(REMEMBER_KEY) !== '0') return;
  const reset = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { toast('Đã tự đăng xuất vì không thao tác 30 phút'); sb.auth.signOut(); }, IDLE_MS); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, reset, { passive: true }));
  reset();
}


// ---------- THÙNG RÁC ----------
const TRASH_DAYS = 30;
const daysLeft = iso => Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - new Date(iso)) / 864e5));
// mục trong thùng rác mà tôi được quản lý (của tôi, hoặc tất cả nếu là quản trị viên)
async function loadTrash() {
  const mine = q => state.isAdmin ? q : q.eq('user_id', state.user.id);
  const batches = await fetchAll(() => mine(sb.from('batches').select('id, name, user_id, deleted_at').not('deleted_at', 'is', null)).order('deleted_at', { ascending: false }).order('id'));
  const trashedIds = new Set(batches.map(b => b.id));
  const images = (await fetchAll(() => mine(sb.from('images').select('id, batch_id, user_id, filename, rel_path, storage_path, deleted_at').not('deleted_at', 'is', null)).order('deleted_at', { ascending: false }).order('id')))
    .filter(i => !trashedIds.has(i.batch_id));
  // số ảnh trong từng lô bị xoá
  for (const b of batches) b.count = (await fetchAll(() => sb.from('images').select('id').eq('batch_id', b.id).order('id'))).length;
  const names = new Map((await fetchAll(() => sb.from('batches').select('id, name').order('id'))).map(b => [b.id, b.name]));
  images.forEach(i => { i.batch = names.get(i.batch_id) || ''; });
  return { batches, images };
}
async function updateTrashCount() {
  try {
    const t = await loadTrash();
    const n = t.batches.length + t.images.length;
    $('#trashCount').textContent = n ? n : '';
    return t;
  } catch (e) { console.error(e); }
}
// xoá hẳn: file trong kho ảnh + dòng dữ liệu
async function hardDeleteImages(imgs) {
  for (let k = 0; k < imgs.length; k += 100) {
    const part = imgs.slice(k, k + 100);
    check(await sb.from('images').delete().in('id', part.map(i => i.id)));
    await sb.storage.from(BUCKET).remove(part.map(i => i.storage_path));
  }
}
async function hardDeleteBatch(b) {
  const imgs = await fetchAll(() => sb.from('images').select('id, storage_path').eq('batch_id', b.id).order('id'));
  for (let k = 0; k < imgs.length; k += 100) await sb.storage.from(BUCKET).remove(imgs.slice(k, k + 100).map(i => i.storage_path));
  check(await sb.from('batches').delete().eq('id', b.id));
}
// tự xoá hẳn các mục quá 30 ngày
async function purgeTrash() {
  const t = await loadTrash();
  const old = x => daysLeft(x.deleted_at) <= 0;
  const imgs = t.images.filter(old), bs = t.batches.filter(old);
  if (imgs.length) await hardDeleteImages(imgs);
  for (const b of bs) await hardDeleteBatch(b);
  if (imgs.length || bs.length) console.info(`Đã xoá hẳn ${imgs.length} ảnh, ${bs.length} lô quá ${TRASH_DAYS} ngày`);
}
let trashData = null;
async function refreshTrash() {
  try { trashData = await updateTrashCount(); renderTrash(); } catch (e) { toast(e.message); }
}
function renderTrash() {
  const t = trashData || { batches: [], images: [] };
  const who = id => state.isAdmin && id !== state.user.id ? ` · của ${esc(nameOfUser(id))}` : '';
  const left = d => `<span class="tleft ${daysLeft(d) <= 3 ? 'soon' : ''}">còn ${daysLeft(d)} ngày</span>`;
  $('#trashInfo').textContent = `${t.batches.length} lô · ${t.images.length} ảnh · tự xoá hẳn sau ${TRASH_DAYS} ngày`;
  $('#trashBatches').innerHTML = t.batches.length ? t.batches.map(b => `
    <div class="trow" data-b="${b.id}"><div class="ticon">📁</div>
      <div class="tinfo"><b>${esc(b.name)}</b><span class="muted">${b.count} ảnh · xoá lúc ${new Date(b.deleted_at).toLocaleString('vi-VN')}${who(b.user_id)}</span></div>
      ${left(b.deleted_at)}
      <button class="btn outline sm" data-act="restore">↩ Khôi phục</button>
      <button class="btn danger-ghost sm" data-act="purge">Xoá vĩnh viễn</button></div>`).join('')
    : '<p class="muted empty-row">Không có lô nào trong thùng rác</p>';
  $('#trashImages').innerHTML = t.images.length ? t.images.map(i => `
    <div class="trow" data-i="${i.id}"><div class="tthumb"><img loading="lazy" data-path="${esc(i.storage_path)}" alt=""></div>
      <div class="tinfo"><b>${esc(i.rel_path)}</b><span class="muted">Lô: ${esc(i.batch)} · xoá lúc ${new Date(i.deleted_at).toLocaleString('vi-VN')}${who(i.user_id)}</span></div>
      ${left(i.deleted_at)}
      <button class="btn outline sm" data-act="restore">↩ Khôi phục</button>
      <button class="btn danger-ghost sm" data-act="purge">Xoá vĩnh viễn</button></div>`).join('')
    : '<p class="muted empty-row">Không có ảnh nào trong thùng rác</p>';
  const imgs = [...$('#trashImages').querySelectorAll('img[data-path]')];
  signUrls(imgs.map(i => ({ storage_path: i.dataset.path }))).then(() => imgs.forEach(i => { i.src = state.urls.get(i.dataset.path)?.url || ''; })).catch(() => {});
  $('#trashPanel').querySelectorAll('.trow button').forEach(btn => btn.onclick = () => trashAction(btn.dataset.act, btn.closest('.trow')));
}
async function trashAction(act, row) {
  const t = trashData;
  try {
    if (row.dataset.b) {
      const b = t.batches.find(x => x.id === Number(row.dataset.b));
      if (act === 'restore') { check(await sb.from('batches').update({ deleted_at: null }).eq('id', b.id)); toast(`Đã khôi phục lô "${b.name}"`); }
      else { if (!confirm(`Xoá VĨNH VIỄN lô "${b.name}" (${b.count} ảnh) cùng mọi điểm và vùng khoanh? Không thể hoàn tác.`)) return; await hardDeleteBatch(b); toast('Đã xoá vĩnh viễn'); }
    } else {
      const i = t.images.find(x => x.id === Number(row.dataset.i));
      if (act === 'restore') { check(await sb.from('images').update({ deleted_at: null }).eq('id', i.id)); toast('Đã khôi phục ảnh'); }
      else { if (!confirm(`Xoá VĨNH VIỄN ảnh "${i.rel_path}"? Không thể hoàn tác.`)) return; await hardDeleteImages([i]); toast('Đã xoá vĩnh viễn'); }
    }
  } catch (e) { return toast(e.message); }
  await refreshTrash(); loadBatches(); if (state.batchId) refreshImages();
}
$('#trashBtn').onclick = () => state.view === 'trash' ? setView('grade') : setView('trash');
$('#trashRestoreAll').onclick = async () => {
  const t = trashData; if (!t || !(t.batches.length + t.images.length)) return;
  if (!confirm(`Khôi phục toàn bộ ${t.batches.length} lô và ${t.images.length} ảnh?`)) return;
  try {
    for (const b of t.batches) check(await sb.from('batches').update({ deleted_at: null }).eq('id', b.id));
    for (let k = 0; k < t.images.length; k += 100) check(await sb.from('images').update({ deleted_at: null }).in('id', t.images.slice(k, k + 100).map(i => i.id)));
    toast('Đã khôi phục tất cả');
  } catch (e) { toast(e.message); }
  await refreshTrash(); loadBatches();
};
$('#trashEmpty').onclick = async () => {
  const t = trashData; if (!t || !(t.batches.length + t.images.length)) return;
  if (!confirm(`Xoá VĨNH VIỄN ${t.batches.length} lô và ${t.images.length} ảnh trong thùng rác? Không thể hoàn tác.`)) return;
  try { await hardDeleteImages(t.images); for (const b of t.batches) await hardDeleteBatch(b); toast('Đã dọn sạch thùng rác'); }
  catch (e) { toast(e.message); }
  await refreshTrash();
};


// ---------- SAO LƯU ----------
// ZIP tối giản (không nén – ảnh JPEG vốn đã nén), tên file UTF-8
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) { // files: [{ name, data: Uint8Array }]
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, x) => s + (x.byteLength ?? x.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120) || '_';

// ---------- XUẤT DỮ LIỆU HUẤN LUYỆN (YOLO-seg) ----------
async function exportTrainSet(manualOnly) {
  const prog = $('#uploadProgress'); prog.classList.remove('hidden');
  const setP = (pct, label) => { $('#uploadBar').style.width = pct + '%'; $('#uploadPct').textContent = Math.round(pct) + '%'; $('#uploadLabel').textContent = label; };
  try {
    setP(2, 'Đang đọc danh sách ảnh…');
    const names = REGION_CLASSES.map(c => c.name);   // cap, Headspace, plasma, bloodcell – đúng thứ tự data.yaml cũ
    let images = (await fetchAll(() => sb.from('images').select('id, batch_id, rel_path, storage_path, regions, regions_source').is('deleted_at', null).not('regions', 'is', null).order('id')))
      .filter(i => Array.isArray(i.regions) && i.regions.some(r => names.includes(r.name) && r.pts?.length >= 3) && !RAW_EXT.test(i.storage_path));
    if (manualOnly) images = images.filter(i => i.regions_source === 'manual');
    if (!images.length) throw new Error(manualOnly ? 'Chưa có ảnh nào được chỉnh tay vùng khoanh' : 'Chưa có ảnh nào có vùng khoanh');
    await signUrls(images);
    const enc = new TextEncoder(), files = [], rows = [['tep', 'tap', 'nguon_nhan', 'kieu_anh', 'lo', 'duong_dan_goc']];
    const bname = new Map((await fetchAll(() => sb.from('batches').select('id, name').order('id'))).map(b => [b.id, b.name]));
    let done = 0, failed = 0, next = 0, nTrain = 0, nVal = 0;
    const worker = async () => {
      while (next < images.length) {
        const im = images[next++];
        try {
          const res = await fetch(urlOf(im)); if (!res.ok) throw new Error(res.status);
          const buf = new Uint8Array(await res.arrayBuffer());
          const split = (hash32('split:' + im.id) % 100) < 15 ? 'val' : 'train';
          split === 'val' ? nVal++ : nTrain++;
          const ext = (im.storage_path.split('.').pop() || 'jpg').toLowerCase(), base = `web_${im.id}`;
          const lines = im.regions.filter(r => names.includes(r.name) && r.pts?.length >= 3)
            .map(r => [names.indexOf(r.name), ...r.pts.flat().map(v => Math.min(1, Math.max(0, v)).toFixed(5))].join(' '));
          files.push({ name: `images/${split}/${base}.${ext}`, data: buf });
          files.push({ name: `labels/${split}/${base}.txt`, data: enc.encode(lines.join('\n') + '\n') });
          const xs = im.regions.flatMap(r => r.pts.map(p => p[0])), wFrac = Math.max(...xs) - Math.min(...xs);
          rows.push([`${base}.${ext}`, split, im.regions_source === 'manual' ? 'chinh tay' : 'AI', wFrac > 0.45 ? 'cat sat ong' : 'ca khung hinh', bname.get(im.batch_id) || '', im.rel_path]);
        } catch (e) { failed++; console.error(im.rel_path, e); }
        done++; setP(5 + done / images.length * 90, `Đang tải ảnh ${done}/${images.length}`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    files.push({ name: 'data.yaml', data: enc.encode(`# Xuat tu Plasma Grader ${new Date().toLocaleString('vi-VN')}\npath: .\ntrain: images/train\nval: images/val\nnc: ${names.length}\nnames: [${names.map(n => `'${n}'`).join(', ')}]\n`) });
    files.push({ name: 'danh-sach.csv', data: enc.encode('\ufeff' + rows.map(r => r.map(v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n')) });
    files.push({ name: 'DOC-TOI.txt', data: enc.encode(`Du lieu huan luyen YOLO-seg tu Plasma Grader\r\n- ${nTrain} anh train, ${nVal} anh val (chia co dinh 85/15 theo id anh)\r\n- Lop: ${names.map((n, i) => i + '=' + n).join(', ')}\r\n- danh-sach.csv: nguon nhan (chinh tay / AI) va kieu anh (ca khung hinh / cat sat ong)\r\n- Giai nen vao D:\\BME4\\DatasetWeb roi chay: python train_yolo26_v3.py\r\n`) });
    setP(97, 'Đang đóng gói…');
    const zip = makeZip(files);
    downloadBlob(zip, `du-lieu-huan-luyen-${manualOnly ? 'chinh-tay' : 'tat-ca'}-${new Date().toISOString().slice(0, 10)}.zip`);
    setP(100, `Đã xuất ${images.length - failed} ảnh (${nTrain} train · ${nVal} val) · ${fmtBytes(zip.size)}`);
    if (failed) toast(`${failed} ảnh không tải được`);
  } catch (e) { toast(e.message); $('#uploadLabel').textContent = '⚠ ' + e.message; }
  setTimeout(() => prog.classList.add('hidden'), 4000);
}
$('#trainManual').onclick = () => exportTrainSet(true);
$('#trainAll').onclick = () => exportTrainSet(false);
async function runBackup(withImages) {
  const prog = $('#uploadProgress'); prog.classList.remove('hidden');
  const setP = (pct, label) => { $('#uploadBar').style.width = pct + '%'; $('#uploadPct').textContent = Math.round(pct) + '%'; $('#uploadLabel').textContent = label; };
  try {
    setP(2, 'Đang đọc dữ liệu…');
    const users = state.isAdmin ? await loadUsers().then(() => state.users) : state.profiles;
    const batches = await fetchAll(() => sb.from('batches').select('*').order('id'));
    const images = await fetchAll(() => sb.from('images').select('*').order('id'));
    const ratings = await fetchAll(() => sb.from('ratings').select('image_id, user_id, grade, note, graded_at, updated_at').order('image_id').order('user_id'));
    const nameOf = id => users.find(u => u.id === id)?.username || nameOfUser(id);
    const data = {
      app: 'Plasma Grader', version: 1, exported_at: new Date().toISOString(), exported_by: displayName(state.user.email),
      grades: GRADES, counts: { users: users.length, batches: batches.length, images: images.length, ratings: ratings.length },
      users: users.map(u => ({ id: u.id, username: u.username, approved: u.approved, is_admin: u.is_admin, created_at: u.created_at })),
      batches: batches.map(b => ({ ...b, owner: nameOf(b.user_id) })),
      images: images.map(i => ({ ...i, uploader: nameOf(i.user_id) })),
      ratings: ratings.map(r => ({ ...r, rater: nameOf(r.user_id) })),
    };
    const enc = new TextEncoder();
    const files = [
      { name: 'data.json', data: enc.encode(JSON.stringify(data, null, 1)) },
      { name: 'ket-qua.csv', data: enc.encode((await buildCsv(null)).text) },
      { name: 'DOC-TOI.txt', data: enc.encode(`Sao lưu Plasma Grader lúc ${new Date().toLocaleString('vi-VN')}\r\n` +
        `- data.json: toàn bộ tài khoản (không có mật khẩu), lô, ảnh (kể cả vùng khoanh, thùng rác), điểm của từng người.\r\n` +
        `- ket-qua.csv: bảng kết quả mở bằng Excel (mỗi người phân loại một cột).\r\n` +
        (withImages ? `- images/: ảnh đã lưu trên hệ thống, xếp theo lô (đường dẫn gốc giữ nguyên).\r\n` : '- (bản này không kèm ảnh)\r\n')) },
    ];
    if (withImages) {
      const bname = new Map(batches.map(b => [b.id, safeName(b.name) + (b.deleted_at ? ' (thung rac)' : '')]));
      const used = new Set(); let done = 0, bytes = 0, failed = 0;
      await signUrls(images);
      let next = 0;
      const worker = async () => {
        while (next < images.length) {
          const im = images[next++];
          try {
            const res = await fetch(urlOf(im)); if (!res.ok) throw new Error(res.status);
            const buf = new Uint8Array(await res.arrayBuffer()); bytes += buf.length;
            const ext = (im.storage_path.split('.').pop() || 'jpg').toLowerCase();
            let p = `images/${bname.get(im.batch_id) || 'lo-' + im.batch_id}/${im.rel_path.split('/').map(safeName).join('/')}`.replace(/\.[^./]+$/, '') + (im.deleted_at ? '.deleted' : '') + '.' + ext;
            while (used.has(p)) p = p.replace(/(\.[^.]+)$/, `_${im.id}$1`);
            used.add(p); files.push({ name: p, data: buf });
          } catch (e) { failed++; console.error(im.rel_path, e); }
          done++; setP(5 + done / images.length * 90, `Đang tải ảnh ${done}/${images.length} · ${fmtBytes(bytes)}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (failed) toast(`${failed} ảnh không tải được – xem chi tiết trong data.json`);
    }
    setP(97, 'Đang đóng gói…');
    const n = new Date(), pad = x => String(x).padStart(2, '0');
    const stamp = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}_${pad(n.getHours())}h${pad(n.getMinutes())}`;
    const zip = makeZip(files);
    downloadBlob(zip, `plasma-grader-sao-luu-${stamp}${withImages ? '-kem-anh' : ''}.zip`);
    setP(100, `Đã tạo bản sao lưu · ${fmtBytes(zip.size)}`);
    localStorage.setItem('pg-last-backup', new Date().toISOString());
    renderBackupNote();
  } catch (e) { toast(e.message); $('#uploadLabel').textContent = '⚠ ' + e.message; }
  setTimeout(() => prog.classList.add('hidden'), 3000);
}
function renderBackupNote() {
  const t = localStorage.getItem('pg-last-backup');
  const days = t ? Math.floor((Date.now() - new Date(t)) / 864e5) : null;
  $('#backupNote').innerHTML = t ? `Lần sao lưu gần nhất trên máy này: <b>${new Date(t).toLocaleString('vi-VN')}</b>${days >= 7 ? ' <span class="tleft soon">– đã quá 7 ngày, nên sao lưu lại</span>' : ''}` : '<span class="tleft soon">Chưa sao lưu lần nào trên máy này</span>';
}
$('#backupData').onclick = () => runBackup(false);
$('#backupFull').onclick = () => runBackup(true);

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


// ---------- PHÂN TÍCH MÀU (mô hình của D:\BME4\analyze_color.py + hồi quy logistic) ----------
let colSegLock = Promise.resolve();   // chạy AI khoanh vùng lần lượt
const colorCache = new Map();          // id:độ dài vùng -> đặc trưng
let colData = null, colRun = 0, colFilter = 'all', colFeat = 'b';
const COL_FEATS = [['b', 'b* (vàng)'], ['C', 'C (độ đậm màu)'], ['g_chrom', 'g_chrom'], ['a', 'a* (đỏ)'], ['L', 'L (sáng)'], ['S', 'S (bão hoà)'], ['pLoai', 'P(Loại)']];
const fmtN = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
function majorityGrade(rs) {
  const doc = doctorRef(rs.map(r => [r.user_id, r.grade]));
  if (doc !== null) return doc;   // có bác sĩ thì lấy kết quả bác sĩ làm đối chiếu
  const g = rs.map(r => r.grade).filter(x => x !== 5);
  if (!g.length) return null;
  const m = modeOf(g); return m.length === 1 ? m[0] : null;   // hoà thì không tính
}
let colMode = localStorage.getItem('pg-colmode') || 'batch';
async function analyzeRow(r) {
  try {
    if (RAW_EXT.test(r.im.storage_path)) r.feat = { error: 'Ảnh RAW chưa chuyển JPEG' };
    else {
      const res = await fetch(urlOf(r.im)); if (!res.ok) throw new Error('Không tải được ảnh');
      const bmp = await createImageBitmap(await res.blob());
      let regions = r.im.regions;
      if (!regions?.length) { await ensureModel(); const job = colSegLock.then(() => TubeSeg.run(bmp)); colSegLock = job.catch(() => {}); regions = await job; }   // ảnh chưa khoanh: AI khoanh tạm để lấy màu (không lưu)
      r.feat = regions?.length ? PlasmaColor.analyze(bmp, regions) : { error: 'AI không tìm thấy ống nghiệm' }; bmp.close();
      if (r.feat && !r.feat.error) r.feat.regions = regions;
    }
  } catch (e) { r.feat = { error: e.message }; }
  colorCache.set(r.key, r.feat); r.pred = PlasmaColor.predict(r.feat);
}
const rowKey = im => im.id + ':' + JSON.stringify(im.regions || '').length;
function setColMode(m) {
  colMode = m; localStorage.setItem('pg-colmode', m);
  $('#colMode').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.m === m));
  $('#colImage').classList.toggle('hidden', m !== 'one');
  $('#colOne').classList.toggle('hidden', m !== 'one');
  $('#colBatchView').classList.toggle('hidden', m === 'one');
  $('#colRefresh').textContent = m === 'one' ? '↻ Phân tích lại ảnh này' : '↻ Phân tích lại cả lô';
}
$('#colMode').querySelectorAll('button').forEach(b => b.onclick = () => { if (b.dataset.m !== colMode) { setColMode(b.dataset.m); refreshColor(); } });
async function refreshColor() {
  setColMode(colMode);
  const run = ++colRun, sel = $('#colBatch');
  try {
    const model = await PlasmaColor.loadModel();
    $('#colModelInfo').textContent = `Mô hình: hồi quy logistic trên màu plasma, học từ ${model.trained_on} ảnh CR2 của bạn · phân biệt Nhận (0–2) / Loại (3–4): AUC ${model.cv.auc} · độ ước tính đúng ${Math.round(model.cv.grade_acc * 100)}%, lệch ≤ 1 độ ${Math.round(model.cv.grade_within1 * 100)}%`;
    const batches = await fetchAll(() => sb.from('batch_stats').select('id, name, owner, total').order('id', { ascending: false }));
    const cur = sel.value;
    sel.innerHTML = `<option value="">Tất cả lô (${batches.length})</option>` + batches.map(b => `<option value="${b.id}">${esc(b.name)} · ${esc(b.owner || '')} · ${b.total} ảnh</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : (state.batchId && [...sel.options].some(o => o.value === String(state.batchId)) ? String(state.batchId) : '');
    const bid = sel.value ? Number(sel.value) : null;
    const { images, ratings } = await loadRatingData(bid);
    const bname = new Map(batches.map(b => [b.id, b.name]));
    const byImg = new Map();
    ratings.forEach(r => { if (!byImg.has(r.image_id)) byImg.set(r.image_id, []); byImg.get(r.image_id).push(r); });
    await signUrls(images.filter(i => !RAW_EXT.test(i.storage_path)));
    colData = images.map(im => ({ im, batch: bname.get(im.batch_id) || '', rs: byImg.get(im.id) || [], human: majorityGrade(byImg.get(im.id) || []), feat: null, pred: null, key: rowKey(im) }));
    if (colMode === 'one') return colOneRun(run);
    renderColor();
    // phân tích (4 ảnh cùng lúc), hiện dần kết quả
    const todo = colData.filter(r => { const k = r.key; if (colorCache.has(k)) { r.feat = colorCache.get(k); r.pred = PlasmaColor.predict(r.feat); return false; } return true; });
    let done = colData.length - todo.length;
    const prog = () => { $('#colProgress').classList.toggle('hidden', done >= colData.length); $('#colProgText').textContent = `Đang phân tích màu ${done}/${colData.length} ảnh…`; $('#colProgBar').style.width = (colData.length ? done / colData.length * 100 : 0) + '%'; };
    prog();
    const redraw = debounce(() => run === colRun && renderColor(), 300);
    let k = 0;
    const worker = async () => {
      while (k < todo.length && run === colRun) {
        const r = todo[k++];
        await analyzeRow(r);
        done++; prog(); redraw();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (run === colRun) { prog(); renderColor(); }
  } catch (e) { toast(e.message); }
}
function colStats(rows) {
  const ok = rows.filter(r => r.pred);
  const withH = ok.filter(r => r.human !== null);
  const loaiOk = withH.filter(r => r.pred.loai === (r.human >= 3)).length;
  const exact = withH.filter(r => r.pred.grade === r.human).length;
  const near = withH.filter(r => Math.abs(r.pred.grade - r.human) <= 1).length;
  return { ok, withH, loaiOk, exact, near, nLoai: ok.filter(r => r.pred.loai).length };
}
function renderColor() {
  if (!colData) return;
  const d = colData, st = colStats(d);
  const tile = (k, v, sub = '') => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="k">${sub}</div>` : ''}</div>`;
  const err = d.filter(r => r.feat?.error).length;
  $('#colCards').innerHTML =
    tile('Ảnh đã phân tích', `${st.ok.length}<small>/${d.length}</small>`, err ? `${err} ảnh không phân tích được` : '') +
    tile('Mô hình xếp Nhận (0–2)', st.ok.length - st.nLoai) +
    tile('Mô hình xếp Loại (3–4)', st.nLoai) +
    tile('Khớp Nhận/Loại với người', st.withH.length ? pct(st.loaiOk, st.withH.length) : '–', `${st.loaiOk}/${st.withH.length} ảnh có độ đa số`) +
    tile('Độ ước tính trùng đa số', st.withH.length ? pct(st.exact, st.withH.length) : '–', st.withH.length ? `lệch ≤ 1 độ: ${pct(st.near, st.withH.length)}` : 'chưa có ảnh được phân loại');
  // chọn chỉ số cho biểu đồ
  $('#colFeat').innerHTML = COL_FEATS.map(([k, l]) => `<button class="chip ${colFeat === k ? 'active' : ''}" data-k="${k}">${l}</button>`).join('');
  $('#colFeat').querySelectorAll('.chip').forEach(c => c.onclick = () => { colFeat = c.dataset.k; renderColor(); });
  renderColorChart(st.ok);
  // bảng
  const chips = [['all', 'Tất cả', d.length], ['loai', 'Mô hình xếp Loại', st.nLoai], ['diff', 'Khác người phân loại', st.withH.filter(r => r.pred.loai !== (r.human >= 3) || r.pred.grade !== r.human).length], ['err', 'Không phân tích được', err]];
  if (!chips.some(c => c[0] === colFilter && c[2])) colFilter = 'all';
  $('#colFilters').innerHTML = chips.filter(c => c[0] === 'all' || c[2]).map(([k, l, c]) => `<button class="chip ${colFilter === k ? 'active' : ''}" data-f="${k}">${l}<span class="c">${c}</span></button>`).join('');
  $('#colFilters').querySelectorAll('.chip').forEach(c => c.onclick = () => { colFilter = c.dataset.f; renderColor(); });
  let rows = d;
  if (colFilter === 'loai') rows = d.filter(r => r.pred?.loai);
  if (colFilter === 'diff') rows = d.filter(r => r.pred && r.human !== null && (r.pred.loai !== (r.human >= 3) || r.pred.grade !== r.human));
  if (colFilter === 'err') rows = d.filter(r => r.feat?.error);
  rows = [...rows].sort((a, b) => (b.pred?.pLoai ?? -1) - (a.pred?.pLoai ?? -1));
  const blind = isShuffled();
  $('#colRows').innerHTML = rows.length ? rows.slice(0, 500).map(r => {
    const f = r.feat, p = r.pred;
    const name = `<div class="cname"><img loading="lazy" src="${esc(urlOf(r.im))}" alt="" /><div><b>${blind ? 'Ảnh #' + r.im.id : esc(r.im.rel_path)}</b><div class="muted">${esc(r.batch)}</div></div></div>`;
    if (!f) return `<tr><td>${name}</td><td colspan="10" class="muted">Đang phân tích…</td><td></td></tr>`;
    if (f.error) return `<tr><td>${name}</td><td colspan="10" class="muted">${esc(f.error)}</td><td class="num"><span class="link" data-open="${r.im.batch_id}:${r.im.id}">Mở →</span></td></tr>`;
    const hum = r.human === null ? (r.rs.length ? '<span class="muted" title="Các lựa chọn hoà nhau hoặc chỉ có độ 5">hoà</span>' : '<span class="muted">–</span>') : `<span class="gpill" data-g="${r.human}">${r.human}</span><small> (${r.rs.length})</small>`;
    const agree = p && r.human !== null ? (p.loai === (r.human >= 3) ? (p.grade === r.human ? '<span class="ok" title="Trùng độ">✓</span>' : '<span class="ok half" title="Cùng Nhận/Loại, khác độ">≈</span>') : '<span class="bad" title="Khác Nhận/Loại">✗</span>') : '';
    return `<tr>
      <td>${name}</td>
      <td><span class="swatch" style="background:rgb(${Math.round(f.R)},${Math.round(f.G)},${Math.round(f.B)})"></span>${esc(f.color)}</td>
      <td class="num">${fmtN(f.L, 0)}</td><td class="num">${fmtN(f.a, 0)}</td><td class="num">${fmtN(f.b, 0)}</td><td class="num">${fmtN(f.C)}</td><td class="num">${fmtN(f.S, 0)}</td><td class="num">${fmtN(f.g_chrom, 3)}</td>
      <td class="num">${p ? fmtN(p.pLoai * 100, 0) + '%' : '–'}</td>
      <td>${p ? `<span class="verdict ${p.loai ? 'loai' : 'nhan'}">${p.loai ? 'Loại' : 'Nhận'}</span> <span class="gpill" data-g="${p.grade}" title="Độ ước tính (xác suất ${Math.round(p.gradeProb * 100)}%)">${p.grade}</span>` : '–'}</td>
      <td class="num">${hum} ${agree}</td>
      <td class="num"><span class="link" data-open="${r.im.batch_id}:${r.im.id}">Mở →</span></td></tr>`;
  }).join('') + (rows.length > 500 ? `<tr><td colspan="12" class="muted empty-row">Hiện 500/${rows.length} ảnh – xuất CSV để xem hết</td></tr>` : '')
    : '<tr><td colspan="12" class="muted empty-row">Không có ảnh</td></tr>';
  $('#colRows').querySelectorAll('[data-open]').forEach(a => a.onclick = () => { const [b, i] = a.dataset.open.split(':').map(Number); openImageFromSummary(b, i); });
}
// biểu đồ điểm: trục ngang = độ đa số người phân loại chọn, trục dọc = chỉ số màu
function renderColorChart(ok) {
  const box = $('#colChart');
  const val = r => colFeat === 'pLoai' ? r.pred.pLoai : r.feat[colFeat];
  const pts = ok.filter(r => Number.isFinite(val(r)));
  if (!pts.length) { box.innerHTML = '<div class="muted empty-row">Chưa có ảnh phân tích được</div>'; return; }
  const cols = [0, 1, 2, 3, 4, 'none'], colName = c => c === 'none' ? 'Chưa có độ' : 'Độ ' + c;
  const W = 760, H = 280, ml = 52, mr = 12, mt = 12, mb = 34, cw = (W - ml - mr) / cols.length;
  let lo = Math.min(...pts.map(val)), hi = Math.max(...pts.map(val));
  if (colFeat === 'pLoai') { lo = 0; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= colFeat === 'pLoai' ? 0 : pad; hi += colFeat === 'pLoai' ? 0 : pad;
  const y = v => mt + (H - mt - mb) * (1 - (v - lo) / (hi - lo));
  const dec = colFeat === 'g_chrom' ? 3 : colFeat === 'pLoai' ? 2 : 0;
  const ticks = Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * i / 4);
  let svg = ticks.map(t => `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${ml - 6}" y="${y(t) + 4}" class="ax" text-anchor="end">${colFeat === 'pLoai' ? Math.round(t * 100) + '%' : t.toFixed(dec)}</text>`).join('');
  if (colFeat === 'pLoai' && PlasmaColor.model) { const t = PlasmaColor.model.reject.threshold; svg += `<line x1="${ml}" x2="${W - mr}" y1="${y(t)}" y2="${y(t)}" class="thr"/><text x="${W - mr - 4}" y="${y(t) - 5}" class="ax" text-anchor="end">ngưỡng Loại ${Math.round(t * 100)}%</text>`; }
  cols.forEach((c, ci) => {
    const cx = ml + cw * (ci + 0.5);
    const g = pts.filter(r => (r.human ?? 'none') === c);
    svg += `<text x="${cx}" y="${H - 12}" class="ax" text-anchor="middle">${colName(c)} (${g.length})</text>`;
    g.forEach((r, j) => {
      const jit = ((r.im.id * 7919) % 100 / 100 - 0.5) * cw * 0.5;
      svg += `<circle cx="${cx + jit}" cy="${y(val(r))}" r="4.5" class="pt ${r.pred.loai ? 'loai' : 'nhan'}" data-open="${r.im.batch_id}:${r.im.id}"><title>${esc(isShuffled() ? 'Ảnh #' + r.im.id : r.im.rel_path)} – ${COL_FEATS.find(f => f[0] === colFeat)[1]}: ${colFeat === 'pLoai' ? Math.round(val(r) * 100) + '%' : val(r).toFixed(dec || 1)} · mô hình: ${r.pred.loai ? 'Loại' : 'Nhận'}, độ ${r.pred.grade}</title></circle>`;
    });
    if (g.length) { const m = g.map(val).sort((a, b) => a - b), med = m.length % 2 ? m[m.length >> 1] : (m[m.length / 2 - 1] + m[m.length / 2]) / 2; svg += `<line x1="${cx - cw * 0.32}" x2="${cx + cw * 0.32}" y1="${y(med)}" y2="${y(med)}" class="med"><title>Trung vị: ${colFeat === 'pLoai' ? Math.round(med * 100) + '%' : med.toFixed(dec || 1)}</title></line>`; }
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="strip">${svg}</svg>
    <div class="lgs"><span><i class="pt-l nhan"></i>Mô hình xếp Nhận</span><span><i class="pt-l loai"></i>Mô hình xếp Loại</span><span><i class="med-l"></i>Trung vị</span><span class="muted">Bấm vào điểm để mở ảnh</span></div>`;
  box.querySelectorAll('[data-open]').forEach(a => a.onclick = () => { const [b, i] = a.dataset.open.split(':').map(Number); openImageFromSummary(b, i); });
}
$('#colBatch').onchange = () => refreshColor();
$('#colRefresh').onclick = () => {
  if (colMode === 'one') { const id = Number($('#colImage').value); [...colorCache.keys()].filter(k => k.startsWith(id + ':')).forEach(k => colorCache.delete(k)); }
  else colorCache.clear();
  refreshColor();
};
$('#colImage').onchange = () => colOneRun(colRun);
// ---- chế độ 1 ảnh ----
function colOneRun(run) {
  const sel = $('#colImage'), blind = isShuffled();
  const list = blind ? [...colData].sort((a, b) => hash32(state.user.id + ':' + a.im.id) - hash32(state.user.id + ':' + b.im.id)) : colData;
  const cur = Number(sel.value);
  sel.innerHTML = list.length ? list.map((r, i) => `<option value="${r.im.id}">${blind ? `Ảnh ${i + 1}/${list.length}` : esc(r.im.rel_path)}${$('#colBatch').value ? '' : ' · ' + esc(r.batch)}</option>`).join('') : '<option value="">Không có ảnh</option>';
  const pick = [cur, state.currentId].find(id => list.some(r => r.im.id === id)) ?? list[0]?.im.id;
  if (pick) sel.value = String(pick);
  const r = colData.find(x => x.im.id === Number(sel.value));
  $('#colProgress').classList.add('hidden');
  if (!r) { $('#colOne').innerHTML = '<div class="muted empty-row">Lô này chưa có ảnh</div>'; return; }
  const label = blind ? `Ảnh ${list.indexOf(r) + 1}/${list.length}` : r.im.rel_path;
  const draw = () => { if (run === colRun) $('#colOne').innerHTML = `<div class="quick-list one">${colResultCard(r, label)}</div>`; $('#colOne').querySelector('[data-open]')?.addEventListener('click', () => openImageFromSummary(r.im.batch_id, r.im.id)); };
  if (colorCache.has(r.key)) { r.feat = colorCache.get(r.key); r.pred = PlasmaColor.predict(r.feat); draw(); return; }
  r.feat = null; draw();
  analyzeRow(r).then(draw);
}
// thẻ kết quả dùng chung cho "1 ảnh" và "Tải ảnh lên"
// regions: các vùng AI (toạ độ 0..1 theo ảnh url); detail: hiện bảng thông số đầy đủ; key: để bật/tắt chi tiết
function regionStats(regions) {
  const best = {};
  (regions || []).forEach(r => { if (r.pts?.length >= 3 && (!best[r.name] || (r.conf || 0) > (best[r.name].conf || 0))) best[r.name] = r; });
  const ys = r => r.pts.map(p => p[1]), all = Object.values(best);
  if (!all.length) return [];
  const top = Math.min(...all.flatMap(ys)), tot = (Math.max(...all.flatMap(ys)) - top) || 1;
  return REGION_CLASSES.map(c => { const r = best[c.name]; return { c, r, conf: r?.conf, frac: r ? (Math.max(...ys(r)) - Math.min(...ys(r))) / tot : null }; });
}
function regionOverlay(regions) {
  const st = regionStats(regions).filter(x => x.r);
  return st.map(({ c, r }) => `<polygon points="${r.pts.map(([x, y]) => `${x},${y}`).join(' ')}" style="stroke:${c.hex}" class="${c.name === 'plasma' ? 'pl' : ''}"><title>${c.label} ${Math.round((r.conf || 0) * 100)}%</title></polygon>`).join('');
}
function paramRows(feat, pred, regions) {
  const m = PlasmaColor.model, L = feat.L * 100 / 255, a = feat.a - 128, b = feat.b - 128, h = ((feat.h % 360) + 360) % 360;
  const sign = v => (v > 0 ? '+' : '') + v.toFixed(1);
  const st = regionStats(regions);
  const groups = [
    ['Kết quả mô hình', [
      ['Kết luận', pred.loai ? '<b class="tl">Loại</b> (độ 3–4)' : '<b class="tn">Nhận</b> (độ 0–2)'],
      ['Xác suất Loại', `${(pred.pLoai * 100).toFixed(1)}% <span class="muted">(ngưỡng ${Math.round(m.reject.threshold * 100)}%)</span>`],
      ['Độ ước tính', `${pred.grade} – ${GRADES.find(g => g.g === pred.grade)?.label || ''} <span class="muted">(${Math.round(pred.gradeProb * 100)}%)</span>`],
    ]],
    ['Màu huyết tương', [
      ['Tên màu', `<span class="swatch" style="background:rgb(${Math.round(feat.R)},${Math.round(feat.G)},${Math.round(feat.B)})"></span>${esc(feat.color)}`],
      ['L* (độ sáng)', L.toFixed(1)], ['a* (đỏ ↔ xanh lá)', sign(a)], ['b* (vàng ↔ xanh dương)', sign(b)],
      ['C (độ đậm màu)', feat.C.toFixed(1)], ['h (góc màu)', h.toFixed(1) + '°'],
      ['RGB', `${Math.round(feat.R)}, ${Math.round(feat.G)}, ${Math.round(feat.B)}`],
      ['S (độ bão hoà)', `${Math.round(feat.S)} <span class="muted">/255</span>`],
      ['r_chrom · g_chrom', `${feat.r_chrom.toFixed(3)} · ${feat.g_chrom.toFixed(3)}`],
    ]],
    ['Khoanh vùng AI', [
      ...st.map(x => [`<i class="rdot" style="background:${x.c.hex}"></i>${x.c.label}`, x.r ? `<span class="muted">tin cậy</span> ${Math.round((x.conf || 0) * 100)}% · <span class="muted">cao</span> ${Math.round(x.frac * 100)}%` : '<span class="muted">không thấy</span>']),
      ['Tỉ lệ plasma/(plasma+hồng cầu)', feat.ratio != null ? (feat.ratio * 100).toFixed(1) + '%' : '–'],
      ['Số điểm ảnh lấy màu', feat.n.toLocaleString('vi-VN')],
    ]],
  ];
  return groups.map(([t, rows]) => `<div class="pgroup"><div class="pg-t">${t}</div>${rows.map(([k, v]) => `<div class="prow"><span>${k}</span><b>${v}</b></div>`).join('')}</div>`).join('');
}
function paramText(name, feat, pred, regions) {
  const L = feat.L * 100 / 255, a = feat.a - 128, b = feat.b - 128;
  const st = regionStats(regions).map(x => `${x.c.label}: ${x.r ? Math.round((x.conf || 0) * 100) + '% tin cậy, ' + Math.round(x.frac * 100) + '% chiều cao' : 'không thấy'}`);
  return [`Ảnh: ${name}`, `Kết luận: ${pred.loai ? 'Loại (độ 3–4)' : 'Nhận (độ 0–2)'} · P(Loại) ${(pred.pLoai * 100).toFixed(1)}% · độ ước tính ${pred.grade}`,
    `Màu: ${feat.color} · L* ${L.toFixed(1)} · a* ${a.toFixed(1)} · b* ${b.toFixed(1)} · C ${feat.C.toFixed(1)} · RGB ${Math.round(feat.R)},${Math.round(feat.G)},${Math.round(feat.B)} · S ${Math.round(feat.S)} · g_chrom ${feat.g_chrom.toFixed(3)}`,
    `Khoanh vùng: ${st.join(' · ')}`, `Tỉ lệ plasma: ${feat.ratio != null ? (feat.ratio * 100).toFixed(1) + '%' : '–'} · số điểm ảnh: ${feat.n}`].join('\n');
}
const cardTexts = new Map();
function resultCardHtml({ name, sub = '', url, regions, feat, pred, error, step, extra = '', detail = false, key = '' }) {
  const head = `<div class="qimg">${url ? `<img src="${esc(url)}" alt="" />${regions?.length ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${regionOverlay(regions)}</svg>` : ''}` : '<div class="qwait">…</div>'}</div>`;
  const nm = `<div class="qname">${esc(name)}</div>${sub ? `<div class="muted qsub">${esc(sub)}</div>` : ''}`;
  if (error) return `<div class="qcard">${head}<div class="qbody">${nm}<div class="qerr">⚠ ${esc(error)}</div>${extra}</div></div>`;
  if (!pred) return `<div class="qcard">${head}<div class="qbody">${nm}<div class="muted">${esc(step || 'Đang phân tích…')}</div></div></div>`;
  const m = PlasmaColor.model;
  const bars = pred.probs.map((v, i) => `<div class="qp"><span>Độ ${m.grade.classes[i]}</span><div class="qbar"><i class="cg${m.grade.classes[i]}" style="width:${v * 100}%"></i></div><b>${Math.round(v * 100)}%</b></div>`).join('');
  const legend = regions?.length ? `<div class="rlegend">${regionStats(regions).filter(x => x.r).map(x => `<span><i class="rdot" style="background:${x.c.hex}"></i>${x.c.label}</span>`).join('')}</div>` : '';
  if (key) cardTexts.set(key, paramText(name, feat, pred, regions));
  const tools = key ? `<div class="qtools"><button class="link" data-detail="${esc(key)}">${detail ? 'Thu gọn ▴' : 'Xem khoanh vùng & thông số ▾'}</button>${detail ? `<button class="link" data-copy="${esc(key)}">📋 Sao chép thông số</button>` : ''}</div>` : '';
  return `<div class="qcard ${detail ? 'detail' : ''}"><div class="qleft">${head}${detail ? legend : ''}</div><div class="qbody">${nm}
    <div class="qverdict ${pred.loai ? 'loai' : 'nhan'}">${pred.loai ? 'LOẠI' : 'NHẬN'}<small>${pred.loai ? 'đục rõ / nặng (độ 3–4)' : 'trong / đục nhẹ–vừa (độ 0–2)'}</small></div>
    <div class="qline">Xác suất Loại <b>${Math.round(pred.pLoai * 100)}%</b> <span class="muted">(ngưỡng ${Math.round(m.reject.threshold * 100)}%)</span></div>
    <div class="qline">Độ ước tính <span class="gpill" data-g="${pred.grade}">${pred.grade}</span> <span class="muted">${GRADES.find(g => g.g === pred.grade)?.label || ''}</span></div>
    <div class="qprobs">${bars}</div>
    ${detail ? `<div class="pgrid">${paramRows(feat, pred, regions)}</div>` : `<div class="qline"><span class="swatch" style="background:rgb(${Math.round(feat.R)},${Math.round(feat.G)},${Math.round(feat.B)})"></span>${esc(feat.color)} <span class="muted">· a ${Math.round(feat.a)} · b ${Math.round(feat.b)} · C ${feat.C.toFixed(1)} · g_chrom ${feat.g_chrom.toFixed(3)}</span></div>`}
    ${extra}${tools}</div></div>`;
}
// nút "chi tiết" / "sao chép" trong các thẻ kết quả
const detailOpen = new Set(['one']);
document.addEventListener('click', async e => {
  const d = e.target.closest('[data-detail]'), c = e.target.closest('[data-copy]');
  if (d) { const k = d.dataset.detail; detailOpen.has(k) ? detailOpen.delete(k) : detailOpen.add(k); k === 'one' ? colOneRun(colRun) : quickRender(); }
  if (c) { try { await navigator.clipboard.writeText(cardTexts.get(c.dataset.copy) || ''); toast('Đã sao chép thông số'); } catch { prompt('Thông số:', cardTexts.get(c.dataset.copy) || ''); } }
});
const plasmaPoly = regions => { const pl = (regions || []).filter(x => x.name === 'plasma').sort((a, b) => (b.conf || 0) - (a.conf || 0))[0]; return pl ? pl.pts.map(([x, y]) => `${x},${y}`).join(' ') : ''; };
function colResultCard(r, label) {
  const hum = r.human === null
    ? (r.rs.length ? 'Người phân loại: chưa có độ đa số' : 'Chưa có ai phân loại ảnh này')
    : `Người phân loại (đa số, ${r.rs.length} người): <span class="gpill" data-g="${r.human}">${r.human}</span>${r.pred ? (r.pred.loai === (r.human >= 3) ? (r.pred.grade === r.human ? ' <span class="okc">✓ trùng</span>' : ' <span class="halfc">≈ cùng Nhận/Loại</span>') : ' <span class="badc">✗ khác Nhận/Loại</span>') : ''}`;
  return resultCardHtml({
    name: label, sub: r.batch, url: urlOf(r.im),
    regions: r.feat?.regions || r.im.regions, feat: r.feat, pred: r.pred, error: r.feat?.error, key: 'one', detail: detailOpen.has('one'),
    extra: `<div class="qline">${hum}</div><div><button class="link" data-open="1">Mở ảnh ở tab Phân loại →</button></div>`,
  });
}
$('#colExport').onclick = () => {
  if (!colData) return;
  const e = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Lo', 'Ten_Anh', 'Mau_Plasma', 'L', 'a', 'b', 'C', 'h', 'R', 'G', 'B', 'S', 'r_chrom', 'g_chrom', 'Ti_le_plasma', 'So_pixel', 'P_Loai', 'Mo_hinh', 'Do_uoc_tinh', 'Do_da_so_nguoi', 'So_nguoi_phan_loai', 'Loi'];
  const lines = [head.join(',')].concat(colData.map(r => {
    const f = r.feat || {}, p = r.pred;
    return [r.batch, r.im.rel_path, f.color, fmtN(f.L, 0), fmtN(f.a, 0), fmtN(f.b, 0), fmtN(f.C, 2), fmtN(f.h, 1), fmtN(f.R, 0), fmtN(f.G, 0), fmtN(f.B, 0), fmtN(f.S, 0), fmtN(f.r_chrom, 4), fmtN(f.g_chrom, 4), fmtN(f.ratio, 3), f.n,
      p ? p.pLoai.toFixed(3) : '', p ? (p.loai ? 'Loại' : 'Nhận') : '', p ? p.grade : '', r.human ?? '', r.rs.length, f.error || ''].map(v => e(v === '–' ? '' : v)).join(',');
  }));
  downloadBlob(new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `phan-tich-mau-${new Date().toISOString().slice(0, 10)}.csv`);
};


// ---------- PHÂN LOẠI NHANH: tải ảnh lên -> AI khoanh vùng -> mô hình màu -> kết quả (không lưu) ----------
const quickItems = []; let quickSeq = 0;
function quickRender() {
  $('#quickHead').classList.toggle('hidden', !quickItems.length);
  const done = quickItems.filter(q => q.res || q.error);
  const nL = done.filter(q => q.res?.pred?.loai).length;
  $('#quickCount').textContent = `${done.length}/${quickItems.length} ảnh · Nhận ${done.length - nL - done.filter(q => q.error).length} · Loại ${nL}`;
  quickItems.forEach((q, i) => { q.key ||= 'q' + (++quickSeq); });
  $('#quickList').innerHTML = quickItems.map(q => resultCardHtml({ name: q.name, url: q.url, regions: q.regions, feat: q.res?.feat, pred: q.res?.pred, error: q.error, step: q.step || 'Đang chờ…', key: q.key, detail: detailOpen.has(q.key) })).join('');
}
async function quickAdd(files) {
  files = [...files].filter(isImage);
  if (!files.length) return toast('Hãy chọn tệp ảnh');
  const items = files.map(f => ({ file: f, name: f.name }));
  quickItems.unshift(...items.reverse()); items.reverse();
  quickRender();
  try { await PlasmaColor.loadModel(); } catch (e) { items.forEach(q => q.error = e.message); return quickRender(); }
  for (const q of items) {
    try {
      q.step = 'Đang đọc ảnh…'; quickRender();
      let src, orientation = 1;
      if (RAW_EXT.test(q.file.name)) ({ bmp: src, orientation } = await decodeRaw(q.file));
      else src = await decodeImageFile(q.file);
      const img = orientCanvas(src, orientation);
      q.step = 'AI đang khoanh vùng ống nghiệm…'; quickRender();
      await ensureModel();
      const job = colSegLock.then(() => TubeSeg.run(img)); colSegLock = job.catch(() => {});
      const regions = await job;
      if (!regions?.some(r => r.name === 'plasma')) throw new Error('AI không tìm thấy phần huyết tương');
      const cut = await cropToTube(img, regions, 900);
      q.url = URL.createObjectURL(cut.blob); q.regions = cut.regions;
      const feat = PlasmaColor.analyze(img, regions);
      if (feat.error) throw new Error(feat.error);
      const pred = PlasmaColor.predict(feat);
      if (!pred) throw new Error('Không tính được chỉ số màu');
      q.res = { feat, pred };
      src.close?.();
    } catch (e) { q.error = e.message || String(e); }
    quickRender();
  }
}
$('#quickPick').onclick = e => { e.stopPropagation(); $('#quickInput').click(); };
$('#quickDrop').onclick = () => $('#quickInput').click();
$('#quickInput').onchange = e => { quickAdd(e.target.files); e.target.value = ''; };
['dragover', 'dragenter'].forEach(ev => $('#quickDrop').addEventListener(ev, e => { e.preventDefault(); $('#quickDrop').classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => $('#quickDrop').addEventListener(ev, e => { e.preventDefault(); $('#quickDrop').classList.remove('over'); }));
$('#quickDrop').addEventListener('drop', e => quickAdd(e.dataTransfer.files));
$('#quickClear').onclick = () => { quickItems.forEach(q => q.url && URL.revokeObjectURL(q.url)); quickItems.length = 0; quickRender(); };

// ===== Chụp bằng camera (Phân tích màu) =====
let camStream = null;
function camStop() { camStream?.getTracks().forEach(t => t.stop()); camStream = null; $('#camVideo').srcObject = null; $('#camBox').classList.add('hidden'); }
async function camStart(deviceId) {
  camStream?.getTracks().forEach(t => t.stop());
  const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
  Object.assign(video, { width: { ideal: 3840 }, height: { ideal: 2160 } });
  camStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  $('#camVideo').srcObject = camStream;
  $('#camBox').classList.remove('hidden');
  const cur = camStream.getVideoTracks()[0]?.getSettings().deviceId;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('#camSelect');
  sel.innerHTML = cams.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === cur ? ' selected' : ''}>${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('');
  sel.classList.toggle('hidden', cams.length < 2);
}
$('#camOpen').onclick = async e => {
  e.stopPropagation();
  if (!navigator.mediaDevices?.getUserMedia) return $('#camInput').click();   // trình duyệt cũ: dùng app camera của máy
  try { await camStart(); $('#camBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  catch (err) {
    if (err.name === 'NotAllowedError') toast('Bạn chưa cho phép web dùng camera');
    else if (err.name === 'NotFoundError') toast('Không tìm thấy camera trên máy');
    else toast('Không mở được camera: ' + (err.message || err.name));
    camStop();
  }
};
$('#camSelect').onchange = e => camStart(e.target.value).catch(err => toast('Không đổi được camera: ' + err.message));
$('#camClose').onclick = camStop;
$('#camShot').onclick = async () => {
  const v = $('#camVideo');
  if (!v.videoWidth) return toast('Camera chưa sẵn sàng');
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  const t = new Date(), p = n => String(n).padStart(2, '0');
  const name = `camera_${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.jpg`;
  quickAdd([new File([blob], name, { type: 'image/jpeg' })]);
};
$('#camInput').onchange = e => { quickAdd(e.target.files); e.target.value = ''; };
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { if (b.dataset.view !== 'color') camStop(); }));
