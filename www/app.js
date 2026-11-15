/**
 * app.js — Local customization, image management, gallery
 *
 * Storage strategy:
 *   • Capacitor native  → @capacitor/filesystem (Directory.Data)  [Android/iOS]
 *   • Browser fallback  → IndexedDB via a tiny helper             [desktop dev]
 *
 * Text fields are always persisted in localStorage (fast, tiny).
 * Image files are written to the filesystem; their URI/path is stored in
 * localStorage so the <img> src can be restored on startup.
 */

// ─── Capacitor detection ────────────────────────────────────────────────────
const isNative = () =>
  typeof window !== 'undefined' &&
  window.Capacitor &&
  window.Capacitor.isNativePlatform &&
  window.Capacitor.isNativePlatform();

// ─── Capacitor plugin accessors ──────────────────────────────────────────────
// Capacitor registers all installed plugins on window.Capacitor.Plugins at
// runtime — no dynamic import paths needed (and those paths don't exist inside
// the APK assets bundle anyway).

function getCapPlugin(name) {
  return window?.Capacitor?.Plugins?.[name] ?? null;
}

// Directory enum values used by Filesystem
const CapDirectory = {
  Data:  'DATA',
  Cache: 'CACHE',
};

// ─── IndexedDB fallback for browser ─────────────────────────────────────────
const IDB_NAME    = 'roastery-images';
const IDB_STORE   = 'blobs';
const IDB_VERSION = 1;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}
async function idbSave(key, blob) {
  const db  = await openIDB();
  const tx  = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(blob, key);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}
async function idbLoad(key) {
  const db  = await openIDB();
  const tx  = db.transaction(IDB_STORE, 'readonly');
  const req = tx.objectStore(IDB_STORE).get(key);
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
}
async function idbDelete(key) {
  const db  = await openIDB();
  const tx  = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

// ─── Image persistence helpers ──────────────────────────────────────────────

/**
 * saveImage(key, file) → stores the file; returns a usable src string.
 *   Native: writes base64 to filesystem, returns capacitor:// URI (via readFile).
 *   Browser: stores Blob in IDB, returns object URL.
 */
async function saveImage(key, file) {
  const Filesystem = getCapPlugin('Filesystem');
  if (isNative() && Filesystem) {
    const base64 = await fileToBase64(file);
    const fileName = `${key}.jpg`;
    await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: CapDirectory.Data,
    });
    localStorage.setItem(`img:${key}`, fileName);
    const result = await Filesystem.getUri({ path: fileName, directory: CapDirectory.Data });
    return window.Capacitor.convertFileSrc(result.uri);
  } else {
    await idbSave(key, file);
    localStorage.setItem(`img:${key}`, `idb:${key}`);
    return URL.createObjectURL(file);
  }
}

/**
 * loadImage(key) → returns a usable src string, or null if nothing stored.
 */
async function loadImage(key) {
  const stored = localStorage.getItem(`img:${key}`);
  if (!stored) return null;

  if (stored.startsWith('idb:')) {
    const blob = await idbLoad(stored.slice(4));
    if (!blob) return null;
    return URL.createObjectURL(blob);
  }
  // native path stored
  const Filesystem = getCapPlugin('Filesystem');
  if (isNative() && Filesystem) {
    try {
      const result = await Filesystem.getUri({ path: stored, directory: CapDirectory.Data });
      return window.Capacitor.convertFileSrc(result.uri);
    } catch { return null; }
  }
  return null;
}

/**
 * deleteImage(key) → removes from filesystem/IDB and localStorage.
 */
async function deleteImage(key) {
  const stored = localStorage.getItem(`img:${key}`);
  if (!stored) return;
  if (stored.startsWith('idb:')) {
    await idbDelete(stored.slice(4));
  } else {
    const Filesystem = getCapPlugin('Filesystem');
    if (isNative() && Filesystem) {
      try { await Filesystem.deleteFile({ path: stored, directory: CapDirectory.Data }); } catch { /* ok */ }
    }
  }
  localStorage.removeItem(`img:${key}`);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]); // strip data URL prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Toast helper ───────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 350);
  }, 2800);
}

// ─── Edit mode ──────────────────────────────────────────────────────────────
let editMode = false;

function setEditMode(active) {
  editMode = active;
  document.body.classList.toggle('edit-mode', active);
  document.querySelectorAll('.edit-only').forEach(el => el.classList.toggle('hidden', !active));

  // Make text fields contenteditable in edit mode
  document.querySelectorAll('.editable').forEach(el => {
    el.contentEditable = active ? 'true' : 'false';
  });

  document.getElementById('edit-toggle').title = active ? 'Exit Edit Mode' : 'Enter Edit Mode';
  document.getElementById('edit-toggle').textContent = active ? '✓' : '✏';

  if (!active) {
    // Save all editable text fields to localStorage
    document.querySelectorAll('.editable[data-key]').forEach(el => {
      localStorage.setItem(el.dataset.key, el.textContent.trim());
    });
    showToast('Changes saved');
  }
}

// ─── Text fields: load on startup ───────────────────────────────────────────
function loadTextFields() {
  document.querySelectorAll('.editable[data-key]').forEach(el => {
    const val = localStorage.getItem(el.dataset.key);
    if (val) el.textContent = val;
  });
}

// ─── Hero image ─────────────────────────────────────────────────────────────
async function initHeroImage() {
  const src = await loadImage('hero');
  if (src) {
    const img = document.getElementById('hero-img');
    img.src = src;
  }
  document.getElementById('hero-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await saveImage('hero', file);
    document.getElementById('hero-img').src = src;
    showToast('Hero image updated');
    e.target.value = '';
  });
}

// ─── Logo image ─────────────────────────────────────────────────────────────
async function initLogoImage() {
  const src = await loadImage('logo');
  if (src) {
    document.getElementById('logo-img').src = src;
  }
  document.getElementById('logo-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await saveImage('logo', file);
    document.getElementById('logo-img').src = src;
    showToast('Logo updated');
    e.target.value = '';
  });
}

// ─── Gallery ─────────────────────────────────────────────────────────────────
function getGalleryKeys() {
  const raw = localStorage.getItem('galleryKeys');
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveGalleryKeys(keys) {
  localStorage.setItem('galleryKeys', JSON.stringify(keys));
}

function renderGalleryItem(key, src) {
  const grid = document.getElementById('gallery-grid');
  const wrap = document.createElement('div');
  wrap.className = 'gallery-item';
  wrap.dataset.key = key;

  const img = document.createElement('img');
  img.src = src;
  img.alt = 'Gallery photo';

  const delBtn = document.createElement('button');
  delBtn.className = 'gallery-delete-btn edit-only';
  delBtn.innerHTML = '✕';
  if (!editMode) delBtn.classList.add('hidden');
  delBtn.setAttribute('aria-label', 'Delete photo');

  delBtn.addEventListener('click', async () => {
    await deleteImage(key);
    const keys = getGalleryKeys().filter(k => k !== key);
    saveGalleryKeys(keys);
    wrap.remove();
    showToast('Photo removed');
  });

  wrap.append(img, delBtn);
  grid.append(wrap);
}

async function loadGallery() {
  const keys = getGalleryKeys();
  for (const key of keys) {
    const src = await loadImage(key);
    if (src) renderGalleryItem(key, src);
  }
}

function initGalleryUpload() {
  document.getElementById('gallery-add-input').addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    const keys = getGalleryKeys();
    for (const file of files) {
      const key = `gallery_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const src = await saveImage(key, file);
      keys.push(key);
      renderGalleryItem(key, src);
    }
    saveGalleryKeys(keys);
    showToast(`${files.length} photo${files.length > 1 ? 's' : ''} added`);
    e.target.value = '';
  });
}

// ─── Section Show/Hide toggles ───────────────────────────────────────────────
const SECTION_VISIBILITY_KEY = 'sectionVisibility';

function getSectionVisibility() {
  try { return JSON.parse(localStorage.getItem(SECTION_VISIBILITY_KEY)) || {}; } catch { return {}; }
}
function saveSectionVisibility(map) {
  localStorage.setItem(SECTION_VISIBILITY_KEY, JSON.stringify(map));
}

function applySectionVisibility(sectionId, visible) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  Array.from(section.children).forEach(child => {
    const isHeader = child.classList.contains('catalog-header') ||
                     child.classList.contains('gallery-header');
    if (!isHeader) child.classList.toggle('section-body-hidden', !visible);
  });
  const btn = section.querySelector('.section-toggle');
  if (btn) {
    btn.classList.toggle('is-hidden', !visible);
    btn.title = visible ? `Hide ${btn.dataset.label || 'section'}` : `Show ${btn.dataset.label || 'section'}`;
    btn.textContent = visible ? '👁' : '👁\u200d🗨';
  }
}

function initSectionToggles() {
  const visibility = getSectionVisibility();
  document.querySelectorAll('.section-toggle').forEach(btn => {
    const targetId = btn.dataset.target;
    const label    = document.getElementById(targetId)?.querySelector('h2')?.textContent || targetId;
    btn.dataset.label = label;

    const isVisible = visibility[targetId] !== false;
    applySectionVisibility(targetId, isVisible);

    btn.addEventListener('click', () => {
      const map = getSectionVisibility();
      const nowVisible = map[targetId] === false;
      map[targetId] = nowVisible;
      saveSectionVisibility(map);
      applySectionVisibility(targetId, nowVisible);
    });
  });
}

// ─── Shared capture helpers ──────────────────────────────────────────────────

function makeOverlay(label) {
  const el = document.createElement('div');
  el.className = 'pdf-overlay';
  el.innerHTML = `<div class="pdf-overlay-spinner"></div><span>${label}</span>`;
  return el;
}

/**
 * Hides UI chrome, unhides hidden sections, waits for repaint,
 * then runs html2canvas and returns the canvas.
 * The overlay is passed in so it can be excluded from capture.
 */
async function captureCanvas(overlay) {
  document.body.classList.add('pdf-capturing');

  // Temporarily reveal hidden sections so they appear in the output
  document.querySelectorAll('.section-body-hidden')
    .forEach(el => el.classList.remove('section-body-hidden'));

  // Let CSS settle before the snapshot
  await new Promise(r => setTimeout(r, 150));

  // Mount overlay AFTER the repaint — it won't be in the captured pixels
  document.body.appendChild(overlay);

  return html2canvas(document.body, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#faf7f2',
    scrollX: 0,
    scrollY: 0,
    windowWidth: 390,                     // consistent phone-width output
    windowHeight: document.body.scrollHeight,
    ignoreElements: el => el === overlay, // skip overlay node
  });
}

/** Re-applies hidden state to sections that were collapsed before capture */
function restoreHiddenSections() {
  const map = getSectionVisibility();
  document.querySelectorAll('.section-toggle').forEach(btn => {
    const id = btn.dataset.target;
    if (map[id] === false) applySectionVisibility(id, false);
  });
}

/** Share a file natively on Android, or trigger a browser download */
async function shareOrDownload(blob, fileName, dialogTitle) {
  const Filesystem = getCapPlugin('Filesystem');
  const Share      = getCapPlugin('Share');

  if (isNative() && Filesystem && Share) {
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(blob);
    });
    await Filesystem.writeFile({ path: fileName, data: base64, directory: CapDirectory.Cache });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: CapDirectory.Cache });
    await Share.share({ title: fileName, url: uri, dialogTitle });
    showToast('Share sheet opened');
  } else {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast(`${fileName.endsWith('.pdf') ? 'PDF' : 'Image'} downloaded`);
  }
}

function getExportName() {
  return (localStorage.getItem('roasteryName') || 'Roastery-Profile')
    .replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
}

// ─── Export as PDF ────────────────────────────────────────────────────────────
// Single-page PDF sized exactly to content height — no cropping, ever.
async function exportPDF() {
  const btn = document.getElementById('pdf-export-btn');
  btn.disabled = true;
  btn.textContent = '⏳ PDF…';
  const overlay = makeOverlay('Generating PDF…');

  try {
    const canvas = await captureCanvas(overlay);
    const { jsPDF } = window.jspdf;

    // canvas pixels → mm (96 dpi base, html2canvas scale=2)
    const PX_TO_MM  = 25.4 / 96 / 2;
    const MARGIN_MM = 6;
    const contentW  = canvas.width  * PX_TO_MM;
    const contentH  = canvas.height * PX_TO_MM;
    const pdfW      = contentW + MARGIN_MM * 2;
    const pdfH      = contentH + MARGIN_MM * 2;

    // One page exactly as tall as the content — zero cropping
    const pdf = new jsPDF({ unit: 'mm', format: [pdfW, pdfH], orientation: 'portrait' });
    pdf.addImage(
      canvas.toDataURL('image/jpeg', 0.93), 'JPEG',
      MARGIN_MM, MARGIN_MM,
      contentW, contentH,
      undefined, 'FAST'
    );

    await shareOrDownload(pdf.output('blob'), `${getExportName()}.pdf`, 'Share PDF via…');
  } catch (err) {
    showToast(`PDF failed: ${err.message}`);
    console.error(err);
  } finally {
    restoreHiddenSections();
    document.body.classList.remove('pdf-capturing');
    overlay.remove();
    btn.disabled = false;
    btn.textContent = '⬇ PDF';
  }
}

// ─── Export as Image (PNG) ────────────────────────────────────────────────────
// Single tall PNG — perfect for WhatsApp, Instagram Stories, saving to Photos.
async function exportImage() {
  const btn = document.getElementById('img-export-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Image…';
  const overlay = makeOverlay('Generating Image…');

  try {
    const canvas = await captureCanvas(overlay);

    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png')
    );

    await shareOrDownload(blob, `${getExportName()}.png`, 'Share Image via…');
  } catch (err) {
    showToast(`Image failed: ${err.message}`);
    console.error(err);
  } finally {
    restoreHiddenSections();
    document.body.classList.remove('pdf-capturing');
    overlay.remove();
    btn.disabled = false;
    btn.textContent = '🖼 Image';
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function init() {
  loadTextFields();
  await Promise.all([initHeroImage(), initLogoImage(), loadGallery()]);
  initGalleryUpload();
  initSectionToggles();

  document.getElementById('edit-toggle').addEventListener('click', () => setEditMode(!editMode));
  document.getElementById('pdf-export-btn').addEventListener('click', exportPDF);
  document.getElementById('img-export-btn').addEventListener('click', exportImage);

  // Prevent accidental navigation when editing text
  document.querySelectorAll('.editable').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      }
    });
  });
}

// Wait for Capacitor to be ready if running natively, else just DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export helpers for sheets.js
export { showToast, editMode };
