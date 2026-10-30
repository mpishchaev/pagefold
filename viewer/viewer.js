/**
 * OpenFullPage - Main Viewer & Editor Controller
 */

import { getSettings, saveSettings, formatFilename } from '../utils/storage.js';
import { getCapture, getAllCaptures, deleteCapture, saveCapture } from '../utils/db.js';
import { ScreenshotEditor } from './editor.js';
import { HistoryManager } from './history.js';
import { exportToPdf } from './pdf-exporter.js';

let editor = null;
let currentCapture = null;
let currentSettings = null;
let historyManager = null;
let zoomLevel = 1.0;

// DOM Elements
const canvasStage = document.getElementById('canvas-stage');
const viewportContainer = document.getElementById('viewport-container');
const docTitle = document.getElementById('doc-title');
const docDims = document.getElementById('doc-dims');
const docType = document.getElementById('doc-type');
const zoomLevelText = document.getElementById('zoom-level-text');
const editorToolbar = document.getElementById('editor-toolbar');
const btnToggleEditor = document.getElementById('btn-toggle-editor');
const toastEl = document.getElementById('toast');

// Download Dropdown
const btnDownloadPrimary = document.getElementById('btn-download-primary');
const btnDownloadMenuToggle = document.getElementById('btn-download-menu-toggle');
const downloadMenu = document.getElementById('download-menu');
const downloadBtnLabel = document.getElementById('download-btn-label');

// Tool buttons
const toolButtons = document.querySelectorAll('.editor-tool-btn[data-tool]');
const colorDots = document.querySelectorAll('.color-dot');
const customColorPicker = document.getElementById('custom-color-picker');
const strokeSelect = document.getElementById('editor-stroke-width');
const fillShapeCheckbox = document.getElementById('editor-fill-shape');
const btnUndo = document.getElementById('btn-editor-undo');
const btnRedo = document.getElementById('btn-editor-redo');
const btnRotate = document.getElementById('btn-editor-rotate');
const btnFlip = document.getElementById('btn-editor-flip');
const btnClear = document.getElementById('btn-editor-clear');
const cropActionsBar = document.getElementById('crop-actions-bar');
const btnApplyCrop = document.getElementById('btn-apply-crop');
const btnCancelCrop = document.getElementById('btn-cancel-crop');

/**
 * Toast Notification Helper
 */
function showToast(message, isError = false) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = 'toast' + (isError ? ' toast-error' : '');
  toastEl.classList.remove('hidden');

  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3000);
}

/**
 * Initialize Editor and Stage
 */
async function initViewer() {
  currentSettings = await getSettings();
  applyTheme(currentSettings.theme);

  // Initialize Canvas Editor
  editor = new ScreenshotEditor(canvasStage, {
    onChange: ({ canUndo, canRedo, width, height }) => {
      if (btnUndo) btnUndo.disabled = !canUndo;
      if (btnRedo) btnRedo.disabled = !canRedo;
      if (docDims) docDims.textContent = `${width} × ${height} px`;
    }
  });

  // Initialize History Manager
  historyManager = new HistoryManager({
    onSelect: (id) => {
      loadCaptureById(id);
      closeModal('modal-history');
    },
    onDelete: (id) => {
      if (currentCapture && currentCapture.id === id) {
        loadLatestCapture();
      }
    },
    onClear: () => {
      loadLatestCapture();
    }
  });

  // Check URL query parameters
  const urlParams = new URLSearchParams(window.location.search);
  const captureId = urlParams.get('id');
  const viewMode = urlParams.get('view');

  if (captureId) {
    await loadCaptureById(captureId);
  } else {
    await loadLatestCapture();
  }

  if (viewMode === 'history') {
    openModal('modal-history');
  } else if (viewMode === 'settings') {
    openModal('modal-settings');
  }

  // Update Download button label based on default format
  updateDownloadLabel();

  // Setup Event Listeners
  setupNavigationEvents();
  setupZoomEvents();
  setupEditorToolEvents();
  setupModalEvents();
  setupSettingsEvents();
}

/**
 * Load a capture record by ID
 */
async function loadCaptureById(id) {
  const record = await getCapture(id);
  if (!record || !record.dataUrl) {
    showToast('Capture not found in local database', true);
    return;
  }

  currentCapture = record;
  docTitle.textContent = record.title || 'Screenshot';
  docTitle.title = `${record.title}\n${record.url || ''}`;

  if (docType) {
    const types = { full: 'Full Page', visible: 'Visible Area', selected: 'Selected Area', element: 'Element' };
    docType.textContent = types[record.type] || 'Screenshot';
  }

  await editor.loadImage(record.dataUrl);

  // Auto fit to screen
  fitToScreen();
}

/**
 * Load latest capture record from local database
 */
async function loadLatestCapture() {
  const all = await getAllCaptures(true);
  if (all && all.length > 0) {
    currentCapture = all[0];
    await loadCaptureById(currentCapture.id);
  } else {
    // Show sample placeholder
    docTitle.textContent = 'No screenshots captured yet';
    docDims.textContent = '0 × 0 px';
  }
}

/**
 * Set Zoom Scale
 */
function setZoom(scale) {
  zoomLevel = Math.max(0.1, Math.min(3.0, scale));
  canvasStage.style.transform = `scale(${zoomLevel})`;
  zoomLevelText.textContent = `${Math.round(zoomLevel * 100)}%`;
}

/**
 * Fit image nicely in viewport
 */
function fitToScreen() {
  if (!editor || !editor.baseCanvas.width) return;
  const padding = 64;
  const availW = viewportContainer.clientWidth - padding;
  const availH = viewportContainer.clientHeight - padding;

  const scaleW = availW / editor.baseCanvas.width;
  const scaleH = availH / editor.baseCanvas.height;

  // Fit whole image or max 1.0
  const fitScale = Math.min(1.0, scaleW, scaleH);
  setZoom(Math.max(0.15, fitScale));
}

/**
 * Zoom and Pan Controls
 */
function setupZoomEvents() {
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => setZoom(zoomLevel + 0.15));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => setZoom(zoomLevel - 0.15));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => fitToScreen());
  document.getElementById('btn-zoom-100')?.addEventListener('click', () => setZoom(1.0));

  // Wheel zoom with Ctrl key
  viewportContainer.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      setZoom(zoomLevel + delta);
    }
  }, { passive: false });
}

/**
 * Top Navigation and Action Bar Handlers
 */
function setupNavigationEvents() {
  // Toggle Annotator / Editor toolbar
  btnToggleEditor?.addEventListener('click', () => {
    const isHidden = editorToolbar.classList.toggle('hidden');
    btnToggleEditor.classList.toggle('active', !isHidden);
    if (!isHidden) {
      editor.setTool('pen');
      highlightActiveTool('pen');
    } else {
      editor.setTool('select');
      highlightActiveTool('select');
    }
  });

  // Copy to Clipboard
  document.getElementById('btn-copy-clipboard')?.addEventListener('click', async () => {
    try {
      const mergedCanvas = editor.getMergedCanvas();
      const blob = await new Promise((resolve) => mergedCanvas.toBlob(resolve, 'image/png'));

      if (!blob) throw new Error('Failed to create image blob');

      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      showToast('Copied screenshot to clipboard! 📋');
    } catch (err) {
      console.error('Clipboard copy failed:', err);
      showToast('Could not copy to clipboard: ' + err.message, true);
    }
  });

  // Download Primary Button
  btnDownloadPrimary?.addEventListener('click', () => {
    const format = currentSettings?.format || 'png';
    if (format === 'pdf') {
      openModal('modal-pdf');
    } else {
      triggerDownload(format);
    }
  });

  // Download Dropdown Menu Toggle
  btnDownloadMenuToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    downloadMenu.classList.toggle('hidden');
  });

  window.addEventListener('click', () => {
    downloadMenu?.classList.add('hidden');
  });

  // Dropdown Items
  downloadMenu?.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadMenu.classList.add('hidden');
      const action = item.dataset.action;

      if (action === 'download-png') triggerDownload('png');
      else if (action === 'download-jpg') triggerDownload('jpeg');
      else if (action === 'download-webp') triggerDownload('webp');
      else if (action === 'open-pdf-modal') openModal('modal-pdf');
    });
  });

  // History button
  document.getElementById('btn-history')?.addEventListener('click', () => {
    historyManager.refresh();
    openModal('modal-history');
  });

  // Settings button
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    openModal('modal-settings');
  });

  // Delete Screenshot
  document.getElementById('btn-delete')?.addEventListener('click', async () => {
    if (!currentCapture) return;
    if (confirm(`Delete screenshot "${currentCapture.title || 'Screenshot'}"?`)) {
      await deleteCapture(currentCapture.id);
      showToast('Screenshot deleted');
      await loadLatestCapture();
    }
  });
}

/**
 * Trigger Image Download
 */
function triggerDownload(format = 'png') {
  if (!editor || !currentCapture) return;

  const quality = (currentSettings?.quality || 92) / 100;
  const dataUrl = editor.getExportDataUrl(format, quality);
  const ext = format === 'jpeg' ? 'jpg' : format;
  const filename = `${formatFilename(currentSettings?.filenameTemplate, currentCapture)}.${ext}`;

  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();

  showToast(`Downloaded ${ext.toUpperCase()} successfully! 💾`);
}

function updateDownloadLabel() {
  if (!downloadBtnLabel) return;
  const format = (currentSettings?.format || 'png').toUpperCase();
  downloadBtnLabel.textContent = `Download ${format}`;
}

/**
 * Setup Editor Tool Palette Events
 */
function setupEditorToolEvents() {
  toolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      highlightActiveTool(tool);
      editor.setTool(tool);

      if (tool === 'crop') {
        cropActionsBar.classList.remove('hidden');
      } else {
        cropActionsBar.classList.add('hidden');
      }
    });
  });

  // Color dots
  colorDots.forEach((dot) => {
    dot.addEventListener('click', () => {
      colorDots.forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      const c = dot.dataset.color;
      editor.setColor(c);
      if (customColorPicker) customColorPicker.value = c;
    });
  });

  customColorPicker?.addEventListener('input', (e) => {
    colorDots.forEach((d) => d.classList.remove('active'));
    editor.setColor(e.target.value);
  });

  strokeSelect?.addEventListener('change', (e) => {
    editor.setStrokeWidth(e.target.value);
  });

  fillShapeCheckbox?.addEventListener('change', (e) => {
    editor.setFillShapes(e.target.checked);
  });

  // Undo / Redo
  btnUndo?.addEventListener('click', () => editor.undo());
  btnRedo?.addEventListener('click', () => editor.redo());

  // Rotate & Flip
  btnRotate?.addEventListener('click', () => editor.rotate(90));
  btnFlip?.addEventListener('click', () => editor.flip(true));

  // Clear All
  btnClear?.addEventListener('click', () => {
    if (confirm('Clear all drawings and annotations?')) {
      editor.clearAnnotations();
    }
  });

  // Crop Controls & Aspect Ratio Presets
  const cropPresetButtons = document.querySelectorAll('.btn-crop-preset[data-ratio]');
  cropPresetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      cropPresetButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const ratioStr = btn.dataset.ratio;
      let ratio = null;
      if (ratioStr === '1:1') ratio = 1;
      else if (ratioStr === '16:9') ratio = 16 / 9;
      else if (ratioStr === '4:3') ratio = 4 / 3;
      editor.setCropAspectRatio(ratio);
    });
  });

  document.getElementById('btn-reset-crop')?.addEventListener('click', () => {
    editor.startCrop();
  });

  btnApplyCrop?.addEventListener('click', async () => {
    const cropped = editor.applyCrop();
    if (cropped) {
      cropActionsBar.classList.add('hidden');
      highlightActiveTool('select');

      if (currentCapture) {
        currentCapture.dimensions = { width: cropped.width, height: cropped.height };
        currentCapture.dataUrl = editor.getExportDataUrl('png');
        await saveCapture(currentCapture);
      }

      if (docDims) docDims.textContent = `${cropped.width} × ${cropped.height} px`;
      fitToScreen();
      showToast('Image cropped successfully! ✂️');
    }
  });

  btnCancelCrop?.addEventListener('click', () => {
    editor.cancelCrop();
    cropActionsBar.classList.add('hidden');
    highlightActiveTool('select');
  });
}

function highlightActiveTool(toolName) {
  toolButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  });
}

/**
 * Modals Helper
 */
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('hidden');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

function setupModalEvents() {
  document.querySelectorAll('.modal-close, [data-modal]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const modalId = btn.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });

  // Close when clicking modal backdrop
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.classList.add('hidden');
      }
    });
  });

  // PDF Export Confirmation
  document.getElementById('btn-confirm-pdf-export')?.addEventListener('click', async () => {
    const format = document.getElementById('pdf-format').value;
    const orientation = document.getElementById('pdf-orientation').value;
    const margin = parseInt(document.getElementById('pdf-margins').value, 10);
    const includeHeader = document.getElementById('pdf-include-header').checked;
    const includePageNumbers = document.getElementById('pdf-include-numbers').checked;

    closeModal('modal-pdf');
    showToast('Generating PDF document...');

    try {
      const mergedCanvas = editor.getMergedCanvas();
      const doc = await exportToPdf(mergedCanvas, {
        format,
        orientation,
        margin,
        includeHeader,
        includePageNumbers,
        title: currentCapture?.title || 'Screenshot',
        url: currentCapture?.url || '',
        timestamp: currentCapture?.timestamp || Date.now()
      });

      const filename = `${formatFilename(currentSettings?.filenameTemplate, currentCapture)}.pdf`;
      doc.save(filename);
      showToast('PDF exported successfully! 📄');
    } catch (err) {
      console.error('PDF export failed:', err);
      showToast('Failed to export PDF: ' + err.message, true);
    }
  });
}

/**
 * Settings Modal Logic
 */
function setupSettingsEvents() {
  const formatSelect = document.getElementById('setting-format');
  const qualityRange = document.getElementById('setting-quality');
  const qualityVal = document.getElementById('setting-quality-val');
  const templateInput = document.getElementById('setting-filename-template');
  const previewCode = document.getElementById('filename-preview');
  const delayRange = document.getElementById('setting-scroll-delay');
  const delayVal = document.getElementById('setting-scroll-delay-val');
  const hideFixedCheckbox = document.getElementById('setting-hide-fixed');
  const autoDownloadCheckbox = document.getElementById('setting-auto-download');
  const autoClipboardCheckbox = document.getElementById('setting-auto-clipboard');
  const themeSelect = document.getElementById('setting-theme');

  // Load initial settings into modal form
  if (currentSettings) {
    if (formatSelect) formatSelect.value = currentSettings.format || 'png';
    if (qualityRange) qualityRange.value = currentSettings.quality || 92;
    if (qualityVal) qualityVal.textContent = `${currentSettings.quality || 92}%`;
    if (templateInput) templateInput.value = currentSettings.filenameTemplate;
    if (delayRange) delayRange.value = currentSettings.scrollDelay || 150;
    if (delayVal) delayVal.textContent = `${currentSettings.scrollDelay || 150} ms`;
    if (hideFixedCheckbox) hideFixedCheckbox.checked = !!currentSettings.hideFixedElements;
    if (autoDownloadCheckbox) autoDownloadCheckbox.checked = !!currentSettings.autoDownload;
    if (autoClipboardCheckbox) autoClipboardCheckbox.checked = !!currentSettings.autoClipboard;
    if (themeSelect) themeSelect.value = currentSettings.theme || 'system';

    updateFilenamePreview();
  }

  function updateFilenamePreview() {
    if (!previewCode || !templateInput) return;
    const preview = formatFilename(templateInput.value, {
      title: 'Example Page',
      url: 'https://example.com/article',
      timestamp: Date.now()
    });
    previewCode.textContent = `${preview}.${formatSelect?.value || 'png'}`;
  }

  qualityRange?.addEventListener('input', () => {
    qualityVal.textContent = `${qualityRange.value}%`;
  });

  delayRange?.addEventListener('input', () => {
    delayVal.textContent = `${delayRange.value} ms`;
  });

  templateInput?.addEventListener('input', updateFilenamePreview);
  formatSelect?.addEventListener('change', updateFilenamePreview);

  // Save Settings on close
  document.querySelector('.btn-modal-confirm[data-modal="modal-settings"]')?.addEventListener('click', async () => {
    const updated = {
      format: formatSelect.value,
      quality: parseInt(qualityRange.value, 10),
      filenameTemplate: templateInput.value.trim(),
      scrollDelay: parseInt(delayRange.value, 10),
      hideFixedElements: hideFixedCheckbox.checked,
      autoDownload: autoDownloadCheckbox.checked,
      autoClipboard: autoClipboardCheckbox.checked,
      theme: themeSelect.value
    };

    currentSettings = await saveSettings(updated);
    applyTheme(currentSettings.theme);
    updateDownloadLabel();
    showToast('Settings saved');
  });
}

function applyTheme(theme) {
  const body = document.body;
  if (theme === 'light') {
    body.className = 'theme-light';
  } else if (theme === 'dark') {
    body.className = 'theme-dark';
  } else {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    body.className = prefersDark ? 'theme-dark' : 'theme-light';
  }
}

// Start application
document.addEventListener('DOMContentLoaded', initViewer);
