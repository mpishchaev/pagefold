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
    this.cropHandle = null;

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
      const scaleX = this.overlayCanvas.width / rect.width;
      const scaleY = this.overlayCanvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    };

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
   * Crop Mode
   */
  startCrop() {
    this.isCropping = true;
    const padding = 20;
    this.cropRect = {
      x: padding,
      y: padding,
      width: this.baseCanvas.width - (padding * 2),
      height: this.baseCanvas.height - (padding * 2)
    };
    this.renderOverlay();
  }

  applyCrop() {
    if (!this.cropRect) return;

    const { x, y, width, height } = this.cropRect;
    if (width <= 10 || height <= 10) return;

    // Merge base + annotations into temporary canvas to crop everything uniformly
    const merged = this.getMergedCanvas();
    const cropped = document.createElement('canvas');
    cropped.width = Math.round(width);
    cropped.height = Math.round(height);

    const ctx = cropped.getContext('2d');
    ctx.drawImage(
      merged,
      x, y, width, height,
      0, 0, width, height
    );

    this.baseCanvas.width = cropped.width;
    this.baseCanvas.height = cropped.height;
    this.overlayCanvas.width = cropped.width;
    this.overlayCanvas.height = cropped.height;

    this.baseCtx.clearRect(0, 0, cropped.width, cropped.height);
    this.baseCtx.drawImage(cropped, 0, 0);

    this.annotations = [];
    this.isCropping = false;
    this.cropRect = null;
    this.activeTool = 'select';

    this.saveState();
    this.renderOverlay();
  }

  cancelCrop() {
    this.isCropping = false;
    this.cropRect = null;
    this.activeTool = 'select';
    this.renderOverlay();
  }

  handleCropMouseDown(pos) {
    // Check if dragging inside crop box to move, or dragging handles to resize
    this.cropStartX = pos.x;
    this.cropStartY = pos.y;
    this.origCropRect = { ...this.cropRect };
  }

  handleCropMouseMove(pos) {
    if (!this.origCropRect) return;
    const dx = pos.x - this.cropStartX;
    const dy = pos.y - this.cropStartY;

    // Update crop rectangle
    this.cropRect = {
      x: Math.max(0, Math.min(this.baseCanvas.width - 20, this.origCropRect.x + dx)),
      y: Math.max(0, Math.min(this.baseCanvas.height - 20, this.origCropRect.y + dy)),
      width: this.origCropRect.width,
      height: this.origCropRect.height
    };

    this.renderOverlay();
  }

  handleCropMouseUp() {
    this.origCropRect = null;
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
    const { x, y, width, height } = this.cropRect;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;

    // Dim outside
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, w, y);
    ctx.fillRect(0, y + height, w, h - (y + height));
    ctx.fillRect(0, y, x, height);
    ctx.fillRect(x + width, y, w - (x + width), height);

    // Crop border
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(x, y, width, height);

    // Grid rule of thirds
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + width / 3, y, width / 3, height);
    ctx.strokeRect(x, y + height / 3, width, height / 3);

    // Corner & edge handles
    const handleSize = 10;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = 2;

    const handles = [
      [x, y], [x + width / 2, y], [x + width, y],
      [x, y + height / 2], [x + width, y + height / 2],
      [x, y + height], [x + width / 2, y + height], [x + width, y + height]
    ];

    for (const [hx, hy] of handles) {
      ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
    }

    // Size badge
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    const text = `${Math.round(width)} × ${Math.round(height)} px`;
    const tw = ctx.measureText(text).width + 16;
    ctx.fillRect(x + 10, y + 10, tw, 24);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, x + 18, y + 26);

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
