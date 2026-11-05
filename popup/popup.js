/**
 * Pagefold - Popup Script
 */

import { getSettings, saveSettings, getDebugLogText } from '../utils/storage.js';

document.addEventListener('DOMContentLoaded', async () => {
  const btnFull = document.getElementById('btn-full-page');
  const btnVisible = document.getElementById('btn-visible-viewport');
  const btnArea = document.getElementById('btn-selected-area');
  const btnElement = document.getElementById('btn-selected-element');
  const btnHistory = document.getElementById('btn-open-history');
  const btnSettings = document.getElementById('btn-open-settings');

  const quickFormat = document.getElementById('quick-format');
  const quickAutoDownload = document.getElementById('quick-autodownload');

  // Load and apply current user settings
  const settings = await getSettings();
  if (quickFormat) quickFormat.value = settings.format || 'png';
  if (quickAutoDownload) quickAutoDownload.checked = !!settings.autoDownload;

  // Sync settings changes
  quickFormat?.addEventListener('change', async () => {
    await saveSettings({ format: quickFormat.value });
  });

  quickAutoDownload?.addEventListener('change', async () => {
    await saveSettings({ autoDownload: quickAutoDownload.checked });
  });

  // Closing the popup right after sending can drop the message, so wait for the reply
  const startCapture = async (action) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ action, tabId: tab?.id });
    window.close();
  };

  // Action Triggers
  btnFull?.addEventListener('click', () => startCapture('CAPTURE_FULL_PAGE'));
  btnVisible?.addEventListener('click', () => startCapture('CAPTURE_VISIBLE'));
  btnArea?.addEventListener('click', () => startCapture('START_SELECT_AREA'));
  btnElement?.addEventListener('click', () => startCapture('START_SELECT_ELEMENT'));

  const btnCopyLog = document.getElementById('btn-copy-debug-log');
  btnCopyLog?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await getDebugLogText());
      btnCopyLog.textContent = 'Copied ✓';
    } catch (err) {
      btnCopyLog.textContent = 'Copy failed';
    }
  });

  btnHistory?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html?view=history') });
    window.close();
  });

  btnSettings?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html?view=settings') });
    window.close();
  });
});
