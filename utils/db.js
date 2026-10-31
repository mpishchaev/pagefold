/**
 * OpenFullPage - IndexedDB Storage Manager
 * Stores captures locally without quota limits
 */

import { blobToDataURL } from './stitcher.js';

const DB_NAME = 'OpenFullPageDB';
const DB_VERSION = 1;
const STORE_NAME = 'captures';

function getIDB() {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof self !== 'undefined' && self.indexedDB) return self.indexedDB;
  if (typeof window !== 'undefined' && window.indexedDB) return window.indexedDB;
  return null;
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const idb = getIDB();
    if (!idb) {
      reject(new Error('IndexedDB is not supported in this environment'));
      return;
    }

    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('url', 'url', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Generate a thumbnail from a dataUrl or ImageBitmap
 */
export async function createThumbnail(dataUrl, maxWidth = 260) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      const scale = Math.min(1, maxWidth / bitmap.width);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
      return await blobToDataURL(thumbBlob);
    }
  } catch (e) {
    console.warn('OffscreenCanvas thumbnail failed, returning original/empty', e);
  }

  // Fallback in DOM environment
  if (typeof document !== 'undefined') {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  return dataUrl;
}

/**
 * Save a new capture to local IndexedDB
 */
export async function saveCapture(capture) {
  const db = await openDatabase();
  const id = capture.id || ('cap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
  const timestamp = capture.timestamp || Date.now();

  let thumbnail = capture.thumbnail;
  if (!thumbnail && capture.dataUrl) {
    try {
      thumbnail = await createThumbnail(capture.dataUrl, 260);
    } catch (e) {
      thumbnail = capture.dataUrl;
    }
  }

  const record = {
    id,
    timestamp,
    title: capture.title || 'Untitled Screenshot',
    url: capture.url || '',
    dimensions: capture.dimensions || { width: 0, height: 0 },
    dataUrl: capture.dataUrl,
    thumbnail: thumbnail || '',
    fileSize: capture.fileSize || (capture.dataUrl ? Math.round(capture.dataUrl.length * 0.75) : 0),
    format: capture.format || 'png',
    type: capture.type || 'full' // 'full' | 'visible' | 'selected' | 'element'
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);

    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get a capture by ID
 */
export async function getCapture(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all captures sorted by newest first
 * @param {boolean} includeFullData - whether to include large dataUrl
 */
export async function getAllCaptures(includeFullData = false) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');
    const req = index.openCursor(null, 'prev'); // newest first
    const list = [];

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        if (!includeFullData) {
          const { dataUrl, ...summary } = item;
          list.push(summary);
        } else {
          list.push(item);
        }
        cursor.continue();
      } else {
        resolve(list);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a capture by ID
 */
export async function deleteCapture(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clear all captures
 */
export async function clearAllCaptures() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get total storage usage estimate in bytes
 */
export async function getStorageUsage() {
  try {
    const all = await getAllCaptures(true);
    let totalBytes = 0;
    all.forEach(item => {
      if (item.fileSize) {
        totalBytes += item.fileSize;
      } else if (item.dataUrl) {
        totalBytes += item.dataUrl.length * 0.75;
      }
    });
    return {
      count: all.length,
      bytes: Math.round(totalBytes)
    };
  } catch (e) {
    return { count: 0, bytes: 0 };
  }
}
