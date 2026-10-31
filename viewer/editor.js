/**
 * OpenFullPage - In-Browser Photo & Screenshot Editor
 * 100% Free - Includes all premium GoFullPage features:
 * Crop, Redact/Pixelate, Arrows, Shapes, Text, Step Numbers, Highlighter, Pen.
 */

export class ScreenshotEditor {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;

    // Canvases
    this.baseCanvas = document.createElement('canvas');
    this.baseCtx = this.baseCanvas.getContext('2d');

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    // Canvas container for zoom & pan
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'editor-canvas-wrapper';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.display = 'inline-block';
    this.wrapper.appendChild(this.baseCanvas);
    this.wrapper.appendChild(this.overlayCanvas);

    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.pointerEvents = 'auto';

    this.container.appendChild(this.wrapper);

    // Active Tool & Style State
    this.activeTool = 'select'; // 'select' | 'crop' | 'redact' | 'pen' | 'highlighter' | 'arrow' | 'rect' | 'circle' | 'line' | 'text' | 'step' | 'sticker'
    this.color = '#ef4444'; // default red
    this.strokeWidth = 4;
    this.fontSize = 22;
    this.fillShapes = false;
    this.pixelateSize = 16;
    this.currentStep = 1;
    this.selectedSticker = '✔';

    // Image & History State
    this.originalImage = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndo = 30;

    // Annotations list (objects)
    this.annotations = [];
    this.selectedAnnotation = null;

    // Interaction State
    this.isDrawing = false;
    this.startX = 0;
    this.startY = 0;
    this.currentX = 0;
    this.currentY = 0;
    this.activePath = [];

    // Crop State
    this.cropRect = null; // { x, y, width, height }
    this.isCropping = false;
    this.activeCropHandle = null;
    this.cropStartRect = null;
    this.cropStartX = 0;
    this.cropStartY = 0;
    this.cropAspectRatio = null; // null | 1 | 16/9 | 4/3

    // Setup event listeners
    this.initEvents();
  }

  /**
   * Load an image into the editor
   */
  async loadImage(imageSource) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.originalImage = img;
        this.resetToImage(img);
        resolve(true);
      };
      img.onerror = reject;
      img.src = typeof imageSource === 'string' ? imageSource : imageSource.toDataURL('image/png');
    });
  }

  resetToImage(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    this.baseCanvas.width = w;
    this.baseCanvas.height = h;
    this.overlayCanvas.width = w;
    this.overlayCanvas.height = h;

    this.baseCtx.clearRect(0, 0, w, h);
    this.baseCtx.drawImage(img, 0, 0, w, h);

    this.annotations = [];
    this.selectedAnnotation = null;
    this.currentStep = 1;
    this.undoStack = [];
    this.redoStack = [];

    this.saveState();
    this.renderOverlay();
  }

  /**
   * Save canvas & annotations state for Undo/Redo
   */
  saveState() {
    const baseSnapshot = this.baseCtx.getImageData(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    const state = {
      baseData: baseSnapshot,
      width: this.baseCanvas.width,
      height: this.baseCanvas.height,
      annotations: JSON.parse(JSON.stringify(this.annotations)),
      currentStep: this.currentStep
    };

    this.undoStack.push(state);
    if (this.undoStack.length > this.maxUndo) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.notifyChange();
  }

  undo() {
    if (this.undoStack.length <= 1) return;
    const current = this.undoStack.pop();
    this.redoStack.push(current);

    const prev = this.undoStack[this.undoStack.length - 1];
    this.restoreState(prev);
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const next = this.redoStack.pop();
    this.undoStack.push(next);
    this.restoreState(next);
  }

  restoreState(state) {
    this.baseCanvas.width = state.width;
    this.baseCanvas.height = state.height;
    this.overlayCanvas.width = state.width;
    this.overlayCanvas.height = state.height;

    this.baseCtx.putImageData(state.baseData, 0, 0);
    this.annotations = JSON.parse(JSON.stringify(state.annotations));
    this.currentStep = state.currentStep;
    this.selectedAnnotation = null;

    this.renderOverlay();
    this.notifyChange();
  }

  notifyChange() {
    if (typeof this.options.onChange === 'function') {
      this.options.onChange({
        canUndo: this.undoStack.length > 1,
        canRedo: this.redoStack.length > 0,
        width: this.baseCanvas.width,
        height: this.baseCanvas.height
      });
    }
  }

  setTool(tool) {
    if (this.isCropping && tool !== 'crop') {
      this.cancelCrop();
    }
    this.activeTool = tool;

    if (tool === 'crop') {
      this.startCrop();
    } else {
      this.isCropping = false;
      this.cropRect = null;
    }

    this.renderOverlay();
  }

  setColor(color) {
    this.color = color;
    if (this.selectedAnnotation) {
      this.selectedAnnotation.color = color;
      this.renderOverlay();
    }
  }

  setStrokeWidth(w) {
    this.strokeWidth = parseInt(w, 10);
  }

  setFontSize(size) {
    this.fontSize = parseInt(size, 10);
  }

  setFillShapes(fill) {
    this.fillShapes = !!fill;
  }

  setSticker(sticker) {
    this.selectedSticker = sticker;
  }

  /**
   * Event Handlers
   */
  initEvents() {
    const getPos = (e) => {
      const rect = this.overlayCanvas.getBoundingClientRect();
      const scaleX = rect.width > 0 ? (this.overlayCanvas.width / rect.width) : 1;
      const scaleY = rect.height > 0 ? (this.overlayCanvas.height / rect.height) : 1;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

    // Update cursor when hovering over crop handles
    this.overlayCanvas.addEventListener('mousemove', (e) => {
      if (this.isDrawing || this.activeTool !== 'crop' || !this.cropRect) return;
      const pos = getPos(e);
      const handle = this.getCropHitHandle(pos);

      const cursorMap = {
        nw: 'nwse-resize',
        se: 'nwse-resize',
        ne: 'nesw-resize',
        sw: 'nesw-resize',
        n: 'ns-resize',
        s: 'ns-resize',
        w: 'ew-resize',
        e: 'ew-resize',
        move: 'move',
        new: 'crosshair'
      };

      this.overlayCanvas.style.cursor = cursorMap[handle] || 'default';
    });

    this.overlayCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const pos = getPos(e);
      this.isDrawing = true;
      this.startX = pos.x;
      this.startY = pos.y;
      this.currentX = pos.x;
      this.currentY = pos.y;

      if (this.activeTool === 'crop') {
        this.handleCropMouseDown(pos);
        return;
      }

      if (this.activeTool === 'pen' || this.activeTool === 'highlighter') {
        this.activePath = [{ x: pos.x, y: pos.y }];
      } else if (this.activeTool === 'text') {
        this.promptText(pos.x, pos.y);
        this.isDrawing = false;
      } else if (this.activeTool === 'step') {
        this.addStepBadge(pos.x, pos.y);
        this.isDrawing = false;
      } else if (this.activeTool === 'sticker') {
        this.addSticker(pos.x, pos.y);
        this.isDrawing = false;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDrawing) return;
      const pos = getPos(e);
      this.currentX = pos.x;
      this.currentY = pos.y;

      if (this.activeTool === 'crop') {
        this.handleCropMouseMove(pos);
        return;
      }

      if (this.activeTool === 'pen' || this.activeTool === 'highlighter') {
        this.activePath.push({ x: pos.x, y: pos.y });
        this.renderOverlay();
      } else if (['arrow', 'rect', 'circle', 'line', 'redact'].includes(this.activeTool)) {
        this.renderOverlay();
        this.renderLivePreview(this.overlayCtx);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;

      if (this.activeTool === 'crop') {
        this.handleCropMouseUp();
        return;
      }

      const dx = Math.abs(this.currentX - this.startX);
      const dy = Math.abs(this.currentY - this.startY);

      if (this.activeTool === 'pen' || this.activeTool === 'highlighter') {
        if (this.activePath.length > 1) {
          this.annotations.push({
            type: this.activeTool,
            points: this.activePath,
            color: this.color,
            width: this.activeTool === 'highlighter' ? this.strokeWidth * 3 : this.strokeWidth,
            opacity: this.activeTool === 'highlighter' ? 0.45 : 1
          });
          this.saveState();
        }
        this.activePath = [];
      } else if (this.activeTool === 'redact') {
        if (dx > 4 && dy > 4) {
          this.applyPixelate(
            Math.min(this.startX, this.currentX),
            Math.min(this.startY, this.currentY),
            dx,
            dy,
            this.pixelateSize
          );
          this.saveState();
        }
      } else if (['arrow', 'rect', 'circle', 'line'].includes(this.activeTool)) {
        if (dx > 4 || dy > 4) {
          this.annotations.push({
            type: this.activeTool,
            x1: this.startX,
            y1: this.startY,
            x2: this.currentX,
            y2: this.currentY,
            color: this.color,
            width: this.strokeWidth,
            filled: this.fillShapes
          });
          this.saveState();
        }
      }

      this.renderOverlay();
    });

    // Keyboard Shortcuts (Ctrl+Z, Ctrl+Y, Esc)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (e.key === 'Escape') {
        if (this.isCropping) {
          this.cancelCrop();
        }
      }
    });
  }

  /**
   * Pixelate / Redact sensitive information
   */
  applyPixelate(x, y, width, height, blockSize = 16) {
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    width = Math.min(this.baseCanvas.width - x, Math.ceil(width));
    height = Math.min(this.baseCanvas.height - y, Math.ceil(height));

    if (width <= 0 || height <= 0) return;

    const imgData = this.baseCtx.getImageData(x, y, width, height);
    const data = imgData.data;

    for (let by = 0; by < height; by += blockSize) {
      for (let bx = 0; bx < width; bx += blockSize) {
        let r = 0, g = 0, b = 0, count = 0;
        const bw = Math.min(blockSize, width - bx);
        const bh = Math.min(blockSize, height - by);

        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const idx = ((by + py) * width + (bx + px)) * 4;
            r += data[idx];
            g += data[idx + 1];
            b += data[idx + 2];
            count++;
          }
        }

        r = Math.floor(r / count);
        g = Math.floor(g / count);
        b = Math.floor(b / count);

        for (let py = 0; py < bh; py++) {
          for (let px = 0; px < bw; px++) {
            const idx = ((by + py) * width + (bx + px)) * 4;
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
          }
        }
      }
    }

    this.baseCtx.putImageData(imgData, x, y);
  }

  /**
   * Step badge counter (1, 2, 3...)
   */
  addStepBadge(x, y) {
    this.annotations.push({
      type: 'step',
      x,
      y,
      step: this.currentStep,
      color: this.color,
      radius: Math.max(16, this.strokeWidth * 4)
    });
    this.currentStep++;
    this.saveState();
    this.renderOverlay();
  }

  /**
   * Sticker / Icon stamp
   */
  addSticker(x, y) {
    this.annotations.push({
      type: 'sticker',
      x,
      y,
      text: this.selectedSticker,
      fontSize: Math.max(28, this.strokeWidth * 6)
    });
    this.saveState();
    this.renderOverlay();
  }

  /**
   * Text annotation
   */
  promptText(x, y) {
    const text = window.prompt('Enter annotation text:', '');
    if (text && text.trim()) {
      this.annotations.push({
        type: 'text',
        x,
        y,
        text: text.trim(),
        color: this.color,
        fontSize: this.fontSize,
        bg: true
      });
      this.saveState();
      this.renderOverlay();
    }
  }

  /**
   * Helper: Get current scale ratio between canvas internal pixels and screen pixels
   */
  getScaleRatio() {
    const rect = this.overlayCanvas.getBoundingClientRect();
    return rect.width > 0 ? (this.overlayCanvas.width / rect.width) : 1;
  }

  /**
   * Helper: Normalize rectangle to positive width/height
   */
  normalizeRect(r) {
    if (!r) return { x: 0, y: 0, width: 0, height: 0 };
    let { x, y, width, height } = r;
    if (width < 0) {
      x += width;
      width = Math.abs(width);
    }
    if (height < 0) {
      y += height;
      height = Math.abs(height);
    }
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    };
  }

  /**
   * Helper: Hit-test mouse position against crop handles, box interior, or outside
   */
  getCropHitHandle(pos) {
    if (!this.cropRect) return 'new';
    const norm = this.normalizeRect(this.cropRect);
    const scaleRatio = this.getScaleRatio();
    // Hit distance in canvas units: ~18 screen pixels
    const hitDist = Math.max(12, Math.round(18 * scaleRatio));

    const handles = {
      nw: { x: norm.x, y: norm.y },
      ne: { x: norm.x + norm.width, y: norm.y },
      se: { x: norm.x + norm.width, y: norm.y + norm.height },
      sw: { x: norm.x, y: norm.y + norm.height },
      n:  { x: norm.x + norm.width / 2, y: norm.y },
      s:  { x: norm.x + norm.width / 2, y: norm.y + norm.height },
      w:  { x: norm.x, y: norm.y + norm.height / 2 },
      e:  { x: norm.x + norm.width, y: norm.y + norm.height / 2 }
    };

    for (const [name, pt] of Object.entries(handles)) {
      if (Math.hypot(pos.x - pt.x, pos.y - pt.y) <= hitDist) {
        return name;
      }
    }

    if (pos.x >= norm.x && pos.x <= norm.x + norm.width &&
        pos.y >= norm.y && pos.y <= norm.y + norm.height) {
      return 'move';
    }

    return 'new';
  }

  /**
   * Crop Mode
   */
  startCrop() {
    this.isCropping = true;
    const padX = Math.round(this.baseCanvas.width * 0.05);
    const padY = Math.round(this.baseCanvas.height * 0.05);
    this.cropRect = {
      x: padX,
      y: padY,
      width: Math.max(20, this.baseCanvas.width - padX * 2),
      height: Math.max(20, this.baseCanvas.height - padY * 2)
    };
    if (this.cropAspectRatio) {
      this.applyCropAspectRatio();
    }
    this.renderOverlay();
  }

  setCropAspectRatio(ratio) {
    this.cropAspectRatio = ratio;
    if (this.cropRect && ratio) {
      this.applyCropAspectRatio();
      this.renderOverlay();
    }
  }

  applyCropAspectRatio() {
    if (!this.cropRect || !this.cropAspectRatio) return;
    const ratio = this.cropAspectRatio;
    const norm = this.normalizeRect(this.cropRect);
    let w = norm.width;
    let h = Math.round(w / ratio);

    if (norm.y + h > this.baseCanvas.height) {
      h = this.baseCanvas.height - norm.y;
      w = Math.round(h * ratio);
    }
    if (norm.x + w > this.baseCanvas.width) {
      w = this.baseCanvas.width - norm.x;
      h = Math.round(w / ratio);
    }

    this.cropRect = {
      x: norm.x,
      y: norm.y,
      width: Math.max(10, w),
      height: Math.max(10, h)
    };
  }

  applyCrop() {
    if (!this.cropRect) return null;

    const norm = this.normalizeRect(this.cropRect);
    let { x, y, width, height } = norm;

    x = Math.max(0, Math.round(x));
    y = Math.max(0, Math.round(y));
    width = Math.min(this.baseCanvas.width - x, Math.round(width));
    height = Math.min(this.baseCanvas.height - y, Math.round(height));

    if (width < 5 || height < 5) return null;

    // Merge base + annotations into temporary canvas to crop everything uniformly
    const merged = this.getMergedCanvas();
    const cropped = document.createElement('canvas');
    cropped.width = width;
    cropped.height = height;

    const ctx = cropped.getContext('2d');
    ctx.drawImage(
      merged,
      x, y, width, height,
      0, 0, width, height
    );

    this.baseCanvas.width = width;
    this.baseCanvas.height = height;
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;

    this.baseCtx.clearRect(0, 0, width, height);
    this.baseCtx.drawImage(cropped, 0, 0);

    this.annotations = [];
    this.isCropping = false;
    this.cropRect = null;
    this.activeTool = 'select';
    this.overlayCanvas.style.cursor = 'default';

    this.saveState();
    this.renderOverlay();

    return { width, height };
  }

  cancelCrop() {
    this.isCropping = false;
    this.cropRect = null;
    this.activeTool = 'select';
    this.overlayCanvas.style.cursor = 'default';
    this.renderOverlay();
  }

  /**
   * Smart Content Bounds Detection
   * Automatically isolates the primary content column and rows by trimming uniform background
   * while intelligently ignoring full-width stretched headers, footers, and divider rules.
   *
   * @param {number} padding Margin padding in pixels (default: 15)
   * @returns {Object|null} { cropX, cropY, cropW, cropH, minX, maxX, minY, maxY, bg }
   */
  detectContentBounds(padding = 15) {
    const width = this.baseCanvas.width;
    const height = this.baseCanvas.height;
    if (width < 30 || height < 30) return null;

    const imgData = this.baseCtx.getImageData(0, 0, width, height);
    const data = imgData.data;

    // 1. Detect Background Color
    // Sample along left and right margins and corners
    const borderSamples = [];
    const sampleStepY = Math.max(1, Math.floor(height / 60));
    const sampleInset = Math.min(6, Math.floor(width / 10));

    for (let y = 0; y < height; y += sampleStepY) {
      for (let dx = 0; dx < sampleInset; dx++) {
        // Left margin
        const idxL = (y * width + dx) * 4;
        borderSamples.push([data[idxL], data[idxL + 1], data[idxL + 2], data[idxL + 3]]);
        // Right margin
        const idxR = (y * width + (width - 1 - dx)) * 4;
        borderSamples.push([data[idxR], data[idxR + 1], data[idxR + 2], data[idxR + 3]]);
      }
    }

    if (borderSamples.length === 0) return null;

    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    for (let i = 0; i < borderSamples.length; i++) {
      sumR += borderSamples[i][0];
      sumG += borderSamples[i][1];
      sumB += borderSamples[i][2];
      sumA += borderSamples[i][3];
    }
    const bgR = Math.round(sumR / borderSamples.length);
    const bgG = Math.round(sumG / borderSamples.length);
    const bgB = Math.round(sumB / borderSamples.length);
    const bgA = Math.round(sumA / borderSamples.length);

    const isBgTransparent = (bgA < 30);
    const colorDist = (r, g, b, a) => {
      if (isBgTransparent) {
        return a > 30 ? 100 : 0;
      }
      if (a < 30) return 100;
      return Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
    };

    const threshold = 22; // color difference threshold
    const isContentPixel = (r, g, b, a) => colorDist(r, g, b, a) > threshold;

    // 2. Row Analysis: identify content span and detect full-width stretched lines/bars
    const rowContentCount = new Int32Array(height);
    const rowMinX = new Int32Array(height).fill(-1);
    const rowMaxX = new Int32Array(height).fill(-1);
    const isFullWidthRow = new Uint8Array(height);

    for (let y = 0; y < height; y++) {
      let firstX = -1;
      let lastX = -1;
      let count = 0;
      const rowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const idx = rowOffset + (x * 4);
        if (isContentPixel(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
          count++;
          if (firstX === -1) firstX = x;
          lastX = x;
        }
      }

      rowContentCount[y] = count;
      rowMinX[y] = firstX;
      rowMaxX[y] = lastX;

      if (firstX !== -1) {
        const span = lastX - firstX + 1;
        // If content spans > 65% of width or pixel density is > 60%
        if (span > width * 0.65 || count > width * 0.60) {
          isFullWidthRow[y] = 1;
        }
      }
    }

    // Check if we have standard (non-full-width) content rows
    let standardRowCount = 0;
    let totalContentRows = 0;
    for (let y = 0; y < height; y++) {
      if (rowContentCount[y] > 0) {
        totalContentRows++;
        if (!isFullWidthRow[y]) standardRowCount++;
      }
    }

    // Only filter out full-width rows if there are sufficient standard content rows
    const filterFullWidth = (totalContentRows > 0 && standardRowCount >= totalContentRows * 0.05);

    // 3. Column Analysis: count content pixels per column
    const colDensity = new Int32Array(width);
    for (let y = 0; y < height; y++) {
      if (filterFullWidth && isFullWidthRow[y]) continue; // ignore stretched dividers for column detection
      const rowOffset = y * width * 4;
      for (let x = 0; x < width; x++) {
        const idx = rowOffset + (x * 4);
        if (isContentPixel(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
          colDensity[x]++;
        }
      }
    }

    // Find column bounds [minX, maxX]
    let minX = -1;
    let maxX = -1;
    const colNoiseThreshold = Math.max(1, Math.floor(height * 0.003));

    for (let x = 0; x < width; x++) {
      if (colDensity[x] >= colNoiseThreshold) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }

    // If no columns detected using filtered rows, fall back to all content rows
    if (minX === -1 || maxX === -1 || maxX <= minX) {
      for (let y = 0; y < height; y++) {
        if (rowMinX[y] !== -1) {
          if (minX === -1 || rowMinX[y] < minX) minX = rowMinX[y];
          if (maxX === -1 || rowMaxX[y] > maxX) maxX = rowMaxX[y];
        }
      }
    }

    if (minX === -1 || maxX === -1) {
      // Entire image appears uniform
      return null;
    }

    // 4. Vertical Analysis: find minY and maxY
    // Scan rows from top and bottom that contain content within [minX, maxX] (plus slight margin)
    let minY = -1;
    let maxY = -1;
    const scanLeft = Math.max(0, minX - 10);
    const scanRight = Math.min(width - 1, maxX + 10);

    for (let y = 0; y < height; y++) {
      let rowHasContent = false;
      const rowOffset = y * width * 4;
      for (let x = scanLeft; x <= scanRight; x++) {
        const idx = rowOffset + (x * 4);
        if (isContentPixel(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
          rowHasContent = true;
          break;
        }
      }
      if (rowHasContent) {
        if (minY === -1) minY = y;
        maxY = y;
      }
    }

    if (minY === -1) {
      minY = 0;
      maxY = height - 1;
    }

    // 5. Apply padding (15px) and clamp to canvas boundaries
    const pad = Math.max(0, padding);
    const cropX = Math.max(0, minX - pad);
    const cropY = Math.max(0, minY - pad);
    const contentW = maxX - minX + 1;
    const contentH = maxY - minY + 1;
    const cropW = Math.min(width - cropX, contentW + (pad * 2));
    const cropH = Math.min(height - cropY, contentH + (pad * 2));

    return {
      cropX,
      cropY,
      cropW,
      cropH,
      minX,
      maxX,
      minY,
      maxY,
      bg: { r: bgR, g: bgG, b: bgB, a: bgA }
    };
  }

  /**
   * Immediately auto-crop canvas to primary content with specified padding
   * @param {number} padding (default 15)
   * @returns {Object|null} result { width, height, bounds, noChange }
   */
  autoCrop(padding = 15) {
    const bounds = this.detectContentBounds(padding);
    if (!bounds) return null;

    const noChange = (
      bounds.cropX === 0 &&
      bounds.cropY === 0 &&
      bounds.cropW === this.baseCanvas.width &&
      bounds.cropH === this.baseCanvas.height
    );

    if (noChange) {
      return { width: this.baseCanvas.width, height: this.baseCanvas.height, noChange: true, bounds };
    }

    this.cropRect = {
      x: bounds.cropX,
      y: bounds.cropY,
      width: bounds.cropW,
      height: bounds.cropH
    };

    const cropped = this.applyCrop();
    return cropped ? { ...cropped, bounds } : null;
  }

  /**
   * Snap current crop overlay box to content boundaries with padding
   * @param {number} padding (default 15)
   * @returns {Object|null} bounds
   */
  snapCropToContent(padding = 15) {
    const bounds = this.detectContentBounds(padding);
    if (!bounds) return null;

    if (!this.isCropping) {
      this.startCrop();
    }

    this.cropRect = {
      x: bounds.cropX,
      y: bounds.cropY,
      width: bounds.cropW,
      height: bounds.cropH
    };

    this.renderOverlay();
    return bounds;
  }

  handleCropMouseDown(pos) {
    const handle = this.getCropHitHandle(pos);
    this.activeCropHandle = handle;
    this.cropStartX = pos.x;
    this.cropStartY = pos.y;

    if (handle === 'new') {
      this.cropRect = { x: pos.x, y: pos.y, width: 0, height: 0 };
      this.cropStartRect = { ...this.cropRect };
    } else {
      this.cropStartRect = this.normalizeRect(this.cropRect);
      this.cropRect = { ...this.cropStartRect };
    }
  }

  handleCropMouseMove(pos) {
    if (!this.activeCropHandle || !this.cropStartRect) return;

    const dx = pos.x - this.cropStartX;
    const dy = pos.y - this.cropStartY;
    const orig = this.cropStartRect;
    const canvasW = this.baseCanvas.width;
    const canvasH = this.baseCanvas.height;

    let newX = orig.x;
    let newY = orig.y;
    let newW = orig.width;
    let newH = orig.height;

    if (this.activeCropHandle === 'move') {
      newX = Math.max(0, Math.min(canvasW - orig.width, orig.x + dx));
      newY = Math.max(0, Math.min(canvasH - orig.height, orig.y + dy));
      this.cropRect = { x: newX, y: newY, width: orig.width, height: orig.height };
    } else if (this.activeCropHandle === 'new') {
      const x1 = Math.max(0, Math.min(canvasW, Math.min(this.cropStartX, pos.x)));
      const y1 = Math.max(0, Math.min(canvasH, Math.min(this.cropStartY, pos.y)));
      const x2 = Math.max(0, Math.min(canvasW, Math.max(this.cropStartX, pos.x)));
      const y2 = Math.max(0, Math.min(canvasH, Math.max(this.cropStartY, pos.y)));

      let w = x2 - x1;
      let h = y2 - y1;
      if (this.cropAspectRatio) {
        h = Math.round(w / this.cropAspectRatio);
        if (y1 + h > canvasH) {
          h = canvasH - y1;
          w = Math.round(h * this.cropAspectRatio);
        }
      }
      this.cropRect = { x: x1, y: y1, width: w, height: h };
    } else {
      // Handle corner and edge resizing
      if (this.activeCropHandle.includes('e')) {
        newW = Math.max(10, Math.min(canvasW - orig.x, orig.width + dx));
      }
      if (this.activeCropHandle.includes('s')) {
        newH = Math.max(10, Math.min(canvasH - orig.y, orig.height + dy));
      }
      if (this.activeCropHandle.includes('w')) {
        const potentialX = orig.x + dx;
        const clampedX = Math.max(0, Math.min(orig.x + orig.width - 10, potentialX));
        newW = orig.width - (clampedX - orig.x);
        newX = clampedX;
      }
      if (this.activeCropHandle.includes('n')) {
        const potentialY = orig.y + dy;
        const clampedY = Math.max(0, Math.min(orig.y + orig.height - 10, potentialY));
        newH = orig.height - (clampedY - orig.y);
        newY = clampedY;
      }

      // If aspect ratio is locked
      if (this.cropAspectRatio) {
        if (this.activeCropHandle.includes('e') || this.activeCropHandle.includes('w')) {
          newH = Math.round(newW / this.cropAspectRatio);
        } else {
          newW = Math.round(newH * this.cropAspectRatio);
        }
      }

      this.cropRect = { x: newX, y: newY, width: newW, height: newH };
    }

    this.renderOverlay();
  }

  handleCropMouseUp() {
    if (this.cropRect) {
      this.cropRect = this.normalizeRect(this.cropRect);
      if (this.cropRect.width < 10 || this.cropRect.height < 10) {
        this.startCrop();
      }
    }
    this.activeCropHandle = null;
    this.cropStartRect = null;
    this.renderOverlay();
  }

  /**
   * Rotate Canvas 90 degrees
   */
  rotate(degrees = 90) {
    const merged = this.getMergedCanvas();
    const rad = (degrees * Math.PI) / 180;
    const isQuarter = Math.abs(degrees % 180) === 90;

    const newW = isQuarter ? merged.height : merged.width;
    const newH = isQuarter ? merged.width : merged.height;

    const rotated = document.createElement('canvas');
    rotated.width = newW;
    rotated.height = newH;
    const ctx = rotated.getContext('2d');

    ctx.translate(newW / 2, newH / 2);
    ctx.rotate(rad);
    ctx.drawImage(merged, -merged.width / 2, -merged.height / 2);

    this.baseCanvas.width = newW;
    this.baseCanvas.height = newH;
    this.overlayCanvas.width = newW;
    this.overlayCanvas.height = newH;

    this.baseCtx.clearRect(0, 0, newW, newH);
    this.baseCtx.drawImage(rotated, 0, 0);

    this.annotations = [];
    this.saveState();
    this.renderOverlay();
  }

  /**
   * Flip Horizontal or Vertical
   */
  flip(horizontal = true) {
    const merged = this.getMergedCanvas();
    const flipped = document.createElement('canvas');
    flipped.width = merged.width;
    flipped.height = merged.height;
    const ctx = flipped.getContext('2d');

    ctx.save();
    if (horizontal) {
      ctx.translate(merged.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, merged.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(merged, 0, 0);
    ctx.restore();

    this.baseCtx.clearRect(0, 0, merged.width, merged.height);
    this.baseCtx.drawImage(flipped, 0, 0);

    this.annotations = [];
    this.saveState();
    this.renderOverlay();
  }

  /**
   * Clear all annotations
   */
  clearAnnotations() {
    this.annotations = [];
    this.saveState();
    this.renderOverlay();
  }

  /**
   * Reset all changes back to original loaded image
   */
  resetToOriginal() {
    if (!this.originalImage) return;
    this.resetToImage(this.originalImage);
  }

  /**
   * Render overlay annotations
   */
  renderOverlay() {
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    // Draw saved annotations
    for (const item of this.annotations) {
      this.drawAnnotationItem(ctx, item);
    }

    // Draw active crop handles & dim overlay
    if (this.isCropping && this.cropRect) {
      this.drawCropOverlay(ctx);
    }
  }

  drawCropOverlay(ctx) {
    if (!this.cropRect) return;

    const norm = this.normalizeRect(this.cropRect);
    const { x, y, width, height } = norm;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;

    // Dim outside crop box
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, y);
    ctx.fillRect(0, y + height, w, h - (y + height));
    ctx.fillRect(0, y, x, height);
    ctx.fillRect(x + width, y, w - (x + width), height);

    const scaleRatio = this.getScaleRatio();

    // Crop border
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = Math.max(1.5, Math.round(2 * scaleRatio));
    ctx.setLineDash([Math.round(6 * scaleRatio), Math.round(4 * scaleRatio)]);
    ctx.strokeRect(x, y, width, height);

    // Rule of thirds grid
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, Math.round(1 * scaleRatio));

    ctx.beginPath();
    ctx.moveTo(x + width / 3, y);
    ctx.lineTo(x + width / 3, y + height);
    ctx.moveTo(x + (width * 2) / 3, y);
    ctx.lineTo(x + (width * 2) / 3, y + height);
    ctx.moveTo(x, y + height / 3);
    ctx.lineTo(x + width, y + height / 3);
    ctx.moveTo(x, y + (height * 2) / 3);
    ctx.lineTo(x + width, y + (height * 2) / 3);
    ctx.stroke();

    // Corner & edge circular handles
    const handleRadius = Math.max(5, Math.round(6.5 * scaleRatio));
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = Math.max(1.5, Math.round(2 * scaleRatio));

    const handles = [
      [x, y],
      [x + width / 2, y],
      [x + width, y],
      [x + width, y + height / 2],
      [x + width, y + height],
      [x + width / 2, y + height],
      [x, y + height],
      [x, y + height / 2]
    ];

    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.arc(hx, hy, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Size badge
    const badgeFontSize = Math.max(11, Math.round(12 * scaleRatio));
    ctx.font = `bold ${badgeFontSize}px sans-serif`;
    const text = `${width} × ${height} px`;
    const textW = ctx.measureText(text).width;
    const badgePadX = Math.round(10 * scaleRatio);
    const badgePadY = Math.round(6 * scaleRatio);
    const badgeW = textW + badgePadX * 2;
    const badgeH = badgeFontSize + badgePadY * 2;

    const badgeY = y > badgeH + 6 ? y - badgeH - 6 : y + 8;
    const badgeX = Math.min(w - badgeW - 6, Math.max(6, x + 8));

    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

    ctx.fillStyle = '#38BDF8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, badgeX + badgePadX, badgeY + badgePadY);

    ctx.restore();
  }

  /**
   * Live preview while dragging
   */
  renderLivePreview(ctx) {
    ctx.save();
    if (this.activeTool === 'redact') {
      const x = Math.min(this.startX, this.currentX);
      const y = Math.min(this.startY, this.currentY);
      const w = Math.abs(this.currentX - this.startX);
      const h = Math.abs(this.currentY - this.startY);

      ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    } else if (this.activeTool === 'rect') {
      const x = Math.min(this.startX, this.currentX);
      const y = Math.min(this.startY, this.currentY);
      const w = Math.abs(this.currentX - this.startX);
      const h = Math.abs(this.currentY - this.startY);

      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.strokeWidth;
      if (this.fillShapes) {
        ctx.fillStyle = this.color;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeRect(x, y, w, h);
    } else if (this.activeTool === 'circle') {
      const rx = Math.abs(this.currentX - this.startX) / 2;
      const ry = Math.abs(this.currentY - this.startY) / 2;
      const cx = Math.min(this.startX, this.currentX) + rx;
      const cy = Math.min(this.startY, this.currentY) + ry;

      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.strokeWidth;
      if (this.fillShapes) {
        ctx.fillStyle = this.color;
        ctx.fill();
      }
      ctx.stroke();
    } else if (this.activeTool === 'line') {
      ctx.beginPath();
      ctx.moveTo(this.startX, this.startY);
      ctx.lineTo(this.currentX, this.currentY);
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.strokeWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (this.activeTool === 'arrow') {
      this.drawArrow(ctx, this.startX, this.startY, this.currentX, this.currentY, this.color, this.strokeWidth);
    }
    ctx.restore();
  }

  drawAnnotationItem(ctx, item) {
    ctx.save();
    if (item.type === 'pen' || item.type === 'highlighter') {
      if (item.points && item.points.length > 0) {
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i++) {
          ctx.lineTo(item.points[i].x, item.points[i].y);
        }
        ctx.strokeStyle = item.color;
        ctx.lineWidth = item.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = item.opacity || 1;
        ctx.stroke();
      }
    } else if (item.type === 'rect') {
      const x = Math.min(item.x1, item.x2);
      const y = Math.min(item.y1, item.y2);
      const w = Math.abs(item.x2 - item.x1);
      const h = Math.abs(item.y2 - item.y1);

      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width;
      if (item.filled) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeRect(x, y, w, h);
    } else if (item.type === 'circle') {
      const rx = Math.abs(item.x2 - item.x1) / 2;
      const ry = Math.abs(item.y2 - item.y1) / 2;
      const cx = Math.min(item.x1, item.x2) + rx;
      const cy = Math.min(item.y1, item.y2) + ry;

      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width;
      if (item.filled) {
        ctx.fillStyle = item.color;
        ctx.fill();
      }
      ctx.stroke();
    } else if (item.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y1);
      ctx.lineTo(item.x2, item.y2);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (item.type === 'arrow') {
      this.drawArrow(ctx, item.x1, item.y1, item.x2, item.y2, item.color, item.width);
    } else if (item.type === 'step') {
      // Circle badge
      ctx.beginPath();
      ctx.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      ctx.fillStyle = item.color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      // Number inside
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(item.radius * 1.2)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(item.step), item.x, item.y + 1);
    } else if (item.type === 'sticker') {
      ctx.font = `${item.fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, item.x, item.y);
    } else if (item.type === 'text') {
      ctx.font = `bold ${item.fontSize}px sans-serif`;
      const metrics = ctx.measureText(item.text);
      const textW = metrics.width;
      const textH = item.fontSize;

      if (item.bg) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(item.x - 6, item.y - textH - 4, textW + 12, textH + 10);
      }

      ctx.fillStyle = item.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(item.text, item.x, item.y);
    }
    ctx.restore();
  }

  drawArrow(ctx, x1, y1, x2, y2, color, width) {
    const headLength = Math.max(16, width * 3.5);
    const angle = Math.atan2(y2 - y1, x2 - x1);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';

    // Draw shaft
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Draw arrowhead
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLength * Math.cos(angle - Math.PI / 6),
      y2 - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLength * Math.cos(angle + Math.PI / 6),
      y2 - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Merge base canvas and annotations into a single export canvas
   */
  getMergedCanvas() {
    const merged = document.createElement('canvas');
    merged.width = this.baseCanvas.width;
    merged.height = this.baseCanvas.height;
    const ctx = merged.getContext('2d');

    // 1. Base image with redacts
    ctx.drawImage(this.baseCanvas, 0, 0);

    // 2. Overlay annotations
    ctx.drawImage(this.overlayCanvas, 0, 0);

    return merged;
  }

  /**
   * Export final edited image as data URL
   */
  getExportDataUrl(format = 'png', quality = 0.92) {
    const merged = this.getMergedCanvas();
    const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');
    return merged.toDataURL(mime, quality);
  }
}
