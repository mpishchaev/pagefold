/**
 * OpenFullPage - Background Service Worker (Manifest V3)
 * Handles capture coordination, stitching, keyboard shortcuts,
 * context menus, and storage management.
 */

import { getSettings, formatFilename } from '../utils/storage.js';
import { saveCapture } from '../utils/db.js';
import { stitchSlices, cropImage } from '../utils/stitcher.js';

let activeCaptures = new Map(); // tabId -> state

/**
 * Ensure content script & styles are injected on target tab
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch (e) {
    // If message fails, inject script and CSS dynamically
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/overlay.css']
    }).catch(() => {});

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
  }
}

/**
 * Capture full scrollable page
 */
export async function captureFullPage(tab) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;

  // Cannot capture chrome internal or webstore pages
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('https://chromewebstore.google.com')) {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'OpenFullPage',
      message: 'Chrome security prevents capturing internal browser and Web Store pages.'
    });
    return;
  }

  await ensureContentScript(tabId);
  const settings = await getSettings();

  try {
    // 1. Prepare page and get metrics
    const metrics = await chrome.tabs.sendMessage(tabId, {
      action: 'PREPARE_FULL_PAGE',
      options: { hideFixedElements: settings.hideFixedElements }
    });

    if (!metrics) {
      throw new Error('Failed to retrieve page metrics');
    }

    const { totalWidth, totalHeight, viewportWidth, viewportHeight, devicePixelRatio } = metrics;
    const slices = [];
    const scrollDelay = Math.max(50, settings.scrollDelay || 150);

    let currentY = 0;
    let sliceIndex = 0;
    activeCaptures.set(tabId, { cancelled: false });

    // 2. Scroll and snap loop
    while (currentY < totalHeight) {
      const state = activeCaptures.get(tabId);
      if (state && state.cancelled) {
        await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' });
        activeCaptures.delete(tabId);
        return;
      }

      const progress = Math.min(99, Math.round((currentY / totalHeight) * 100));

      // Scroll to current step
      await chrome.tabs.sendMessage(tabId, {
        action: 'SCROLL_TO',
        x: 0,
        y: currentY,
        hideFixed: settings.hideFixedElements,
        progress
      });

      // Allow animations and lazy loads to settle
      await new Promise((r) => setTimeout(r, scrollDelay));

      // Snap visible tab
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      slices.push({
        dataUrl,
        y: currentY,
        windowWidth: viewportWidth,
        windowHeight: viewportHeight
      });

      sliceIndex++;

      // Next scroll offset
      if (currentY + viewportHeight >= totalHeight) {
        break; // reached bottom
      } else {
        currentY = Math.min(totalHeight - viewportHeight, currentY + viewportHeight);
      }
    }

    // 3. Restore page to original state
    await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' });
    activeCaptures.delete(tabId);

    // 4. Stitch captured slices into one image
    const stitched = await stitchSlices(slices, {
      totalWidth,
      totalHeight,
      devicePixelRatio,
      format: settings.format,
      quality: (settings.quality || 92) / 100
    });

    // 5. Save capture record locally in IndexedDB
    const record = await saveCapture({
      title: metrics.title || tab.title || 'Screenshot',
      url: metrics.url || tab.url || '',
      dataUrl: stitched.dataUrl,
      dimensions: { width: stitched.width, height: stitched.height },
      format: settings.format,
      type: 'full'
    });

    // 6. Handle post-capture actions
    await handlePostCapture(record, settings);

  } catch (err) {
    console.error('Full page capture failed:', err);
    activeCaptures.delete(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'FINISH_FULL_PAGE' });
    } catch (e) {}
  }
}

/**
 * Capture visible viewport only
 */
export async function captureVisible(tab) {
  if (!tab || !tab.id) return;
  const settings = await getSettings();

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
  }
}

/**
 * Start selected area snipping
 */
export async function startSelectArea(tab) {
  if (!tab || !tab.id) return;
  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { action: 'START_SELECT_AREA' });
}

/**
 * Start DOM element selection
 */
export async function startSelectElement(tab) {
  if (!tab || !tab.id) return;
  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { action: 'START_SELECT_ELEMENT' });
}

/**
 * Handle confirmed area or element crop
 */
async function handleAreaConfirmed(rect, tab) {
  const settings = await getSettings();
  try {
    const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
    chrome.tabs.create({ url: viewerUrl });
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CAPTURE_FULL_PAGE') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) captureFullPage(tab);
    });
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'CAPTURE_VISIBLE') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) captureVisible(tab);
    });
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'START_SELECT_AREA') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) startSelectArea(tab);
    });
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'START_SELECT_ELEMENT') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) startSelectElement(tab);
    });
    sendResponse({ started: true });
    return true;
  }

  if (message.action === 'CAPTURE_AREA_CONFIRMED') {
    handleAreaConfirmed(message.rect, sender.tab);
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
