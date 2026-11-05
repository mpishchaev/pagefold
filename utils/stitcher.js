/**
 * OpenFullPage - Canvas Stitcher Engine
 * Stitches multiple viewport screenshots into a single seamless image.
 * Compatible with OffscreenCanvas (Service Worker) and HTML5 Canvas (DOM).
 */

/**
 * Converts a data URL to an ImageBitmap or HTMLImageElement
 */
async function loadImage(dataUrl) {
  if (typeof fetch !== 'undefined' && typeof createImageBitmap !== 'undefined') {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch (e) {
      console.warn('createImageBitmap failed, trying fallback', e);
    }
  }

  // DOM fallback
  if (typeof Image !== 'undefined') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = dataUrl;
    });
  }

  throw new Error('No image decoding method available in current environment');
}

/**
 * Creates a canvas (OffscreenCanvas if available, else HTMLCanvasElement)
 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('Canvas API not available in this environment');
}

/**
 * Safely convert Blob to Data URL in ANY context (Service Worker, Web Worker, or DOM)
 * Avoids ReferenceError: FileReader is not defined in Manifest V3 Service Workers.
 */
export async function blobToDataURL(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Pure ServiceWorker-safe conversion using ArrayBuffer and Base64
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || 'image/png'};base64,${base64}`;
}

/**
 * Convert canvas to Data URL
 */
async function canvasToDataURL(canvas, format = 'png', quality = 0.92) {
  const mimeType = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : (format === 'webp' ? 'image/webp' : 'image/png');

  if (canvas.convertToBlob) {
    const blob = await canvas.convertToBlob({ type: mimeType, quality });
    return await blobToDataURL(blob);
  }

  if (canvas.toDataURL) {
    return canvas.toDataURL(mimeType, quality);
  }

  throw new Error('Cannot export canvas to data URL');
}

/**
 * Stitch multiple captured vertical slices into one image.
 * `clip` is the part of the screenshot to use and `y` its position in the
 * result; without a clip the whole screenshot is drawn. All in CSS pixels.
 * @param {Array<{ dataUrl: string, y: number, windowWidth: number, clip?: { x: number, y: number, width: number, height: number } }>} slices
 * @param {{ totalWidth: number, totalHeight: number, devicePixelRatio: number, format: string, quality: number }} options
 */
export async function stitchSlices(slices, options) {
  if (!slices || slices.length === 0) {
    throw new Error('No screenshot slices to stitch');
  }

  // If there's only 1 slice and it covers the whole target, return it directly
  if (slices.length === 1 && !slices[0].clip && !options.forceStitch) {
    return {
      dataUrl: slices[0].dataUrl,
      width: Math.round(options.totalWidth * (options.devicePixelRatio || 1)),
      height: Math.round(options.totalHeight * (options.devicePixelRatio || 1))
    };
  }

  // First decode the first slice to determine true pixel dimensions
  const firstImage = await loadImage(slices[0].dataUrl);
  const slicePixelWidth = firstImage.width;
  const slicePixelHeight = firstImage.height;

  // Determine actual scale factor (devicePixelRatio)
  const winWidth = slices[0].windowWidth || options.viewportWidth || (slicePixelWidth / (options.devicePixelRatio || 1));
  const measuredDpr = winWidth > 0 ? (slicePixelWidth / winWidth) : 0;
  // The page's ratio is exact, the measured one suffers from a rounded innerWidth,
  // but only the measured one is right if the screenshot has a different scale
  const reportedDpr = options.devicePixelRatio || 1;
  const dpr = measuredDpr > 0 && Math.abs(measuredDpr / reportedDpr - 1) > 0.02 ? measuredDpr : reportedDpr;

  // Calculate final canvas dimensions in device pixels
  let targetPixelWidth = slices[0].clip ? Math.round(options.totalWidth * dpr) : slicePixelWidth;
  let targetPixelHeight = Math.round(options.totalHeight * dpr);

  // Guard against Chromium canvas dimension caps (typically 32767px or ~268MP)
  const MAX_CANVAS_DIM = 32760;
  if (targetPixelHeight > MAX_CANVAS_DIM) {
    console.warn(`Total height ${targetPixelHeight}px exceeds browser canvas max limit (${MAX_CANVAS_DIM}px). Clamping.`);
    targetPixelHeight = MAX_CANVAS_DIM;
  }
  if (targetPixelWidth > MAX_CANVAS_DIM) {
    targetPixelWidth = MAX_CANVAS_DIM;
  }

  // Create canvas
  const canvas = createCanvas(targetPixelWidth, targetPixelHeight);
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  // Fill background with white (prevents black background on transparent body/pages)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetPixelWidth, targetPixelHeight);

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const img = i === 0 ? firstImage : await loadImage(slice.dataUrl);

    const clip = slice.clip || { x: 0, y: 0, width: img.width / dpr, height: img.height / dpr };
    const sx = Math.round(clip.x * dpr);
    const sy = Math.round(clip.y * dpr);
    const sw = Math.min(img.width, Math.round((clip.x + clip.width) * dpr)) - sx;
    const sh = Math.min(img.height, Math.round((clip.y + clip.height) * dpr)) - sy;

    ctx.drawImage(img, sx, sy, sw, sh, 0, Math.round(slice.y * dpr), sw, sh);
  }

  // Convert to output data URL
  const resultDataUrl = await canvasToDataURL(canvas, options.format || 'png', options.quality || 0.92);

  return {
    dataUrl: resultDataUrl,
    width: targetPixelWidth,
    height: targetPixelHeight
  };
}

/**
 * Crop an image to a specific bounding rectangle
 * @param {string} dataUrl - source image data url
 * @param {{ x: number, y: number, width: number, height: number, devicePixelRatio?: number }} rect - coordinates in CSS pixels
 */
export async function cropImage(dataUrl, rect) {
  const img = await loadImage(dataUrl);
  const dpr = rect.devicePixelRatio || (img.width / (rect.viewportWidth || (img.width)));

  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sWidth = Math.min(img.width - sx, Math.round(rect.width * dpr));
  const sHeight = Math.min(img.height - sy, Math.round(rect.height * dpr));

  if (sWidth <= 0 || sHeight <= 0) {
    throw new Error('Invalid crop dimensions');
  }

  const canvas = createCanvas(sWidth, sHeight);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

  const croppedDataUrl = await canvasToDataURL(canvas, 'png');
  return {
    dataUrl: croppedDataUrl,
    width: sWidth,
    height: sHeight
  };
}
