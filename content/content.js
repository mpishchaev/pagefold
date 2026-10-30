/**
 * OpenFullPage - Content Script
 * Coordinates page metrics, smooth scrolling, sticky element suppression,
 * visual capture progress HUD, and area/element snipping tools.
 */

(() => {
  // Guard against double initialization
  if (window.__OPEN_FULLPAGE_LOADED__) return;
  window.__OPEN_FULLPAGE_LOADED__ = true;

  let origScrollX = 0;
  let origScrollY = 0;
  let origHtmlOverflow = '';
  let origBodyOverflow = '';
  let fixedElements = [];
  let isCancelled = false;

  // UI elements
  let hudElement = null;
  let selectOverlayElement = null;
  let elementHighlighter = null;

  /**
   * Helper to ensure overlay stylesheet is loaded
   */
  function ensureStyles() {
    if (!document.getElementById('openfullpage-style')) {
      const link = document.createElement('link');
      link.id = 'openfullpage-style';
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('content/overlay.css');
      (document.head || document.documentElement).appendChild(link);
    }
  }

  /**
   * Discover elements with position: fixed or sticky
   */
  function findFixedElements() {
    const list = [];
    try {
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.id === 'openfullpage-hud' || el.closest('#openfullpage-hud')) continue;

        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          // Check if visible
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
            list.push({
              element: el,
              origVisibility: el.style.visibility || ''
            });
          }
        }
      }
    } catch (e) {
      console.warn('Error detecting fixed elements:', e);
    }
    return list;
  }

  /**
   * Hide fixed / sticky elements so they don't repeat on subsequent slices
   */
  function hideFixedElements() {
    for (const item of fixedElements) {
      if (item.element && item.element.style) {
        item.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

  /**
   * Restore fixed / sticky elements visibility
   */
  function restoreFixedElements() {
    for (const item of fixedElements) {
      if (item.element && item.element.style) {
        if (item.origVisibility) {
          item.element.style.visibility = item.origVisibility;
        } else {
          item.element.style.removeProperty('visibility');
        }
      }
    }
    fixedElements = [];
  }

  /**
   * Create Floating HUD for Full Page Capture
   */
  function createHud() {
    if (hudElement) return;

    hudElement = document.createElement('div');
    hudElement.id = 'openfullpage-hud';
    hudElement.innerHTML = `
      <div class="openfp-icon">📸</div>
      <div class="openfp-text">Capturing page...</div>
      <div class="openfp-progress-wrap">
        <div class="openfp-progress-bar" id="openfp-pbar"></div>
      </div>
      <div class="openfp-percent" id="openfp-ptext">0%</div>
      <button class="openfp-cancel-btn" id="openfp-cancel-btn">Cancel</button>
    `;

    (document.body || document.documentElement).appendChild(hudElement);

    const cancelBtn = hudElement.querySelector('#openfp-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        isCancelled = true;
        chrome.runtime.sendMessage({ action: 'CANCEL_CAPTURE' });
        finishFullPageCapture();
      });
    }
  }

  /**
   * Update HUD progress
   */
  function updateHudProgress(percent) {
    if (!hudElement) return;
    const bar = hudElement.querySelector('#openfp-pbar');
    const txt = hudElement.querySelector('#openfp-ptext');
    if (bar) bar.style.width = `${percent}%`;
    if (txt) txt.textContent = `${percent}%`;
  }

  /**
   * Destroy HUD
   */
  function removeHud() {
    if (hudElement && hudElement.parentNode) {
      hudElement.parentNode.removeChild(hudElement);
    }
    hudElement = null;
  }

  /**
   * Prepare document for full page screenshot
   */
  function prepareFullPageCapture(options = {}) {
    ensureStyles();
    isCancelled = false;

    // Save initial scroll position
    origScrollX = window.scrollX || window.pageXOffset || 0;
    origScrollY = window.scrollY || window.pageYOffset || 0;

    // Save and hide scrollbars
    origHtmlOverflow = document.documentElement.style.overflow;
    origBodyOverflow = document.body.style.overflow;
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');

    // Find fixed/sticky elements
    if (options.hideFixedElements !== false) {
      fixedElements = findFixedElements();
    }

    // Measure total scrollable dimensions
    const docEl = document.documentElement;
    const body = document.body;

    const totalWidth = Math.max(
      docEl.scrollWidth || 0,
      body.scrollWidth || 0,
      docEl.clientWidth || 0,
      window.innerWidth || 0
    );

    const totalHeight = Math.max(
      docEl.scrollHeight || 0,
      body.scrollHeight || 0,
      docEl.offsetHeight || 0,
      body.offsetHeight || 0,
      docEl.clientHeight || 0,
      window.innerHeight || 0
    );

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    createHud();

    return {
      totalWidth,
      totalHeight,
      viewportWidth,
      viewportHeight,
      devicePixelRatio,
      title: document.title || 'Screenshot',
      url: window.location.href
    };
  }

  /**
   * Scroll page to (x, y) and wait for rendering
   */
  async function scrollToPosition(x, y, hideFixed, progress) {
    if (isCancelled) return { cancelled: true };

    window.scrollTo(x, y);

    if (hideFixed && y > 0) {
      hideFixedElements();
    }

    if (typeof progress === 'number') {
      updateHudProgress(progress);
    }

    // Force reflow and request animation frame
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          resolve({
            actualX: window.scrollX,
            actualY: window.scrollY
          });
        }, 30);
      });
    });
  }

  /**
   * Finish and restore page styles
   */
  function finishFullPageCapture() {
    restoreFixedElements();

    // Restore scrollbars
    if (origHtmlOverflow) {
      document.documentElement.style.overflow = origHtmlOverflow;
    } else {
      document.documentElement.style.removeProperty('overflow');
    }

    if (origBodyOverflow) {
      document.body.style.overflow = origBodyOverflow;
    } else {
      document.body.style.removeProperty('overflow');
    }

    // Restore original scroll
    window.scrollTo(origScrollX, origScrollY);

    removeHud();
    return { success: true };
  }

  /**
   * Selected Area Snipping Tool
   */
  function startAreaSnipping() {
    ensureStyles();

    if (selectOverlayElement) return;

    selectOverlayElement = document.createElement('div');
    selectOverlayElement.id = 'openfullpage-select-overlay';

    const box = document.createElement('div');
    box.id = 'openfullpage-select-box';

    const badge = document.createElement('div');
    badge.id = 'openfullpage-select-badge';
    badge.textContent = '0 × 0 px';

    const actions = document.createElement('div');
    actions.id = 'openfullpage-select-actions';
    actions.innerHTML = `
      <button class="openfp-btn-action openfp-btn-confirm" id="openfp-area-confirm">✔ Capture</button>
      <button class="openfp-btn-action openfp-btn-cancel" id="openfp-area-cancel">✖ Cancel</button>
    `;

    box.appendChild(badge);
    box.appendChild(actions);
    selectOverlayElement.appendChild(box);
    document.body.appendChild(selectOverlayElement);

    let isSelecting = false;
    let startX = 0, startY = 0;
    let currentX = 0, currentY = 0;
    let selectionRect = null;

    const updateBox = () => {
      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      const w = Math.abs(currentX - startX);
      const h = Math.abs(currentY - startY);

      box.style.display = 'block';
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;

      badge.textContent = `${Math.round(w)} × ${Math.round(h)} px`;
      selectionRect = { x, y, width: w, height: h };
    };

    selectOverlayElement.addEventListener('mousedown', (e) => {
      if (e.target.closest('#openfullpage-select-actions')) return;
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      currentX = e.clientX;
      currentY = e.clientY;
      actions.style.display = 'none';
      updateBox();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      currentX = e.clientX;
      currentY = e.clientY;
      updateBox();
    });

    window.addEventListener('mouseup', (e) => {
      if (!isSelecting) return;
      isSelecting = false;
      if (selectionRect && selectionRect.width > 15 && selectionRect.height > 15) {
        actions.style.display = 'flex';
      }
    });

    const cleanup = () => {
      if (selectOverlayElement && selectOverlayElement.parentNode) {
        selectOverlayElement.parentNode.removeChild(selectOverlayElement);
      }
      selectOverlayElement = null;
      window.removeEventListener('keydown', onKeyDown);
    };

    const confirmCapture = () => {
      if (!selectionRect || selectionRect.width < 10 || selectionRect.height < 10) {
        cleanup();
        return;
      }

      const rectData = {
        x: selectionRect.x,
        y: selectionRect.y,
        width: selectionRect.width,
        height: selectionRect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        title: document.title || 'Screenshot',
        url: window.location.href
      };

      cleanup();

      // Small delay for clean screen render
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'CAPTURE_AREA_CONFIRMED',
          rect: rectData
        });
      }, 50);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
      } else if (e.key === 'Enter') {
        confirmCapture();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    actions.querySelector('#openfp-area-confirm').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmCapture();
    });

    actions.querySelector('#openfp-area-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
  }

  /**
   * Element Inspector Capture Tool
   */
  function startElementInspector() {
    ensureStyles();

    if (elementHighlighter) return;

    elementHighlighter = document.createElement('div');
    elementHighlighter.id = 'openfullpage-element-highlighter';

    const badge = document.createElement('div');
    badge.id = 'openfullpage-element-badge';
    elementHighlighter.appendChild(badge);

    const banner = document.createElement('div');
    banner.id = 'openfullpage-element-banner';
    banner.innerHTML = `
      <span>Hover & Click any element to screenshot</span>
      <span class="openfp-kbd">ESC to cancel</span>
    `;

    document.body.appendChild(elementHighlighter);
    document.body.appendChild(banner);

    let hoveredElement = null;

    const onMouseMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === elementHighlighter || target === banner || target.closest('#openfullpage-element-banner')) {
        return;
      }

      hoveredElement = target;
      const rect = target.getBoundingClientRect();

      elementHighlighter.style.display = 'block';
      elementHighlighter.style.top = `${rect.top}px`;
      elementHighlighter.style.left = `${rect.left}px`;
      elementHighlighter.style.width = `${rect.width}px`;
      elementHighlighter.style.height = `${rect.height}px`;

      const tag = target.tagName.toLowerCase();
      const cls = target.className && typeof target.className === 'string' ? '.' + target.className.trim().split(/\s+/)[0] : '';
      badge.textContent = `<${tag}${cls}> ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    };

    const cleanup = () => {
      if (elementHighlighter && elementHighlighter.parentNode) {
        elementHighlighter.parentNode.removeChild(elementHighlighter);
      }
      if (banner && banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
      elementHighlighter = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!hoveredElement) {
        cleanup();
        return;
      }

      const rect = hoveredElement.getBoundingClientRect();
      const rectData = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        title: (document.title || 'Screenshot') + ' - ' + hoveredElement.tagName.toLowerCase(),
        url: window.location.href
      };

      cleanup();

      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'CAPTURE_AREA_CONFIRMED',
          rect: rectData
        });
      }, 60);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown);
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PREPARE_FULL_PAGE') {
      const data = prepareFullPageCapture(message.options);
      sendResponse(data);
      return true;
    }

    if (message.action === 'SCROLL_TO') {
      scrollToPosition(message.x, message.y, message.hideFixed, message.progress).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    if (message.action === 'FINISH_FULL_PAGE') {
      const res = finishFullPageCapture();
      sendResponse(res);
      return true;
    }

    if (message.action === 'START_SELECT_AREA') {
      startAreaSnipping();
      sendResponse({ started: true });
      return true;
    }

    if (message.action === 'START_SELECT_ELEMENT') {
      startElementInspector();
      sendResponse({ started: true });
      return true;
    }
  });
})();
