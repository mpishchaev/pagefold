/**
 * OpenFullPage - Content Script
 * Coordinates page metrics, iframe inspection & scrolling, sticky element suppression,
 * visual capture progress HUD, and area/element snipping tools.
 */

(() => {
  // Guard against double initialization in this frame
  if (window.__OPEN_FULLPAGE_LOADED__) return;
  window.__OPEN_FULLPAGE_LOADED__ = true;

  const isTopFrame = (window === window.top);

  let origScrollX = 0;
  let origScrollY = 0;
  let origHtmlOverflow = '';
  let origBodyOverflow = '';
  let fixedElements = [];
  let expandedIframes = [];
  let protectedIframes = [];
  let activeScrollTarget = null;
  let isCancelled = false;

  // UI elements (top frame only)
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
   * Safe getter for iframe content document
   */
  function getIframeDocument(iframe) {
    try {
      return iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Temporarily auto-expand embedded iframes with internal scrolling
   * so all of their contents render in the main document without cutoffs.
   */
  function autoExpandEmbeddedIframes() {
    expandedIframes = [];
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const frameDoc = getIframeDocument(iframe);
        if (frameDoc && frameDoc.documentElement) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width < 100 || rect.height < 50) continue;

          const frameScrollH = Math.max(
            frameDoc.documentElement.scrollHeight || 0,
            frameDoc.body ? frameDoc.body.scrollHeight : 0
          );

          // If the iframe has internal scroll and is not a 100% full-screen frame
          const isFullScreen = (rect.width >= window.innerWidth * 0.88 && rect.height >= window.innerHeight * 0.88);
          if (frameScrollH > rect.height + 15 && !isFullScreen) {
            expandedIframes.push({
              element: iframe,
              origHeight: iframe.style.height,
              origMaxHeight: iframe.style.maxHeight,
              origOverflow: iframe.style.overflow,
              frameDoc,
              origFrameDocOverflow: frameDoc.documentElement.style.overflow
            });

            iframe.style.setProperty('height', frameScrollH + 'px', 'important');
            iframe.style.setProperty('max-height', 'none', 'important');
            iframe.style.setProperty('overflow', 'hidden', 'important');
            frameDoc.documentElement.style.setProperty('overflow', 'hidden', 'important');
            if (frameDoc.body) {
              frameDoc.body.style.setProperty('overflow', 'hidden', 'important');
            }
          }
        }
      }
    } catch (e) {
      console.warn('Error expanding embedded iframes:', e);
    }
  }

  /**
   * Restore any expanded iframes back to original styles
   */
  function restoreExpandedIframes() {
    for (const item of expandedIframes) {
      try {
        if (item.element && item.element.style) {
          if (item.origHeight) item.element.style.height = item.origHeight;
          else item.element.style.removeProperty('height');

          if (item.origMaxHeight) item.element.style.maxHeight = item.origMaxHeight;
          else item.element.style.removeProperty('max-height');

          if (item.origOverflow) item.element.style.overflow = item.origOverflow;
          else item.element.style.removeProperty('overflow');
        }
        if (item.frameDoc && item.frameDoc.documentElement) {
          if (item.origFrameDocOverflow) item.frameDoc.documentElement.style.overflow = item.origFrameDocOverflow;
          else item.frameDoc.documentElement.style.removeProperty('overflow');
          if (item.frameDoc.body) item.frameDoc.body.style.removeProperty('overflow');
        }
      } catch (e) {}
    }
    expandedIframes = [];
  }

  /**
   * Detect the primary scrollable target on the page.
   * Handles regular window scroll, full-page/large iframes, and inner overflow containers.
   */
  function detectPrimaryScrollTarget() {
    const docEl = document.documentElement;
    const body = document.body;

    const docScrollH = Math.max(
      docEl.scrollHeight || 0,
      body ? body.scrollHeight : 0
    );

    // 1. If standard window scroll has noticeable overflow, use window
    if (docScrollH > window.innerHeight + 25) {
      return {
        type: 'window',
        target: window,
        totalHeight: docScrollH,
        totalWidth: Math.max(docEl.scrollWidth || 0, body ? body.scrollWidth : 0, window.innerWidth),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      };
    }

    // 2. Check if a prominent iframe contains the main scrolling document
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const frameDoc = getIframeDocument(iframe);
      if (frameDoc && frameDoc.documentElement) {
        const rect = iframe.getBoundingClientRect();
        // Check if iframe takes up a significant portion of the screen (>= 60%)
        if (rect.width >= window.innerWidth * 0.6 && rect.height >= window.innerHeight * 0.6) {
          const frameH = Math.max(
            frameDoc.documentElement.scrollHeight || 0,
            frameDoc.body ? frameDoc.body.scrollHeight : 0
          );
          if (frameH > rect.height + 25) {
            return {
              type: 'iframe',
              target: iframe,
              contentWindow: iframe.contentWindow,
              contentDocument: frameDoc,
              totalHeight: frameH,
              totalWidth: Math.max(frameDoc.documentElement.scrollWidth || 0, rect.width),
              viewportHeight: rect.height,
              viewportWidth: rect.width,
              rect
            };
          }
        }
      }
    }

    // 3. Check for inner scrollable HTML element (e.g. single page apps with overflow-y: auto)
    let bestContainer = null;
    let maxScroll = 0;
    const candidates = document.querySelectorAll('main, section, [role="main"], #content, .content, .scrollable, .scroll-container, .app, [class*="scroll"], [class*="main"], div');
    for (const el of candidates) {
      try {
        const style = window.getComputedStyle(el);
        const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll');
        if (canScroll && el.scrollHeight > el.clientHeight + 30) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= window.innerWidth * 0.5 && rect.height >= window.innerHeight * 0.5) {
            if (el.scrollHeight > maxScroll) {
              maxScroll = el.scrollHeight;
              bestContainer = el;
            }
          }
        }
      } catch (e) {}
    }

    if (bestContainer) {
      const rect = bestContainer.getBoundingClientRect();
      return {
        type: 'element',
        target: bestContainer,
        totalHeight: bestContainer.scrollHeight,
        totalWidth: Math.max(bestContainer.scrollWidth, rect.width),
        viewportHeight: rect.height,
        viewportWidth: rect.width,
        rect
      };
    }

    // Fallback: window
    return {
      type: 'window',
      target: window,
      totalHeight: Math.max(docScrollH, window.innerHeight),
      totalWidth: Math.max(docEl.scrollWidth || 0, window.innerWidth),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
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

  function hideFixedElements() {
    for (const item of fixedElements) {
      if (item.element && item.element.style) {
        item.element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

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
   * Floating HUD for Full Page Capture
   */
  function createHud() {
    if (!isTopFrame || hudElement) return;

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

  function updateHudProgress(percent) {
    if (!hudElement) return;
    const bar = hudElement.querySelector('#openfp-pbar');
    const txt = hudElement.querySelector('#openfp-ptext');
    if (bar) bar.style.width = `${percent}%`;
    if (txt) txt.textContent = `${percent}%`;
  }

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

    // 1. Auto-expand embedded iframes so their contents are rendered without cutoffs
    autoExpandEmbeddedIframes();

    // 2. Detect the primary scrollable target (window, full-page iframe, or inner scrollable container)
    activeScrollTarget = detectPrimaryScrollTarget();

    // 3. Save and hide scrollbars
    origHtmlOverflow = document.documentElement.style.overflow;
    origBodyOverflow = document.body.style.overflow;
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');

    // 4. Find fixed/sticky elements
    if (options.hideFixedElements !== false) {
      fixedElements = findFixedElements();
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    createHud();

    return {
      totalWidth: activeScrollTarget.totalWidth,
      totalHeight: activeScrollTarget.totalHeight,
      viewportWidth: activeScrollTarget.viewportWidth,
      viewportHeight: activeScrollTarget.viewportHeight,
      devicePixelRatio,
      scrollTargetType: activeScrollTarget.type,
      title: document.title || 'Screenshot',
      url: window.location.href
    };
  }

  /**
   * Scroll page to (x, y) and wait for rendering
   */
  async function scrollToPosition(x, y, hideFixed, progress) {
    if (isCancelled) return { cancelled: true };

    if (activeScrollTarget && activeScrollTarget.type === 'iframe') {
      if (activeScrollTarget.contentWindow) {
        activeScrollTarget.contentWindow.scrollTo(x, y);
      }
    } else if (activeScrollTarget && activeScrollTarget.type === 'element') {
      activeScrollTarget.target.scrollTop = y;
    } else {
      window.scrollTo(x, y);
    }

    if (hideFixed && y > 0) {
      hideFixedElements();
    }

    if (typeof progress === 'number') {
      updateHudProgress(progress);
    }

    // Force reflow and wait two animation frames for WebGL / A-Frame and dynamic content
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            resolve({
              actualX: window.scrollX,
              actualY: window.scrollY
            });
          }, 35);
        });
      });
    });
  }

  /**
   * Finish and restore page styles
   */
  function finishFullPageCapture() {
    restoreFixedElements();
    restoreExpandedIframes();

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
    if (activeScrollTarget && activeScrollTarget.type === 'iframe' && activeScrollTarget.contentWindow) {
      activeScrollTarget.contentWindow.scrollTo(0, 0);
    } else if (activeScrollTarget && activeScrollTarget.type === 'element') {
      activeScrollTarget.target.scrollTop = 0;
    }
    window.scrollTo(origScrollX, origScrollY);

    activeScrollTarget = null;
    removeHud();
    return { success: true };
  }

  /**
   * Calculate exact viewport-relative screen bounding rectangle for any element,
   * properly accounting for parent iframe offsets if the element is inside an iframe.
   */
  function getElementScreenRect(el) {
    const rect = el.getBoundingClientRect();
    let offsetX = 0;
    let offsetY = 0;

    let doc = el.ownerDocument;
    while (doc && doc !== document) {
      const win = doc.defaultView;
      if (win && win.frameElement) {
        const frameRect = win.frameElement.getBoundingClientRect();
        offsetX += frameRect.left;
        offsetY += frameRect.top;
        doc = win.frameElement.ownerDocument;
      } else {
        break;
      }
    }

    return {
      top: rect.top + offsetY,
      left: rect.left + offsetX,
      bottom: rect.bottom + offsetY,
      right: rect.right + offsetX,
      width: rect.width,
      height: rect.height
    };
  }

  /**
   * Selected Area Snipping Tool
   */
  function startAreaSnipping() {
    if (!isTopFrame) return;
    ensureStyles();

    if (selectOverlayElement) return;

    // Protect cross-origin iframes from capturing mouse events during drag
    protectedIframes = [];
    const allIframes = document.querySelectorAll('iframe');
    for (const iframe of allIframes) {
      try {
        const _ = iframe.contentDocument;
      } catch (e) {
        iframe.dataset.openfpOrigPointer = iframe.style.pointerEvents;
        iframe.style.setProperty('pointer-events', 'none', 'important');
        protectedIframes.push(iframe);
      }
    }

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
      for (const iframe of protectedIframes) {
        if (iframe.dataset.openfpOrigPointer) {
          iframe.style.pointerEvents = iframe.dataset.openfpOrigPointer;
        } else {
          iframe.style.removeProperty('pointer-events');
        }
      }
      protectedIframes = [];

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
   * Recursively inspects same-origin iframes & protects cross-origin iframes
   */
  function startElementInspector() {
    if (!isTopFrame) return;
    ensureStyles();

    if (elementHighlighter) return;

    // Protect cross-origin iframes so hovering over them does not swallow mouse events
    protectedIframes = [];
    const allIframes = document.querySelectorAll('iframe');
    for (const iframe of allIframes) {
      try {
        const _ = iframe.contentDocument;
      } catch (e) {
        iframe.dataset.openfpOrigPointer = iframe.style.pointerEvents;
        iframe.style.setProperty('pointer-events', 'none', 'important');
        protectedIframes.push(iframe);
      }
    }

    elementHighlighter = document.createElement('div');
    elementHighlighter.id = 'openfullpage-element-highlighter';

    const badge = document.createElement('div');
    badge.id = 'openfullpage-element-badge';
    elementHighlighter.appendChild(badge);

    const banner = document.createElement('div');
    banner.id = 'openfullpage-element-banner';
    banner.innerHTML = `
      <span>Hover & Click any element or iframe to screenshot</span>
      <span class="openfp-kbd">ESC to cancel</span>
    `;

    document.body.appendChild(elementHighlighter);
    document.body.appendChild(banner);

    let hoveredElement = null;

    const onMouseMove = (e) => {
      let target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === elementHighlighter || target === banner || target.closest('#openfullpage-element-banner')) {
        return;
      }

      // If hovering over a same-origin iframe, drill down to inspect the inner element inside the iframe!
      let isInsideFrame = false;
      if (target.tagName === 'IFRAME') {
        const frameDoc = getIframeDocument(target);
        if (frameDoc) {
          const frameRect = target.getBoundingClientRect();
          const innerX = e.clientX - frameRect.left;
          const innerY = e.clientY - frameRect.top;
          const innerTarget = frameDoc.elementFromPoint(innerX, innerY);
          if (innerTarget && innerTarget !== frameDoc.documentElement && innerTarget !== frameDoc.body) {
            target = innerTarget;
            isInsideFrame = true;
          }
        }
      }

      hoveredElement = target;
      const rect = getElementScreenRect(target);

      elementHighlighter.style.display = 'block';
      elementHighlighter.style.top = `${rect.top}px`;
      elementHighlighter.style.left = `${rect.left}px`;
      elementHighlighter.style.width = `${rect.width}px`;
      elementHighlighter.style.height = `${rect.height}px`;

      const tag = target.tagName.toLowerCase();
      const cls = target.className && typeof target.className === 'string' ? '.' + target.className.trim().split(/\s+/)[0] : '';
      const prefix = isInsideFrame ? 'iframe ➔ ' : '';
      badge.textContent = `${prefix}<${tag}${cls}> ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    };

    const cleanup = () => {
      for (const iframe of protectedIframes) {
        if (iframe.dataset.openfpOrigPointer) {
          iframe.style.pointerEvents = iframe.dataset.openfpOrigPointer;
        } else {
          iframe.style.removeProperty('pointer-events');
        }
      }
      protectedIframes = [];

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

      const rect = getElementScreenRect(hoveredElement);

      // If clicked element is an iframe with internal scroll, expand it temporarily to capture full content!
      if (hoveredElement.tagName === 'IFRAME') {
        const frameDoc = getIframeDocument(hoveredElement);
        if (frameDoc && frameDoc.documentElement) {
          const frameH = Math.max(frameDoc.documentElement.scrollHeight || 0, frameDoc.body?.scrollHeight || 0);
          if (frameH > rect.height + 25) {
            hoveredElement.style.setProperty('height', frameH + 'px', 'important');
            hoveredElement.style.setProperty('max-height', 'none', 'important');
            hoveredElement.style.setProperty('overflow', 'hidden', 'important');
            rect.height = frameH;
          }
        }
      }

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
      }, 70);
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
