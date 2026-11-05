/**
 * OpenFullPage - Storage & Settings Utility
 * 100% Local & Privacy-Friendly
 */

export const DEFAULT_SETTINGS = {
  format: 'png', // 'png' | 'jpeg' | 'webp' | 'pdf'
  quality: 92, // 10 - 100
  filenameTemplate: 'screencapture-{domain}-{date}-{time}',
  scrollDelay: 150, // ms between scrolls
  hideFixedElements: true,
  autoDownload: false,
  autoClipboard: false,
  openViewer: true,
  theme: 'system', // 'system' | 'dark' | 'light'
  pdfPageFormat: 'a4', // 'a4' | 'letter' | 'continuous'
  pdfOrientation: 'portrait', // 'portrait' | 'landscape' | 'auto'
  pdfMargins: 10, // mm
  pdfSplitPages: true
};

/**
 * Get user settings with defaults fallback
 */
export async function getSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['settings'], (result) => {
        resolve({ ...DEFAULT_SETTINGS, ...(result?.settings || {}) });
      });
    } else {
      try {
        const stored = localStorage.getItem('openfullpage_settings');
        resolve(stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : { ...DEFAULT_SETTINGS });
      } catch (e) {
        resolve({ ...DEFAULT_SETTINGS });
      }
    }
  });
}

/**
 * Save partial or full settings
 */
export async function saveSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };

  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ settings: updated }, () => {
        resolve(updated);
      });
    } else {
      try {
        localStorage.setItem('openfullpage_settings', JSON.stringify(updated));
      } catch (e) {}
      resolve(updated);
    }
  });
}

const MAX_DEBUG_LOG_ENTRIES = 300;
let debugLogQueue = Promise.resolve();

/**
 * Add an entry to the local capture log. It only leaves the browser if the
 * user copies it from the popup.
 */
export function appendDebugLog(event, data = {}) {
  debugLogQueue = debugLogQueue.then(async () => {
    const { debugLog = [] } = await chrome.storage.local.get('debugLog');
    debugLog.push({ time: new Date().toISOString(), event, ...data });
    await chrome.storage.local.set({ debugLog: debugLog.slice(-MAX_DEBUG_LOG_ENTRIES) });
  }).catch((err) => console.warn('Debug log write failed:', err));
  return debugLogQueue;
}

export async function getDebugLogText() {
  const { debugLog = [] } = await chrome.storage.local.get('debugLog');
  const header = {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    entries: debugLog.length
  };
  return JSON.stringify({ ...header, log: debugLog }, null, 1);
}

/**
 * Clean string for safe filesystem filename
 */
function sanitizeFilename(str) {
  return (str || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .substring(0, 100);
}

/**
 * Format filename using template and metadata
 */
export function formatFilename(template, meta = {}) {
  const now = new Date(meta.timestamp || Date.now());
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const timeStr = `${hh}-${min}-${ss}`;

  let domain = 'webpage';
  try {
    if (meta.url) {
      const parsed = new URL(meta.url);
      domain = parsed.hostname.replace(/^www\./, '');
    }
  } catch (e) {}

  const title = sanitizeFilename(meta.title || domain);
  const pattern = template || DEFAULT_SETTINGS.filenameTemplate;

  let result = pattern
    .replace(/\{title\}/gi, title)
    .replace(/\{domain\}/gi, sanitizeFilename(domain))
    .replace(/\{url\}/gi, sanitizeFilename(meta.url || domain))
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{time\}/gi, timeStr)
    .replace(/\{yyyy\}/gi, yyyy)
    .replace(/\{mm\}/gi, mm)
    .replace(/\{dd\}/gi, dd)
    .replace(/\{hh\}/gi, hh)
    .replace(/\{min\}/gi, min)
    .replace(/\{ss\}/gi, ss)
    .replace(/\{timestamp\}/gi, String(now.getTime()));

  // Fallback if template resulted in empty string
  result = result.replace(/[^a-zA-Z0-9_\-\.]/g, '-').replace(/-+/g, '-').trim();
  if (!result || result === '-') {
    result = `screencapture-${domain}-${dateStr}-${timeStr}`;
  }

  return result;
}
