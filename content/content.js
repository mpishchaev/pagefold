/**
 * Pagefold - Content Script
 * Coordinates page metrics, iframe inspection & scrolling, sticky element suppression,
 * visual capture progress HUD, and area/element snipping tools.
 */

(() => {
  // The worker only injects after a failed PING, so an instance found here was
  // orphaned by an extension reload: replace it instead of bailing out.
  try { window.__OPEN_FULLPAGE_DISPOSE__?.(); } catch (e) {}

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
  let savedScrollPositions = [];
  let fixedExcludeTarget = null;
  let captureElement = null;
  let statusTimer = null;

  // UI elements (top frame only)
  let hudElement = null;
  let selectOverlayElement = null;
  let elementHighlighter = null;

  function debugLog(event, data) {
    try {
      chrome.runtime.sendMessage({ action: 'DEBUG_LOG', event, data });
    } catch (e) {}
  }

  /**
   * Short description of an element for the debug log
   */
  function describeElement(el) {
    if (!el) return null;
    const parts = [];
    for (let node = el; node && parts.length < 6; node = getParentAcrossBoundaries(node)) {
      const index = node.parentElement ? [...node.parentElement.children].indexOf(node) + 1 : 0;
      const id = node.id ? `#${node.id}` : '';
      const cls = typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      parts.unshift(`${node.tagName.toLowerCase()}${id}${cls}:${index}`);
    }

    const rect = getElementScreenRect(el);
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return {
      path: parts.join(' > '),
      rect: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
      client: [el.clientWidth, el.clientHeight],
      scroll: [el.scrollWidth, el.scrollHeight, Math.round(el.scrollTop)],
      position: style.position,
      overflow: `${style.overflowX}/${style.overflowY}`,
      pointerEvents: style.pointerEvents,
      transform: style.transform,
      inFrame: el.ownerDocument !== document
    };
  }

  /**
   * Resolve once the browser has painted, so screenshots see the latest DOM.
   * The timeout covers throttled requestAnimationFrame.
   */
  function nextPaint() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 150);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }));
    });
  }

  /**
   * Helper to ensure overlay stylesheet is loaded
   */
  function ensureStyles() {
    if (!document.getElementById('pagefold-style')) {
      const link = document.createElement('link');
      link.id = 'pagefold-style';
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
   * Grow an iframe to its content height; restoreExpandedIframes() undoes this
   */
  function expandIframe(iframe, frameDoc, height) {
    expandedIframes.push({
      element: iframe,
      origHeight: iframe.style.height,
      origMaxHeight: iframe.style.maxHeight,
      origOverflow: iframe.style.overflow,
      frameDoc,
      origFrameDocOverflow: frameDoc.documentElement.style.overflow
    });

    iframe.style.setProperty('height', height + 'px', 'important');
    iframe.style.setProperty('max-height', 'none', 'important');
    iframe.style.setProperty('overflow', 'hidden', 'important');
    frameDoc.documentElement.style.setProperty('overflow', 'hidden', 'important');
    if (frameDoc.body) {
      frameDoc.body.style.setProperty('overflow', 'hidden', 'important');
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
            expandIframe(iframe, frameDoc, frameScrollH);
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
  function isRootScrollable() {
    const htmlOverflow = window.getComputedStyle(document.documentElement).overflowY;
    if (htmlOverflow === 'hidden' || htmlOverflow === 'clip') return false;
    if (htmlOverflow !== 'visible' || !document.body) return true;
    const bodyOverflow = window.getComputedStyle(document.body).overflowY;
    return bodyOverflow !== 'hidden' && bodyOverflow !== 'clip';
  }

  /**
   * Viewport-relative rectangle of a scroller's visible content box
   */
  function getScrollerClip(el) {
    const rect = el.getBoundingClientRect();
    const left = Math.max(0, rect.left + el.clientLeft);
    const top = Math.max(0, rect.top + el.clientTop);
    const right = Math.min(window.innerWidth, rect.left + el.clientLeft + el.clientWidth);
    const bottom = Math.min(window.innerHeight, rect.top + el.clientTop + el.clientHeight);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function detectPrimaryScrollTarget() {
    const docEl = document.documentElement;
    const body = document.body;

    const docScrollH = Math.max(
      docEl.scrollHeight || 0,
      body ? body.scrollHeight : 0
    );

    // 1. If standard window scroll has noticeable overflow, use window
    if (docScrollH > window.innerHeight + 25 && isRootScrollable()) {
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
            const clip = getScrollerClip(iframe);
            return {
              type: 'iframe',
              target: iframe,
              contentWindow: iframe.contentWindow,
              contentDocument: frameDoc,
              totalHeight: frameH,
              totalWidth: clip.width,
              viewportHeight: clip.height,
              viewportWidth: clip.width,
              clip
            };
          }
        }
      }
    }

    // 3. Check for inner scrollable HTML element (e.g. single page apps with overflow-y: auto)
    let bestContainer = null;
    let maxScroll = 0;
    const candidates = document.querySelectorAll('body *');
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
      const clip = getScrollerClip(bestContainer);
      return {
        type: 'element',
        target: bestContainer,
        totalHeight: bestContainer.scrollHeight,
        totalWidth: clip.width,
        viewportHeight: clip.height,
        viewportWidth: clip.width,
        clip
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

  function getParentAcrossBoundaries(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    if (root.host) return root.host;
    try {
      return el.ownerDocument?.defaultView?.frameElement || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Discover elements with position: fixed or sticky
   */
  function findFixedElements(except = null) {
    const list = [];
    // Hiding a wrapper of the captured target would blank the capture itself
    const keep = new Set();
    for (let node = except; node; node = getParentAcrossBoundaries(node)) keep.add(node);
    try {
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.id === 'pagefold-hud' || el.closest('#pagefold-hud')) continue;
        if (keep.has(el) || (except && except.contains(el))) continue;

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
    // Headers often turn fixed only after scrolling, so look for new ones each time
    const known = new Set(fixedElements.map((item) => item.element));
    for (const item of findFixedElements(fixedExcludeTarget)) {
      if (!known.has(item.element)) fixedElements.push(item);
    }

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
    hudElement.id = 'pagefold-hud';
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
   * Hide scrollbars cleanly without breaking window.scrollTo, and turn off
   * smooth scrolling so a scroll has landed by the time the screenshot fires.
   */
  function injectCaptureStyles() {
    if (document.getElementById('pagefold-scrollbar-killer')) return;
    const scrollbarKiller = document.createElement('style');
    scrollbarKiller.id = 'pagefold-scrollbar-killer';
    scrollbarKiller.textContent = `
      ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      * { scrollbar-width: none !important; -ms-overflow-style: none !important; scroll-behavior: auto !important; }
    `;
    (document.head || document.documentElement).appendChild(scrollbarKiller);
  }

  /**
   * Small status line for the time after scrolling, when the page looks idle.
   * Empty text removes it; errors stay until they have been readable for a while.
   */
  function showStatus(text, isError) {
    clearTimeout(statusTimer);
    document.getElementById('pagefold-status')?.remove();
    if (!text) return;

    const status = document.createElement('div');
    status.id = 'pagefold-status';
    status.classList.toggle('openfp-status-error', isError);
    status.textContent = text;
    document.documentElement.appendChild(status);

    if (isError) statusTimer = setTimeout(() => status.remove(), 10000);
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

    // 1. Hide scrollbars and disable smooth scrolling before anything is measured
    injectCaptureStyles();

    // 2. Auto-expand embedded iframes so their contents are rendered without cutoffs
    autoExpandEmbeddedIframes();

    // 3. Detect the primary scrollable target (window, full-page iframe, or inner scrollable container)
    activeScrollTarget = detectPrimaryScrollTarget();
    const scroller = activeScrollTarget.type === 'element'
      ? activeScrollTarget.target
      : activeScrollTarget.contentDocument?.scrollingElement;
    if (scroller) {
      savedScrollPositions = [{ element: scroller, top: scroller.scrollTop, left: scroller.scrollLeft }];
    }

    // 4. Find fixed/sticky elements
    if (options.hideFixedElements !== false) {
      fixedExcludeTarget = activeScrollTarget.type === 'window' ? null : activeScrollTarget.target;
      fixedElements = findFixedElements(fixedExcludeTarget);
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    createHud();

    return {
      totalWidth: activeScrollTarget.totalWidth,
      totalHeight: activeScrollTarget.totalHeight,
      viewportWidth: activeScrollTarget.viewportWidth,
      viewportHeight: activeScrollTarget.viewportHeight,
      clip: activeScrollTarget.clip || null,
      windowWidth: window.innerWidth,
      devicePixelRatio,
      scrollTargetType: activeScrollTarget.type,
      title: document.title || 'Screenshot',
      url: window.location.href
    };
  }

  function getActualScroll() {
    if (activeScrollTarget?.type === 'iframe') {
      return { actualX: activeScrollTarget.contentWindow.scrollX, actualY: activeScrollTarget.contentWindow.scrollY };
    }
    if (activeScrollTarget?.type === 'element') {
      return { actualX: activeScrollTarget.target.scrollLeft, actualY: activeScrollTarget.target.scrollTop };
    }
    return {
      actualX: window.scrollX || document.documentElement?.scrollLeft || 0,
      actualY: window.scrollY || document.documentElement?.scrollTop || 0
    };
  }

  /**
   * Scroll page to (x, y) and wait for rendering
   */
  async function scrollToPosition(x, y, hideFixed, progress) {
    if (isCancelled) return { cancelled: true };

    if (activeScrollTarget && activeScrollTarget.type === 'iframe') {
      if (activeScrollTarget.contentWindow) {
        activeScrollTarget.contentWindow.scrollTo({ left: x, top: y, behavior: 'instant' });
      }
    } else if (activeScrollTarget && activeScrollTarget.type === 'element') {
      activeScrollTarget.target.scrollTop = y;
      activeScrollTarget.target.scrollLeft = x;
    } else {
      window.scrollTo(x, y);
      if (document.documentElement) document.documentElement.scrollTop = y;
      if (document.body) document.body.scrollTop = y;
      if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    }

    if (hideFixed && y > 0) {
      hideFixedElements();
    }

    if (typeof progress === 'number') {
      updateHudProgress(progress);
    }

    // Force reflow and wait for WebGL / dynamic content
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            resolve(getActualScroll());
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

    // Restore original scroll while smooth scrolling is still disabled
    for (const item of savedScrollPositions) {
      item.element.scrollTo({ left: item.left, top: item.top, behavior: 'instant' });
    }
    savedScrollPositions = [];
    window.scrollTo({ left: origScrollX, top: origScrollY, behavior: 'instant' });

    // Remove scrollbar killer style
    const killer = document.getElementById('pagefold-scrollbar-killer');
    if (killer && killer.parentNode) {
      killer.parentNode.removeChild(killer);
    }

    activeScrollTarget = null;
    fixedExcludeTarget = null;
    captureElement = null;
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
        offsetX += frameRect.left + win.frameElement.clientLeft;
        offsetY += frameRect.top + win.frameElement.clientTop;
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
    selectOverlayElement.id = 'pagefold-select-overlay';

    const box = document.createElement('div');
    box.id = 'pagefold-select-box';

    const badge = document.createElement('div');
    badge.id = 'pagefold-select-badge';
    badge.textContent = '0 × 0 px';

    const actions = document.createElement('div');
    actions.id = 'pagefold-select-actions';
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
      if (e.target.closest('#pagefold-select-actions')) return;
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
   * elementFromPoint skips pointer-events: none, which is how Bootstrap's
   * .modal-dialog gets lost between its content and the backdrop. Find such an
   * element below the hit, but only if it paints something: most of them are
   * transparent layout wrappers that must stay click-through.
   */
  function findPassThroughChild(el, x, y) {
    let found = null;
    for (const child of el.children) {
      const rect = child.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

      const style = child.ownerDocument.defaultView.getComputedStyle(child);
      if (style.pointerEvents !== 'none' || style.visibility !== 'visible' || style.opacity === '0') continue;

      const hasBackground = style.backgroundImage !== 'none'
        || !/^(transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor);
      found = findPassThroughChild(child, x, y) || (hasBackground ? child : found);
    }
    return found;
  }

  /**
   * Deepest element at a viewport point, looking through open shadow roots
   * and same-origin iframes.
   */
  function deepElementFromPoint(root, x, y) {
    let el = root.elementFromPoint(x, y);

    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }

    if (el?.tagName === 'IFRAME') {
      const frameDoc = getIframeDocument(el);
      if (frameDoc) {
        const frameRect = el.getBoundingClientRect();
        const inner = deepElementFromPoint(frameDoc, x - frameRect.left - el.clientLeft, y - frameRect.top - el.clientTop);
        if (inner && inner !== frameDoc.documentElement && inner !== frameDoc.body) return inner;
      }
    }
    return el ? findPassThroughChild(el, x, y) || el : el;
  }

  /**
   * Scrollable ancestors of an element, innermost first. Scrolling stops
   * mattering at a fixed ancestor: nothing above it moves the element.
   */
  function getScrollParents(el) {
    const list = [];
    let node = el;
    while (node) {
      const doc = node.ownerDocument;
      const view = doc.defaultView;
      const style = view.getComputedStyle(node);
      if (node !== el && (node === doc.scrollingElement
        || (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(style.overflowY)))) {
        list.push(node);
      }
      if (style.position === 'fixed') break;
      node = getParentAcrossBoundaries(node);
    }
    return list;
  }

  /**
   * Part of an element that can currently be seen, in top-level viewport
   * coordinates: the viewport intersected with every clipping ancestor.
   */
  function getVisibleElementRect(el) {
    const rect = getElementScreenRect(el);
    const box = {
      top: Math.max(rect.top, 0),
      left: Math.max(rect.left, 0),
      bottom: Math.min(rect.bottom, window.innerHeight),
      right: Math.min(rect.right, window.innerWidth)
    };

    for (let node = getParentAcrossBoundaries(el); node; node = getParentAcrossBoundaries(node)) {
      const doc = node.ownerDocument;
      if (node === doc.documentElement || node === doc.body) continue;
      const style = doc.defaultView.getComputedStyle(node);
      if (node.tagName === 'IFRAME' || style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const clip = getElementScreenRect(node);
        box.top = Math.max(box.top, clip.top + node.clientTop);
        box.left = Math.max(box.left, clip.left + node.clientLeft);
        box.bottom = Math.min(box.bottom, clip.top + node.clientTop + node.clientHeight);
        box.right = Math.min(box.right, clip.left + node.clientLeft + node.clientWidth);
      }
      if (style.position === 'fixed') break;
    }
    return { rect, box };
  }

  /**
   * Bring the row at `offsetY` inside the element to the top of its scrollers
   */
  function scrollElementRowIntoView(el, offsetY) {
    for (const scroller of getScrollParents(el)) {
      const doc = scroller.ownerDocument;
      const isRoot = scroller === doc.scrollingElement;
      const frame = isRoot ? doc.defaultView.frameElement : scroller;
      const anchor = frame ? getElementScreenRect(frame) : { top: 0, left: 0, right: window.innerWidth };
      const rect = getElementScreenRect(el);
      const dx = (rect.left < anchor.left || rect.right > anchor.right) ? rect.left - anchor.left : 0;
      scroller.scrollTo({
        top: scroller.scrollTop + rect.top + offsetY - anchor.top,
        left: scroller.scrollLeft + dx,
        behavior: 'instant'
      });
    }
  }

  /**
   * An element with its own scrollbar hides most of its content from a plain
   * capture, so it is scrolled from the inside instead
   */
  function hasOwnScroll(el) {
    return el.scrollHeight > el.clientHeight + 1
      && /auto|scroll/.test(el.ownerDocument.defaultView.getComputedStyle(el).overflowY);
  }

  /**
   * Prepare the picked element for a (possibly multi-screen) capture
   */
  function prepareElementCapture(options = {}) {
    const el = captureElement;
    if (!el || !el.isConnected) throw new Error('Selected element is no longer on the page');

    origScrollX = window.scrollX || 0;
    origScrollY = window.scrollY || 0;
    injectCaptureStyles();

    const scrollers = hasOwnScroll(el) ? [el, ...getScrollParents(el)] : getScrollParents(el);
    savedScrollPositions = scrollers.map((element) => ({
      element,
      top: element.scrollTop,
      left: element.scrollLeft
    }));

    // A picked iframe shows all of its content, not just its scrolled window
    if (el.tagName === 'IFRAME') {
      const frameDoc = getIframeDocument(el);
      if (frameDoc?.documentElement) {
        const frameH = Math.max(frameDoc.documentElement.scrollHeight || 0, frameDoc.body?.scrollHeight || 0);
        if (frameH > el.clientHeight + 25) expandIframe(el, frameDoc, frameH);
      }
    }

    if (options.hideFixedElements !== false) {
      fixedExcludeTarget = el;
      hideFixedElements();
    }

    const rect = getElementScreenRect(el);
    return {
      totalWidth: rect.width,
      totalHeight: hasOwnScroll(el) ? el.scrollHeight : rect.height,
      windowWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  /**
   * Same as showElementSlice, for an element that scrolls its own content
   */
  async function showSelfScrollingSlice(el, offsetY) {
    const clientBox = () => {
      const { rect, box } = getVisibleElementRect(el);
      const top = rect.top + el.clientTop;
      const left = rect.left + el.clientLeft;
      return {
        fits: box.top <= top && box.bottom >= top + el.clientHeight,
        top: Math.max(box.top, top),
        left: Math.max(box.left, left),
        bottom: Math.min(box.bottom, top + el.clientHeight),
        right: Math.min(box.right, left + el.clientWidth)
      };
    };

    el.scrollTo({ top: offsetY, behavior: 'instant' });
    let box = clientBox();
    if (!box.fits) {
      scrollElementRowIntoView(el, 0);
      box = clientBox();
    }

    await nextPaint();

    const clip = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    if (clip.width <= 0 || clip.height <= 0) {
      throw new Error('Selected element is not visible on the page');
    }
    const y = el.scrollTop;
    return { clip, y, scrolled: true, done: y + clip.height >= el.scrollHeight - 0.5 };
  }

  /**
   * Show the next uncaptured part of the element and report where it is.
   * `y` is the offset of the visible part inside the element.
   */
  async function showElementSlice(offsetY) {
    const el = captureElement;
    if (hasOwnScroll(el)) return showSelfScrollingSlice(el, offsetY);

    let { rect, box } = getVisibleElementRect(el);
    let scrolled = false;

    // Leave the page alone when the element already fits on screen
    const fits = box.top <= rect.top && box.bottom >= rect.bottom && box.left <= rect.left && box.right >= rect.right;
    if (!fits || offsetY > 0) {
      scrollElementRowIntoView(el, offsetY);
      scrolled = true;
      ({ rect, box } = getVisibleElementRect(el));
    }

    await nextPaint();

    const clip = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    if (clip.width <= 0 || clip.height <= 0) {
      throw new Error('Selected element is not visible on the page');
    }
    const y = box.top - rect.top;
    return { clip, y, scrolled, done: y + clip.height >= rect.height - 0.5 };
  }

  /**
   * Element Inspector Capture Tool
   * A transparent shield takes every pointer event, so iframes cannot swallow
   * them and the page does not react to hovering or clicking while picking.
   */
  function startElementInspector() {
    if (!isTopFrame) return;
    ensureStyles();

    if (elementHighlighter) return;

    const shield = document.createElement('div');
    shield.id = 'pagefold-element-shield';

    elementHighlighter = document.createElement('div');
    elementHighlighter.id = 'pagefold-element-highlighter';

    const badge = document.createElement('div');
    badge.id = 'pagefold-element-badge';
    elementHighlighter.appendChild(badge);

    const banner = document.createElement('div');
    banner.id = 'pagefold-element-banner';
    banner.innerHTML = `
      <span>Click an element to capture it</span>
      <span class="openfp-kbd">↑ ↓ parent / child</span>
      <span class="openfp-kbd">ESC to cancel</span>
    `;

    // A modal <dialog> makes everything outside of it inert, so the picker has to
    // live inside. Otherwise outside of body: a transformed body would turn
    // position: fixed into absolute. The top layer puts it above any z-index.
    const openDialogs = [...document.querySelectorAll('dialog')].filter((dialog) => dialog.matches(':modal'));
    const host = openDialogs[openDialogs.length - 1] || document.documentElement;
    for (const part of [shield, elementHighlighter, banner]) {
      part.popover = 'manual';
      host.append(part);
      part.showPopover();
    }

    let selected = null;
    let hitElement = null;
    let childTrail = []; // elements stepped out of with ArrowUp
    let mouseX = 0;
    let mouseY = 0;
    const recentHits = []; // for the debug log: what the cursor went through

    const logSelection = (event) => {
      debugLog(event, {
        element: describeElement(selected),
        stepsUp: childTrail.length,
        pointer: [mouseX, mouseY],
        recentHits,
        pickerHost: host.tagName,
        viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio, window.scrollX, window.scrollY],
        rootOverflow: [document.documentElement, document.body].map((node) => window.getComputedStyle(node).overflowY)
      });
    };

    const hitTest = () => {
      shield.style.setProperty('pointer-events', 'none', 'important');
      const el = deepElementFromPoint(document, mouseX, mouseY);
      shield.style.removeProperty('pointer-events');
      return el;
    };

    const render = () => {
      if (!selected) return;
      const rect = getElementScreenRect(selected);

      elementHighlighter.style.display = 'block';
      elementHighlighter.style.top = `${rect.top}px`;
      elementHighlighter.style.left = `${rect.left}px`;
      elementHighlighter.style.width = `${rect.width}px`;
      elementHighlighter.style.height = `${rect.height}px`;

      // Keep the label on screen for elements touching or crossing the top edge
      const badgeTop = rect.top < 28 ? Math.max(4, 4 - rect.top) : -26;
      badge.style.setProperty('top', `${badgeTop}px`, 'important');

      const tag = selected.tagName.toLowerCase();
      const cls = typeof selected.className === 'string' && selected.className.trim()
        ? '.' + selected.className.trim().split(/\s+/)[0]
        : '';
      const prefix = selected.ownerDocument !== document ? 'iframe ➔ ' : '';
      badge.textContent = `${prefix}<${tag}${cls}> ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    };

    const updateFromPointer = () => {
      const hit = hitTest();
      if (!hit || hit === hitElement) return;
      hitElement = hit;
      selected = hit;
      childTrail = [];
      recentHits.push(describeElement(hit).path.split(' > ').slice(-2).join(' > '));
      if (recentHits.length > 25) recentHits.shift();
      render();
    };

    const onMouseMove = (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      updateFromPointer();
    };

    // The element under a still cursor changes while the page scrolls
    const onScroll = () => {
      if (childTrail.length === 0) updateFromPointer();
      render();
    };

    // The shield is not inside the page's scrollers, so wheel only reaches the root
    const onWheel = (e) => {
      if (!selected) return;
      const scroller = getScrollParents(selected).find((el) => el !== el.ownerDocument.scrollingElement);
      if (!scroller) return;
      e.preventDefault();
      scroller.scrollBy({ left: e.deltaX, top: e.deltaY, behavior: 'instant' });
    };

    const onMouseDown = (e) => {
      e.preventDefault();
    };

    const cleanup = () => {
      shield.remove();
      banner.remove();
      elementHighlighter?.remove();
      elementHighlighter = null;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', render);
    };

    const confirmSelection = async () => {
      if (!selected) {
        cleanup();
        return;
      }

      logSelection('element-confirmed');
      captureElement = selected;
      const title = (document.title || 'Screenshot') + ' - ' + selected.tagName.toLowerCase();
      cleanup();
      await nextPaint();

      chrome.runtime.sendMessage({
        action: 'CAPTURE_ELEMENT_CONFIRMED',
        meta: { title, url: window.location.href }
      });
    };

    const onKeyDown = (e) => {
      if (!['Escape', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        logSelection('element-cancelled');
        cleanup();
      } else if (e.key === 'Enter') {
        confirmSelection();
      } else if (e.key === 'ArrowUp' && selected) {
        const parent = getParentAcrossBoundaries(selected);
        if (parent && parent !== document.documentElement) {
          childTrail.push(selected);
          selected = parent;
          render();
        }
      } else if (e.key === 'ArrowDown' && childTrail.length > 0) {
        selected = childTrail.pop();
        render();
      }
    };

    shield.addEventListener('mousemove', onMouseMove);
    shield.addEventListener('mousedown', onMouseDown);
    shield.addEventListener('click', confirmSelection);
    shield.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', render);
  }

  // Listen for messages from background script
  const onMessage = (message, sender, sendResponse) => {
    if (message.action === 'PING') {
      sendResponse({ pong: true, isTopFrame });
      return true;
    }

    // Capture orchestration must only be processed by the top-level main frame
    if (!isTopFrame) {
      return false;
    }

    if (message.action === 'PREPARE_FULL_PAGE') {
      try {
        const data = prepareFullPageCapture(message.options);
        sendResponse(data);
      } catch (err) {
        console.error('PREPARE_FULL_PAGE error:', err);
        sendResponse({
          totalWidth: window.innerWidth,
          totalHeight: Math.max(document.documentElement?.scrollHeight || 0, window.innerHeight),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollTargetType: 'window',
          title: document.title || 'Screenshot',
          url: window.location.href
        });
      }
      return true;
    }

    if (message.action === 'SCROLL_TO') {
      scrollToPosition(message.x, message.y, message.hideFixed, message.progress).then((res) => {
        sendResponse(res);
      }).catch((err) => {
        sendResponse({ error: err?.message || 'Scroll failed' });
      });
      return true;
    }

    if (message.action === 'FINISH_FULL_PAGE') {
      try {
        const res = finishFullPageCapture();
        sendResponse(res);
      } catch (e) {
        sendResponse({ success: true });
      }
      return true;
    }

    if (message.action === 'SHOW_STATUS') {
      showStatus(message.text, message.isError);
      sendResponse({ shown: true });
      return true;
    }

    if (message.action === 'PREPARE_ELEMENT') {
      try {
        sendResponse(prepareElementCapture(message.options));
      } catch (err) {
        sendResponse({ error: err?.message || 'Element capture failed' });
      }
      return true;
    }

    if (message.action === 'SHOW_ELEMENT_SLICE') {
      showElementSlice(message.offsetY).then(sendResponse).catch((err) => {
        sendResponse({ error: err?.message || 'Element capture failed' });
      });
      return true;
    }

    if (message.action === 'BEFORE_SNAP') {
      if (!hudElement) {
        sendResponse({ hidden: true });
        return;
      }
      hudElement.style.setProperty('visibility', 'hidden', 'important');
      // Two rAFs do not mean the browser has the new frame yet. Later slices get
      // time from the captureVisibleTab pacing; the first one does not, so wait.
      nextPaint().then(() => setTimeout(() => sendResponse({ hidden: true }), 100));
      return true;
    }

    if (message.action === 'AFTER_SNAP') {
      if (hudElement) {
        hudElement.style.removeProperty('visibility');
      }
      sendResponse({ restored: true });
      return;
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
  };

  chrome.runtime.onMessage.addListener(onMessage);
  window.__OPEN_FULLPAGE_DISPOSE__ = () => chrome.runtime.onMessage.removeListener(onMessage);
})();
