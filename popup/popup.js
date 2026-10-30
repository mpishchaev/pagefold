/**
 * OpenFullPage - Popup Script
 */

import { getSettings, saveSettings } from '../utils/storage.js';

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

  // Action Triggers
  btnFull?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CAPTURE_FULL_PAGE' });
    window.close();
  });

  btnVisible?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE' });
    window.close();
  });

  btnArea?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'START_SELECT_AREA' });
    window.close();
  });

  btnElement?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'START_SELECT_ELEMENT' });
    window.close();
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
