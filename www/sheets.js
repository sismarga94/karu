/**
 * sheets.js — Google Sheets catalog sync
 *
 * Expected CSV columns (case-insensitive):
 *   Name | Origin | Process | Roast Level | Tasting Notes | Price
 *
 * Data is cached in localStorage under key "catalogCache" so the
 * catalog renders even when offline.
 */

const SHEETS_URL_KEY   = 'sheetsUrl';
const CATALOG_CACHE_KEY = 'catalogCache';

// ─── CSV parser ──────────────────────────────────────────────────────────────
/**
 * Very small CSV parser that handles quoted fields with embedded commas/newlines.
 */
function parseCSV(text) {
  const rows = [];
  let field = '';
  let row   = [];
  let inQ   = false;
  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];
    if (inQ) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"')            { inQ = false; }
      else                            { field += ch; }
    } else {
      if      (ch === '"')  { inQ = true; }
      else if (ch === ',')  { row.push(field.trim()); field = ''; }
      else if (ch === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else                  { field += ch; }
    }
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1)
    .filter(r => r.some(c => c.trim()))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] || ''; });
      return obj;
    });
}

// ─── Catalog renderer ────────────────────────────────────────────────────────
function roastBadgeColor(level = '') {
  const l = level.toLowerCase();
  if (l.includes('light'))  return '#d4a853';
  if (l.includes('medium')) return '#a0522d';
  if (l.includes('dark'))   return '#3b1f0a';
  return '#7a6655';
}

function renderCatalog(beans) {
  const grid = document.getElementById('catalog-grid');
  if (!beans || beans.length === 0) {
    grid.innerHTML = '<p class="empty-state">No coffee menu yet. In Edit Mode, tap "Sync Menu" to load from Google Sheets.</p>';
    return;
  }
  grid.innerHTML = '';
  beans.forEach(bean => {
    const name   = bean.name   || bean['coffee_name'] || '—';
    const origin = bean.origin || '';
    const process= bean.process|| '';
    const roast  = bean.roast_level || bean.roast || '';
    const notes  = bean.tasting_notes || bean.notes || '';
    const price  = bean.price  || '';

    const card = document.createElement('div');
    card.className = 'bean-card';

    const tags = [process, roast].filter(Boolean);

    card.innerHTML = `
      <div class="bean-card-img-placeholder">☕</div>
      <div class="bean-card-body">
        <div class="bean-name">${escHtml(name)}</div>
        ${origin ? `<div class="bean-origin">📍 ${escHtml(origin)}</div>` : ''}
        ${tags.length ? `<div class="bean-tags">${tags.map(t =>
          `<span class="bean-tag" style="border-left:3px solid ${roastBadgeColor(t)}">${escHtml(t)}</span>`
        ).join('')}</div>` : ''}
        ${notes ? `<div class="bean-notes">"${escHtml(notes)}"</div>` : ''}
        ${price ? `<div class="bean-price">${escHtml(price)}</div>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── Sync function ───────────────────────────────────────────────────────────
let isSyncing = false;

async function syncCatalog(url, silent = false) {
  if (isSyncing) return;
  isSyncing = true;
  const syncBtn = document.getElementById('sync-btn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = '⟳ Syncing…'; }

  try {
    const res = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const beans = csvToObjects(text);
    if (!beans.length) throw new Error('Empty or unrecognized CSV');
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(beans));
    renderCatalog(beans);
    if (!silent) showToast(`✓ Synced ${beans.length} coffees`);
  } catch (err) {
    const cached = loadCachedCatalog();
    if (cached) {
      renderCatalog(cached);
      if (!silent) showToast('Offline — showing cached menu');
    } else {
      if (!silent) showToast(`Sync failed: ${err.message}`);
    }
  } finally {
    isSyncing = false;
    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = '⟳ Sync Menu'; }
  }
}

function loadCachedCatalog() {
  try { return JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY)) || null; }
  catch { return null; }
}

// ─── Toast (re-use from app.js or define fallback) ───────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 350);
  }, 2800);
}

// ─── Sheets config modal ────────────────────────────────────────────────────
function openSheetsModal() {
  const modal    = document.getElementById('sheets-modal');
  const backdrop = document.getElementById('modal-backdrop');
  const input    = document.getElementById('sheets-url-input');
  input.value = localStorage.getItem(SHEETS_URL_KEY) || '';
  modal.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeSheetsModal() {
  document.getElementById('sheets-modal').classList.add('hidden');
  document.getElementById('modal-backdrop').classList.add('hidden');
}

// ─── Boot ────────────────────────────────────────────────────────────────────
function initSheets() {
  // Show cached catalog immediately
  const cached = loadCachedCatalog();
  if (cached) renderCatalog(cached);

  // Auto-sync if URL is configured
  const savedUrl = localStorage.getItem(SHEETS_URL_KEY);
  if (savedUrl) {
    syncCatalog(savedUrl, /* silent = */ true);
  }

  // "Sync Menu" button
  document.getElementById('sync-btn').addEventListener('click', () => {
    const url = localStorage.getItem(SHEETS_URL_KEY);
    if (!url) { openSheetsModal(); return; }
    syncCatalog(url);
  });

  // "⚙ Sheet URL" config button
  document.getElementById('sheets-config-btn').addEventListener('click', openSheetsModal);

  // Modal: Save & Sync
  document.getElementById('sheets-save-btn').addEventListener('click', () => {
    const url = document.getElementById('sheets-url-input').value.trim();
    if (!url) { showToast('Please enter a URL'); return; }
    localStorage.setItem(SHEETS_URL_KEY, url);
    closeSheetsModal();
    syncCatalog(url);
  });

  // Modal: Cancel
  document.getElementById('sheets-cancel-btn').addEventListener('click', closeSheetsModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeSheetsModal);

  // Allow Escape to close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSheetsModal();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSheets);
} else {
  initSheets();
}
