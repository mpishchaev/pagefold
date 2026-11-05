/**
 * OpenFullPage - Background Service Worker (Manifest V3)
 * Handles capture coordination, stitching, keyboard shortcuts,
 * context menus, and storage management.
 */

import { getSettings, formatFilename, appendDebugLog } from '../utils/storage.js';
import { saveCapture } from '../utils/db.js';
import { stitchSlices, cropImage } from '../utils/stitcher.js';

let activeCaptures = new Map(); // tabId -> state
let lastCaptureTime = 0;

// Chrome allows 2 captureVisibleTab calls per second
const MIN_CAPTURE_INTERVAL = 550;

/**
 * Chrome stops a worker after 30 seconds without extension API calls, without
 * any error. Stitching a long page can take that long, so keep the timer reset.
 */
async function withKeepAlive(work) {
  const timer = setInterval(chrome.runtime.getPlatformInfo, 20 * 1000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Status line on the captured page. System notifications are often muted,
 * so failures must not depend on them alone.
 */
async function showPageStatus(tabId, text, { isError = false } = {}) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'SHOW_STATUS', text, isError }, { frameId: 0 });
  } catch (e) {}
}

function notifyError(message) {
  appendDebugLog('error', { message });
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: 'OpenFullPage',
    message
  });
}

/**
 * Safely capture visible tab, pacing calls to stay under the
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota, with backoff if it is hit anyway
 */
async function safeCaptureVisibleTab(windowId, options = { format: 'png' }, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const wait = lastCaptureTime + MIN_CAPTURE_INTERVAL - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCaptureTime = Date.now();

    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (err) {
      if (attempt === maxRetries || !String(err?.message).includes('MAX_CAPTURE')) throw err;
      console.warn(`captureVisibleTab throttled (attempt ${attempt}/${maxRetries}): ${err?.message || err}. Backing off...`);
      await new Promise((r) => setTimeout(r, 350 * attempt));
    }
  }
}

/**
 * Ensure content script & styles are injected on target tab
 */
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'PING' }, { frameId: 0 });
    if (res && res.pong) return;
  } catch (e) {
    // If ping fails, inject script and CSS dynamically into the main tab
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/overlay.css']
    });
  } catch (e) {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js']
  });
}

/**
 * Pages the extension is not allowed to touch
 */
function isRestrictedUrl(url = '') {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url)
    || url.startsWith('https://chromewebstore.google.com');
}

/**
 * Stitch slices into one image, save it and run post-capture actions
 */
async function saveStitched(tabId, slices, geometry, meta, settings) {
  await showPageStatus(tabId, 'Processing screenshot…');
  const startedAt = Date.now();
  appendDebugLog('stitch-start', { type: meta.type, slices: slices.length, geometry });

  await withKeepAlive(async () => {
    const stitched = await stitchSlices(slices, {
      ...geometry,
      format: settings.format,
      quality: (settings.quality || 92) / 100
    });
    appendDebugLog('stitched', {
      ms: Date.now() - startedAt,
      width: stitched.width,
      height: stitched.height,
      dataUrlLength: stitched.dataUrl.length
    });

    const record = await saveCapture({
      ...meta,
      dataUrl: stitched.dataUrl,
      dimensions: { width: stitched.width, height: stitched.height },
      format: settings.format
    });
    appendDebugLog('saved', { ms: Date.now() - startedAt, id: record.id });

    await handlePostCapture(record, settings);
    appendDebugLog('post-capture-done', { ms: Date.now() - startedAt });
  });

  await showPageStatus(tabId, '');
}

/**
 * Capture full scrollable page
 */
export async function captureFullPage(tab) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;

  // Cannot capture chrome internal or webstore pages
  if (isRestrictedUrl(tab.url)) {
    notifyError('Chrome security prevents capturing internal browser and Web Store pages.');
    return;
  }

  if (activeCaptures.has(tabId)) return;
  activeCaptures.set(tabId, { cancelled: false });

  try {
    await ensureContentScript(tabId);
    const settings = await getSettings();

    // 1. Prepare page and get metrics from top frame
    const metrics = await chrome.tabs.sendMessage(tabId, {
      action: 'PREPARE_FULL_PAGE',
      options: { hideFixedElements: settings.hideFixedElements }
    }, { frameId: 0 });

    if (!metrics) {
      throw new Error('Failed to retrieve page metrics');
    }

    appendDebugLog('full-page-prepared', { url: tab.url, settings: { format: settings.format, autoDownload: settings.autoDownload, openViewer: settings.openViewer }, metrics });
    const { totalWidth, totalHeight, viewportHeight, windowWidth, devicePixelRatio, clip } = metrics;
    const slices = [];
    const scrollDelay = Math.max(120, settings.scrollDelay || 180);

    // Overlap slices by a pixel: fractional scale factors can otherwise leave seams
    const scrollStep = Math.max(1, Math.floor(viewportHeight) - 1);

    let currentY = 0;

    // 2. Scroll and snap loop
    while (currentY < totalHeight) {
      const state = activeCaptures.get(tabId);
      if (state && state.cancelled) {
        await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' }, { frameId: 0 });
        activeCaptures.delete(tabId);
        try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}
        return;
      }

      const progress = Math.min(99, Math.round((currentY / totalHeight) * 100));

      // Update badge progress
      try {
        chrome.action.setBadgeText({ tabId, text: `${progress}%` });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#4F46E5' });
      } catch (e) {}

      // Scroll to current step
      const scrolled = await chrome.tabs.sendMessage(tabId, {
        action: 'SCROLL_TO',
        x: 0,
        y: currentY,
        hideFixed: settings.hideFixedElements,
        progress
      }, { frameId: 0 });

      // The page decides where a scroll really ends up
      if (slices.length > 0 && scrolled?.actualY <= slices[slices.length - 1].y) break;
      const actualY = scrolled?.actualY ?? currentY;

      // Allow animations and lazy loads to settle
      await new Promise((r) => setTimeout(r, scrollDelay));

      // Temporarily hide HUD so it never gets captured in screenshots
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'BEFORE_SNAP' }, { frameId: 0 });
      } catch (e) {}

      // Snap visible tab with auto-retry
      const dataUrl = await safeCaptureVisibleTab(tab.windowId, { format: 'png' });
      slices.push({ dataUrl, y: actualY, windowWidth, clip });

      // Restore HUD visibility
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'AFTER_SNAP' }, { frameId: 0 });
      } catch (e) {}

      // Next scroll offset
      if (actualY + viewportHeight >= totalHeight) {
        break; // reached bottom
      }
      currentY = actualY + scrollStep;
    }

    // Clear badge
    try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}

    // 3. Restore page to original state
    await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' }, { frameId: 0 });
    activeCaptures.delete(tabId);

    // 4. Stitch, save locally in IndexedDB and run post-capture actions
    await saveStitched(tabId, slices, { totalWidth, totalHeight, devicePixelRatio }, {
      title: metrics.title || tab.title || 'Screenshot',
      url: metrics.url || tab.url || '',
      type: 'full'
    }, settings);

  } catch (err) {
    console.error('Full page capture failed:', err);
    activeCaptures.delete(tabId);
    try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' }, { frameId: 0 });
    } catch (e) {}
    const failure = 'Full page capture failed: ' + (err?.message || String(err));
    notifyError(failure);
    await showPageStatus(tabId, failure, { isError: true });
  }
}

/**
 * Capture visible viewport only
 */
export async function captureVisible(tab) {
  if (!tab || !tab.id) return;
  const settings = await getSettings();

  try {
    const dataUrl = await safeCaptureVisibleTab(tab.windowId, { format: 'png' });
    const record = await saveCapture({
      title: tab.title || 'Screenshot',
      url: tab.url || '',
      dataUrl,
      format: settings.format,
      type: 'visible'
    });

    await handlePostCapture(record, settings);
  } catch (err) {
    console.error('Visible capture failed:', err);
    notifyError('Capture failed: ' + (err?.message || String(err)));
  }
}

/**
 * Start selected area snipping
 */
export async function startSelectArea(tab) {
  await startPicker(tab, 'START_SELECT_AREA');
}

/**
 * Start DOM element selection
 */
export async function startSelectElement(tab) {
  await startPicker(tab, 'START_SELECT_ELEMENT');
}

async function startPicker(tab, action) {
  if (!tab || !tab.id) return;
  if (isRestrictedUrl(tab.url)) {
    notifyError('Chrome security prevents capturing internal browser and Web Store pages.');
    return;
  }

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { action }, { frameId: 0 });
  } catch (err) {
    console.error('Could not start selection:', err);
    notifyError('Could not start selection: ' + (err?.message || String(err)));
  }
}

/**
 * Capture the element picked in the page, scrolling through it if it is
 * larger than the viewport
 */
async function handleElementConfirmed(meta, tab) {
  const tabId = tab.id;
  if (activeCaptures.has(tabId)) return;
  activeCaptures.set(tabId, { cancelled: false });

  try {
    const settings = await getSettings();
    const metrics = await chrome.tabs.sendMessage(tabId, {
      action: 'PREPARE_ELEMENT',
      options: { hideFixedElements: settings.hideFixedElements }
    }, { frameId: 0 });
    appendDebugLog('element-prepared', { metrics });
    if (metrics.error) throw new Error(metrics.error);

    const scrollDelay = Math.max(120, settings.scrollDelay || 180);
    const slices = [];
    let offsetY = 0;

    while (true) {
      const slice = await chrome.tabs.sendMessage(tabId, { action: 'SHOW_ELEMENT_SLICE', offsetY }, { frameId: 0 });
      appendDebugLog('element-slice', { offsetY, slice });
      if (slice.error) throw new Error(slice.error);
      if (slice.scrolled) await new Promise((r) => setTimeout(r, scrollDelay));

      const dataUrl = await safeCaptureVisibleTab(tab.windowId, { format: 'png' });
      slices.push({ dataUrl, y: slice.y, windowWidth: metrics.windowWidth, clip: slice.clip });

      // One pixel of overlap, see captureFullPage. No progress means the rest cannot be reached
      const nextOffset = slice.y + slice.clip.height - 1;
      if (slice.done || nextOffset <= offsetY) break;
      offsetY = nextOffset;
    }

    await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' }, { frameId: 0 });
    activeCaptures.delete(tabId);

    const last = slices[slices.length - 1];
    await saveStitched(tabId, slices, {
      totalWidth: slices[0].clip.width,
      totalHeight: Math.min(metrics.totalHeight, last.y + last.clip.height),
      devicePixelRatio: metrics.devicePixelRatio
    }, {
      title: meta.title || tab.title || 'Screenshot',
      url: meta.url || tab.url || '',
      type: 'element'
    }, settings);
  } catch (err) {
    console.error('Element capture failed:', err);
    appendDebugLog('element-failed', { message: err?.message, stack: err?.stack });
    activeCaptures.delete(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' }, { frameId: 0 });
    } catch (e) {}
    const failure = 'Element capture failed: ' + (err?.message || String(err));
    notifyError(failure);
    await showPageStatus(tabId, failure, { isError: true });
  }
}

/**
 * Handle confirmed area or element crop
 */
async function handleAreaConfirmed(rect, tab) {
  const settings = await getSettings();
  try {
    const rawDataUrl = await safeCaptureVisibleTab(tab.windowId, { format: 'png' });
    const cropped = await cropImage(rawDataUrl, rect);

    const record = await saveCapture({
      title: rect.title || tab.title || 'Screenshot',
      url: rect.url || tab.url || '',
      dataUrl: cropped.dataUrl,
      dimensions: { width: cropped.width, height: cropped.height },
      format: settings.format,
      type: 'selected'
    });

    await handlePostCapture(record, settings);
  } catch (err) {
    console.error('Area crop capture failed:', err);
    notifyError('Capture failed: ' + (err?.message || String(err)));
  }
}

/**
 * Open viewer or auto-download according to user settings
 */
async function handlePostCapture(record, settings) {
  // If auto-download enabled
  if (settings.autoDownload) {
    const ext = record.format || 'png';
    const filename = `${formatFilename(settings.filenameTemplate, record)}.${ext}`;
    chrome.downloads.download({
      url: record.dataUrl,
      filename,
      saveAs: false
    });
  }

  // Open viewer tab (default true)
  if (settings.openViewer || !settings.autoDownload) {
    const viewerUrl = chrome.runtime.getURL(`viewer/viewer.html?id=${record.id}`);
    await chrome.tabs.create({ url: viewerUrl });
  }
}

/**
 * Setup Context Menus on install
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'openfp_parent',
      title: '📸 OpenFullPage Screenshot',
      contexts: ['page', 'selection', 'image', 'link']
    });

    chrome.contextMenus.create({
      id: 'openfp_full',
      parentId: 'openfp_parent',
      title: 'Capture Entire Page (Alt+Shift+P)',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'openfp_visible',
      parentId: 'openfp_parent',
      title: 'Capture Visible Area (Alt+Shift+V)',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'openfp_area',
      parentId: 'openfp_parent',
      title: 'Capture Selected Area (Alt+Shift+S)',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'openfp_element',
      parentId: 'openfp_parent',
      title: 'Capture Element (Alt+Shift+E)',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'openfp_history',
      parentId: 'openfp_parent',
      title: 'Open Capture History',
      contexts: ['all']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'openfp_full') {
    captureFullPage(tab);
  } else if (info.menuItemId === 'openfp_visible') {
    captureVisible(tab);
  } else if (info.menuItemId === 'openfp_area') {
    startSelectArea(tab);
  } else if (info.menuItemId === 'openfp_element') {
    startSelectElement(tab);
  } else if (info.menuItemId === 'openfp_history') {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html?view=history') });
  }
});

/**
 * Setup Keyboard Shortcuts
 */
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'capture_full_page') {
    captureFullPage(tab);
  } else if (command === 'capture_visible') {
    captureVisible(tab);
  } else if (command === 'capture_selected_area') {
    startSelectArea(tab);
  } else if (command === 'capture_element') {
    startSelectElement(tab);
  }
});

/**
 * Handle incoming runtime messages
 */
const CAPTURE_ACTIONS = {
  CAPTURE_FULL_PAGE: captureFullPage,
  CAPTURE_VISIBLE: captureVisible,
  START_SELECT_AREA: startSelectArea,
  START_SELECT_ELEMENT: startSelectElement
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const startCapture = CAPTURE_ACTIONS[message.action];
  if (startCapture) {
    chrome.tabs.get(message.tabId).then(startCapture).catch((err) => {
      console.error('Capture could not start:', err);
      notifyError('Capture failed: ' + (err?.message || String(err)));
    });
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'CAPTURE_AREA_CONFIRMED') {
    handleAreaConfirmed(message.rect, sender.tab);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'DEBUG_LOG') {
    appendDebugLog(message.event, { url: sender.tab?.url, ...message.data });
    sendResponse({ logged: true });
    return true;
  }

  if (message.action === 'CAPTURE_ELEMENT_CONFIRMED') {
    handleElementConfirmed(message.meta, sender.tab);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'CANCEL_CAPTURE') {
    if (sender.tab && activeCaptures.has(sender.tab.id)) {
      activeCaptures.get(sender.tab.id).cancelled = true;
    }
    sendResponse({ cancelled: true });
    return true;
  }
});
