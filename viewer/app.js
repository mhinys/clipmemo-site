// 클립메모 웹 뷰어(F-23) — 읽기 전용. 브라우저 ↔ 구글 드라이브만 오간다.
// 앱과 같은 구글 클라우드 프로젝트의 웹 OAuth 클라이언트로 drive.file 권한을
// 받는다(같은 프로젝트의 클라이언트는 같은 앱이라 앱이 만든 파일을 읽을 수 있다).
// 메모는 메모리에만 두고 브라우저 저장소에 남기지 않는다.
'use strict';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const CLIENT_ID = (window.CLIPMEMO_CONFIG && window.CLIPMEMO_CONFIG.clientId) || '';

// 앱과 같은 메모 색(lib/app/theme/color_tokens.dart NoteColor) — [라이트, 다크].
const NOTE_COLORS = {
  'note.01': ['#F3F4F6', '#22262E'], 'note.02': ['#FFF2B8', '#4A4423'], 'note.03': ['#FFE0C2', '#4C3A28'],
  'note.04': ['#FBDDE2', '#4A2F35'], 'note.05': ['#EFE1FB', '#3B3048'], 'note.06': ['#DDE6FB', '#2B3448'],
  'note.07': ['#D6EEF7', '#25404A'], 'note.08': ['#D8EFE3', '#26413A'], 'note.09': ['#E3EAD6', '#363F2C'],
  'note.10': ['#EDE6DA', '#3D382F'], 'note.11': ['#E6E8EC', '#2E323A'], 'note.12': ['#FFD9D3', '#4C322D'],
};

const $ = (id) => document.getElementById(id);
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

const state = {
  token: null,
  tokenClient: null,
  notes: [],
  section: 'all',
  tag: null,
  query: '',
  selected: null,
  mediaUrls: new Map(), // driveFileId → blob URL
};

// ── 로그인 ────────────────────────────────────────────────────────────

function initAuth() {
  if (!CLIENT_ID) {
    $('signin').classList.add('hidden');
    $('notReady').classList.remove('hidden');
    return;
  }
  const tryInit = () => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) return setTimeout(tryInit, 100);
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (res) => {
        if (res.error) return toast('로그인하지 못했어요: ' + res.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(res, SCOPE)) {
          return toast('"Google Drive의 특정 파일" 권한을 체크해야 메모를 볼 수 있어요');
        }
        state.token = res.access_token;
        // 토큰은 약 1시간 — 만료 직전에 조용히 다시 받는다.
        setTimeout(() => state.tokenClient.requestAccessToken({ prompt: '' }), (Number(res.expires_in || 3600) - 120) * 1000);
        if (!state.notes.length) load();
      },
    });
  };
  tryInit();
}

function signIn() {
  if (!state.tokenClient) return toast('잠시 뒤 다시 눌러 주세요');
  state.tokenClient.requestAccessToken({ prompt: '' });
}

function signOut() {
  if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null;
  state.notes = [];
  for (const url of state.mediaUrls.values()) URL.revokeObjectURL(url);
  state.mediaUrls.clear();
  showSignedIn(false);
}

function showSignedIn(on) {
  $('welcome').classList.toggle('hidden', on);
  $('app').classList.toggle('hidden', !on);
  for (const id of ['search', 'reload', 'signout']) $(id).classList.toggle('hidden', !on);
}

// ── 드라이브 ──────────────────────────────────────────────────────────

async function api(path, params = {}, as = 'json') {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
  if (res.status === 401) {
    state.tokenClient.requestAccessToken({ prompt: '' });
    throw new Error('로그인이 만료되어 다시 확인하고 있어요');
  }
  if (!res.ok) throw new Error('드라이브 오류 ' + res.status);
  return as === 'blob' ? res.blob() : res.json();
}

async function findByRole(role, parent) {
  let q = `appProperties has { key='cm_role' and value='${role}' } and trashed=false`;
  if (parent) q += ` and '${parent}' in parents`;
  const r = await api('/files', { q, fields: 'files(id,name)', pageSize: '10', spaces: 'drive' });
  return r.files && r.files[0] ? r.files[0].id : null;
}

async function findFolder(name, parent) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parent) q += ` and '${parent}' in parents`;
  const r = await api('/files', { q, fields: 'files(id)', pageSize: '10', spaces: 'drive' });
  return r.files && r.files[0] ? r.files[0].id : null;
}

async function listChildren(folderId) {
  const out = [];
  let pageToken = '';
  do {
    const params = {
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,modifiedTime)',
      pageSize: '1000',
      spaces: 'drive',
    };
    if (pageToken) params.pageToken = pageToken;
    const r = await api('/files', params);
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function load() {
  showSignedIn(true);
  $('list').innerHTML = '<p class="empty">메모를 찾고 있어요…</p>';
  try {
    const root = (await findByRole('root')) || (await findFolder('클립메모'));
    if (!root) {
      $('list').innerHTML = '<p class="empty">이 계정의 드라이브에 클립메모 폴더가 없어요.<br>앱에서 로그인한 계정과 같은지 확인해 주세요.</p>';
      return;
    }
    const notesFolder = (await findByRole('notes', root)) || (await findFolder('notes', root));
    const files = notesFolder ? (await listChildren(notesFolder)).filter((f) => f.name.endsWith('.json')) : [];
    const notes = [];
    let done = 0;
    // 동시에 6개씩 받는다.
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          const n = await api('/files/' + f.id, { alt: 'media' });
          if (n && n.id && !n.deletedAt) notes.push(n);
        } catch (e) {
          // 한 장이 실패해도 나머지는 보여 준다.
        }
        done++;
        if (done % 10 === 0 || done === files.length) toast(`메모 불러오는 중 ${done}/${files.length}`, true);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, files.length || 1) }, worker));
    hideToast();
    state.notes = notes;
    render();
  } catch (e) {
    $('list').innerHTML = `<p class="empty">메모를 불러오지 못했어요.<br>${escapeHtml(String(e.message || e))}</p>`;
  }
}

async function mediaUrl(driveFileId) {
  if (!driveFileId) return null;
  if (state.mediaUrls.has(driveFileId)) return state.mediaUrls.get(driveFileId);
  const blob = await api('/files/' + driveFileId, { alt: 'media' }, 'blob');
  const url = URL.createObjectURL(blob);
  state.mediaUrls.set(driveFileId, url);
  return url;
}

// ── 메모 해석 ─────────────────────────────────────────────────────────

const INLINE_IMAGE = /^!\[[^\]\n]*\]\(media:([A-Za-z0-9_\-]+)(?:\s+"(\d{1,3})%")?\)[ \t]*$/;

const isLocked = (n) => n.locked === true;
const isDiary = (n) => n.diary === true;
const tagsOf = (n) => (Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string') : []);
const checklistOf = (n) => (Array.isArray(n.checklist) ? n.checklist : []);
const mediaOf = (n) => (Array.isArray(n.media) ? n.media : []);
const hasOpenAlarm = (n) => Array.isArray(n.alarms) && n.alarms.some((a) => a && !a.completed);
const isTodo = (n) => hasOpenAlarm(n) || checklistOf(n).some((c) => c && !c.done);
const updated = (n) => Date.parse(n.updatedAt || n.createdAt || 0) || 0;

function plainBody(n) {
  if (isLocked(n)) return '';
  return String(n.body || '')
    .split('\n')
    .filter((l) => !INLINE_IMAGE.test(l.trimEnd()))
    .join('\n');
}

function preview(n) {
  if (isLocked(n)) return isDiary(n) ? '🔒 잠긴 일기' : '🔒 잠긴 메모';
  const text = plainBody(n).replace(/[#>*_`~\-\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) return text;
  const items = checklistOf(n).map((c) => (c.done ? '☑ ' : '☐ ') + c.text);
  return items.join(' · ');
}

function noteColors(n) {
  const isDark = dark();
  const preset = NOTE_COLORS[n.color];
  let bg = preset ? preset[isDark ? 1 : 0] : null;
  if (!bg) {
    const hex = /^#?([0-9a-fA-F]{6})$/.exec(String(n.color || '').trim());
    bg = hex ? '#' + hex[1] : NOTE_COLORS['note.01'][isDark ? 1 : 0];
    if (hex && isDark) bg = darkCustom(bg);
  }
  return { bg, ink: inkOn(bg) };
}

// 앱과 같은 커스텀 색 다크 매핑 — 명도 22%, 채도 -18%p(최대 45%).
function darkCustom(hex) {
  const [h, s] = rgbToHsl(hex);
  return hslToHex(h, Math.min(Math.max(s - 0.18, 0), 0.45), 0.22);
}

function inkOn(hex) {
  const lum = relLum(hex);
  const onDark = (lum + 0.05) / (relLum('#171A1F') + 0.05);
  const onLight = (relLum('#F2F4F7') + 0.05) / (lum + 0.05);
  return onDark >= onLight ? '#171A1F' : '#F2F4F7';
}

function relLum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function rgbToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

// ── 목록 ──────────────────────────────────────────────────────────────

const SECTIONS = [
  ['all', '모든 메모', (n) => !n.archived],
  ['todo', '할 일', isTodo],
  ['pinned', '고정됨', (n) => n.pinned === true],
  ['archived', '보관함', (n) => n.archived === true],
  ['locked', '잠긴 메모', (n) => isLocked(n) && !isDiary(n)],
  ['diary', '일기', isDiary],
];

function inSection(n) {
  if (state.tag) return tagsOf(n).some((t) => t.toLowerCase() === state.tag.toLowerCase());
  return SECTIONS.find((s) => s[0] === state.section)[2](n);
}

function matches(n, q) {
  if (!q) return true;
  const hay = [n.title || '', plainBody(n), ...checklistOf(n).map((c) => c.text || ''), ...tagsOf(n)]
    .join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function visibleNotes() {
  return state.notes
    .filter((n) => inSection(n) && matches(n, state.query))
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || updated(b) - updated(a));
}

function render() {
  renderNav();
  renderList();
  renderDetail();
}

function renderNav() {
  const nav = $('nav');
  nav.innerHTML = '';
  for (const [id, label, test] of SECTIONS) {
    const count = state.notes.filter(test).length;
    if ((id === 'locked' || id === 'diary') && count === 0) continue;
    nav.append(navButton(label, count, !state.tag && state.section === id, () => {
      state.section = id;
      state.tag = null;
      render();
    }));
  }
  const tagCounts = new Map();
  for (const n of state.notes) for (const t of tagsOf(n)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  if (tagCounts.size) {
    const h = document.createElement('h3');
    h.textContent = '태그';
    nav.append(h);
    for (const [t, c] of [...tagCounts].sort((a, b) => b[1] - a[1])) {
      nav.append(navButton('#' + t, c, state.tag === t, () => {
        state.tag = t;
        render();
      }));
    }
  }
}

function navButton(label, count, on, onClick) {
  const b = document.createElement('button');
  b.className = 'sec' + (on ? ' on' : '');
  b.innerHTML = `<span>${escapeHtml(label)}</span><span>${count}</span>`;
  b.onclick = onClick;
  return b;
}

function renderList() {
  const list = $('list');
  const notes = visibleNotes();
  list.innerHTML = '';
  if (!notes.length) {
    list.innerHTML = `<p class="empty">${state.query ? '검색 결과가 없어요' : '메모가 없어요'}</p>`;
    return;
  }
  for (const n of notes) {
    const { bg, ink } = noteColors(n);
    const b = document.createElement('button');
    b.className = 'card' + (state.selected === n.id ? ' on' : '');
    b.style.setProperty('--card-bg', bg);
    b.style.setProperty('--card-ink', ink);
    const meta = [];
    if (n.pinned) meta.push('📌');
    if (hasOpenAlarm(n)) meta.push('🔔');
    if (mediaOf(n).length) meta.push('🖼 ' + mediaOf(n).length);
    meta.push(new Date(updated(n)).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }));
    b.innerHTML = `<b>${escapeHtml(n.title || '제목 없음')}</b><p>${escapeHtml(preview(n))}</p>`
      + `<div class="meta">${meta.map(escapeHtml).join('<span>·</span>')}</div>`;
    b.onclick = () => {
      state.selected = n.id;
      document.body.classList.add('reading');
      renderList();
      renderDetail();
      $('detail').scrollTop = 0;
      window.scrollTo(0, 0);
    };
    list.append(b);
  }
}

// ── 메모 보기 ─────────────────────────────────────────────────────────

function renderDetail() {
  const box = $('detailBody');
  const n = state.notes.find((x) => x.id === state.selected);
  if (!n) {
    box.innerHTML = '<p class="empty">메모를 고르세요</p>';
    return;
  }
  const { bg, ink } = noteColors(n);
  const article = document.createElement('article');
  article.style.setProperty('--note-bg', bg);
  article.style.setProperty('--note-ink', ink);
  if (n.titleColor && /^#[0-9a-fA-F]{6}$/.test(n.titleColor) && contrast(n.titleColor, bg) >= 3) {
    article.style.setProperty('--title-ink', n.titleColor);
  }
  const meta = [`${new Date(updated(n)).toLocaleString('ko-KR')} 수정`];
  const next = nextAlarm(n);
  if (next) meta.unshift('🔔 ' + next.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  if (isDiary(n)) meta.unshift('📖 일기');
  let html = `<h1 class="title">${escapeHtml(n.title || '제목 없음')}</h1>`
    + `<div class="meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}`
    + tagsOf(n).map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('') + '</div>';

  if (isLocked(n)) {
    html += `<div class="locked"><div>🔒</div><p>${isDiary(n) ? '잠긴 일기' : '잠긴 메모'}예요.<br>`
      + '비밀번호로 암호화되어 있어 웹에서는 열 수 없어요. 클립메모 앱에서 열어 주세요.</p></div>';
    article.innerHTML = html;
    box.replaceChildren(article);
    return;
  }

  html += `<div class="body">${renderBody(n)}</div>`;
  const checklist = checklistOf(n);
  if (checklist.length) {
    html += '<ul class="checklist">' + checklist.map((c) =>
      `<li class="${c.done ? 'done' : ''}"><span>${c.done ? '☑' : '☐'}</span><span>${escapeHtml(c.text || '')}</span></li>`).join('') + '</ul>';
  }
  const inline = new Set(inlineIds(n));
  const strip = mediaOf(n).filter((m) => !inline.has(m.id) && m.driveFileId);
  if (strip.length) {
    html += '<div class="photos">' + strip.map((m) => `<img data-file="${escapeHtml(m.driveFileId)}" alt="사진" class="ph">`).join('') + '</div>';
  }
  const files = Array.isArray(n.attachments) ? n.attachments.filter((a) => a && a.driveFileId) : [];
  if (files.length) {
    html += '<div class="files">' + files.map((a) =>
      `<button data-download="${escapeHtml(a.driveFileId)}" data-name="${escapeHtml(a.name || '파일')}">📎 ${escapeHtml(a.name || '파일')}`
      + ` <small>${formatSize(a.size)}</small></button>`).join('') + '</div>';
  }
  article.innerHTML = html;
  box.replaceChildren(article);

  // 사진은 보일 때 받아 온다.
  const byId = new Map(mediaOf(n).map((m) => [m.id, m]));
  for (const img of article.querySelectorAll('img[data-media]')) {
    const m = byId.get(img.dataset.media);
    if (m && m.driveFileId) img.dataset.file = m.driveFileId;
  }
  for (const img of article.querySelectorAll('img[data-file]')) {
    mediaUrl(img.dataset.file).then((url) => {
      img.src = url;
      img.classList.remove('ph');
    }).catch(() => { img.alt = '사진을 불러오지 못했어요'; });
    img.onclick = () => zoom(img.src);
  }
  for (const btn of article.querySelectorAll('button[data-download]')) {
    btn.onclick = () => download(btn.dataset.download, btn.dataset.name);
  }
}

function inlineIds(n) {
  const ids = [];
  for (const line of String(n.body || '').split('\n')) {
    const m = INLINE_IMAGE.exec(line.trimEnd());
    if (m) ids.push(m[1]);
  }
  return ids;
}

// 마크다운 → 안전한 HTML. 본문 사이 사진 줄은 자리만 만들어 두고 나중에 채운다.
function renderBody(n) {
  const src = String(n.body || '').split('\n').map((line) => {
    const m = INLINE_IMAGE.exec(line.trimEnd());
    if (!m) return line;
    const width = Math.min(Math.max(parseInt(m[2] || '75', 10), 10), 100);
    return `\n<img data-media="${m[1]}" class="ph" alt="사진" style="width:${width}%">\n`;
  }).join('\n');
  const html = window.marked ? marked.parse(src, { breaks: true, gfm: true }) : escapeHtml(src).replace(/\n/g, '<br>');
  return window.DOMPurify
    ? DOMPurify.sanitize(html, { ADD_ATTR: ['data-media', 'target'], FORBID_TAGS: ['style', 'form', 'input'] })
    : escapeHtml(src);
}

function nextAlarm(n) {
  if (!Array.isArray(n.alarms)) return null;
  const times = n.alarms.filter((a) => a && !a.completed && a.triggerAt).map((a) => new Date(a.triggerAt))
    .filter((d) => !isNaN(d)).sort((a, b) => a - b);
  return times[0] || null;
}

function contrast(a, b) {
  const [x, y] = [relLum(a), relLum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function download(fileId, name) {
  try {
    toast('받는 중…', true);
    const blob = await api('/files/' + fileId, { alt: 'media' }, 'blob');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    hideToast();
  } catch (e) {
    toast('파일을 받지 못했어요');
  }
}

function zoom(src) {
  if (!src) return;
  $('zoom').querySelector('img').src = src;
  $('zoom').classList.remove('hidden');
}

// ── 공용 ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + 'KB';
  return (b / (1024 * 1024)).toFixed(1) + 'MB';
}

let toastTimer = null;
function toast(text, sticky) {
  const el = $('status');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() { $('status').classList.add('hidden'); }

// ── 시작 ──────────────────────────────────────────────────────────────

$('signin').onclick = signIn;
$('signout').onclick = signOut;
$('reload').onclick = () => { state.notes = []; load(); };
$('back').onclick = () => { document.body.classList.remove('reading'); };
$('zoom').onclick = () => $('zoom').classList.add('hidden');
let searchTimer = null;
$('search').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    document.body.classList.remove('reading');
    renderList();
  }, 150);
};
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.notes.length && render());
// 메모 속 링크는 새 탭으로(뷰어를 떠나지 않게).
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
initAuth();
