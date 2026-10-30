/**
 * OpenFullPage - PDF Export Engine
 * Generates single-page continuous or multi-page A4/Letter PDFs locally
 * Uses bundled jsPDF without external dependencies.
 */

export async function exportToPdf(imageSource, options = {}) {
  const {
    format = 'a4', // 'a4' | 'letter' | 'continuous'
    orientation = 'auto', // 'auto' | 'portrait' | 'landscape'
    margin = 10, // mm
    title = 'Screenshot',
    url = '',
    timestamp = Date.now(),
    includeHeader = true,
    includePageNumbers = true
  } = options;

  if (typeof window.jspdf === 'undefined') {
    throw new Error('jsPDF library is not loaded');
  }

  const { jsPDF } = window.jspdf;

  // Load image element to measure natural dimensions
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = (e) => reject(new Error('Failed to load image for PDF generation'));
    image.src = typeof imageSource === 'string' ? imageSource : imageSource.toDataURL('image/png');
  });

  const imgWidth = img.naturalWidth;
  const imgHeight = img.naturalHeight;
  const aspectRatio = imgWidth / imgHeight;

  // 1. Continuous Single-Page PDF
  if (format === 'continuous') {
    // 1 pixel ~ 0.264583 mm (96 DPI)
    // To ensure crisp vector-like display and reasonable page size, scale image to max width of 210mm
    const targetWidthMm = 210;
    const targetHeightMm = targetWidthMm / aspectRatio;

    const doc = new jsPDF({
      orientation: targetWidthMm > targetHeightMm ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [targetWidthMm, targetHeightMm],
      compress: true
    });

    doc.addImage(img, 'PNG', 0, 0, targetWidthMm, targetHeightMm, undefined, 'FAST');
    return doc;
  }

  // 2. Standard Multi-Page / Paged PDF (A4 or Letter)
  const pageFormats = {
    a4: { width: 210, height: 297 },
    letter: { width: 215.9, height: 279.4 }
  };

  const baseSize = pageFormats[format] || pageFormats.a4;
  let pageOrientation = orientation;
  if (pageOrientation === 'auto') {
    pageOrientation = aspectRatio > 1.2 ? 'landscape' : 'portrait';
  }

  const pageWidth = pageOrientation === 'landscape' ? baseSize.height : baseSize.width;
  const pageHeight = pageOrientation === 'landscape' ? baseSize.width : baseSize.height;

  // Printable area after margins and headers
  const m = Math.max(0, margin);
  const headerSpace = includeHeader ? 12 : 0;
  const footerSpace = includePageNumbers ? 10 : 0;

  const contentX = m;
  const contentY = m + headerSpace;
  const contentWidth = pageWidth - (m * 2);
  const contentHeight = pageHeight - (m * 2) - headerSpace - footerSpace;

  if (contentWidth <= 0 || contentHeight <= 0) {
    throw new Error('Margin values too large for selected paper size');
  }

  // Calculate scaling so image fills contentWidth
  const scale = contentWidth / imgWidth;
  const totalImageHeightMm = imgHeight * scale;

  // Number of pages required
  const totalPages = Math.max(1, Math.ceil(totalImageHeightMm / contentHeight));

  const doc = new jsPDF({
    orientation: pageOrientation,
    unit: 'mm',
    format: format === 'letter' ? 'letter' : 'a4',
    compress: true
  });

  // Calculate slice height in source image pixels that fits in one page's contentHeight
  const sliceHeightPx = Math.floor(contentHeight / scale);

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) {
      doc.addPage(format === 'letter' ? 'letter' : 'a4', pageOrientation);
    }

    // Optional Header
    if (includeHeader) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);

      // Title & URL
      const displayTitle = (title.length > 60 ? title.substring(0, 57) + '...' : title);
      doc.text(displayTitle, m, m + 4);
      if (url) {
        const displayUrl = url.length > 70 ? url.substring(0, 67) + '...' : url;
        doc.text(displayUrl, pageWidth - m, m + 4, { align: 'right' });
      }
      // Thin header rule
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.2);
      doc.line(m, m + 6, pageWidth - m, m + 6);
    }

    // Slice image for this page
    const sy = page * sliceHeightPx;
    const currentSliceHeightPx = Math.min(sliceHeightPx, imgHeight - sy);
    const currentSliceHeightMm = currentSliceHeightPx * scale;

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = imgWidth;
    sliceCanvas.height = currentSliceHeightPx;
    const ctx = sliceCanvas.getContext('2d');

    // Fill white
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, imgWidth, currentSliceHeightPx);

    // Draw slice portion
    ctx.drawImage(
      img,
      0, sy, imgWidth, currentSliceHeightPx,
      0, 0, imgWidth, currentSliceHeightPx
    );

    const sliceDataUrl = sliceCanvas.toDataURL('image/jpeg', 0.95);
    doc.addImage(
      sliceDataUrl,
      'JPEG',
      contentX,
      contentY,
      contentWidth,
      currentSliceHeightMm,
      undefined,
      'FAST'
    );

    // Optional Footer (Page Number)
    if (includePageNumbers) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      const pageText = `${page + 1} / ${totalPages}`;
      doc.text(pageText, pageWidth / 2, pageHeight - m + 4, { align: 'center' });
    }
  }

  return doc;
}
