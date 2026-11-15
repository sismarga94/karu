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

// ─── Capacitor Filesystem (lazy import so desktop fallback still works) ─────
let CapFilesystem = null;
let CapDirectory  = null;

async function loadCapFilesystem() {
  if (CapFilesystem) return true;
  try {
    const mod = await import('./node_modules/@capacitor/filesystem/dist/esm/index.js');
    CapFilesystem = mod.Filesystem;
    CapDirectory  = mod.Directory;
    return true;
  } catch {
    return false;
  }
}

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
  if (isNative() && await loadCapFilesystem()) {
    const base64 = await fileToBase64(file);
    const fileName = `${key}.jpg`;
    await CapFilesystem.writeFile({
      path: fileName,
      data: base64,
      directory: CapDirectory.Data,
    });
    localStorage.setItem(`img:${key}`, fileName);
    // Read back to get a URI the <img> tag can use
    const result = await CapFilesystem.getUri({ path: fileName, directory: CapDirectory.Data });
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
  if (isNative() && await loadCapFilesystem()) {
    try {
      const result = await CapFilesystem.getUri({ path: stored, directory: CapDirectory.Data });
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
  } else if (isNative() && await loadCapFilesystem()) {
    try { await CapFilesystem.deleteFile({ path: stored, directory: CapDirectory.Data }); } catch { /* ok */ }
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

// ─── Boot ────────────────────────────────────────────────────────────────────
async function init() {
  loadTextFields();
  await Promise.all([initHeroImage(), initLogoImage(), loadGallery()]);
  initGalleryUpload();

  document.getElementById('edit-toggle').addEventListener('click', () => setEditMode(!editMode));

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
