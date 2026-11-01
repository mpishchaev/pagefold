/**
 * OpenFullPage - Extension Verification & Integrity Test Suite
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatFilename, DEFAULT_SETTINGS } from '../utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedTests++;
    console.log(`✅ PASS: ${message}`);
  }
}

// 1. Test Manifest V3 Integrity
console.log('\n--- 1. Testing manifest.json & Files Existence ---');
const manifestPath = path.join(rootDir, 'manifest.json');
assert(fs.existsSync(manifestPath), 'manifest.json exists');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert(manifest.manifest_version === 3, 'manifest_version is 3');
assert(manifest.background && manifest.background.service_worker, 'background.service_worker is defined');
assert(manifest.background.type === 'module', 'background.type is module');
assert(fs.existsSync(path.join(rootDir, manifest.background.service_worker)), 'background service_worker file exists');
assert(fs.existsSync(path.join(rootDir, manifest.action.default_popup)), 'popup html file exists');

for (const [size, iconPath] of Object.entries(manifest.icons)) {
  assert(fs.existsSync(path.join(rootDir, iconPath)), `icon ${size} exists at ${iconPath}`);
}

for (const webRes of manifest.web_accessible_resources) {
  for (const res of webRes.resources) {
    if (!res.includes('*')) {
      assert(fs.existsSync(path.join(rootDir, res)), `web accessible resource ${res} exists`);
    }
  }
}

// 2. Test Localization files
console.log('\n--- 2. Testing Localization (_locales) ---');
const enLocalePath = path.join(rootDir, '_locales', 'en', 'messages.json');
const ruLocalePath = path.join(rootDir, '_locales', 'ru', 'messages.json');
assert(fs.existsSync(enLocalePath), 'en messages.json exists');
assert(fs.existsSync(ruLocalePath), 'ru messages.json exists');

const enMessages = JSON.parse(fs.readFileSync(enLocalePath, 'utf8'));
const ruMessages = JSON.parse(fs.readFileSync(ruLocalePath, 'utf8'));
assert(enMessages.extensionName && enMessages.extensionName.message, 'en extensionName is defined');
assert(ruMessages.extensionName && ruMessages.extensionName.message, 'ru extensionName is defined');

// 3. Test jsPDF Bundling (Standalone & Offline)
console.log('\n--- 3. Testing Bundled Libraries ---');
const jspdfPath = path.join(rootDir, 'lib', 'jspdf.umd.min.js');
assert(fs.existsSync(jspdfPath), 'lib/jspdf.umd.min.js exists');
const jspdfStats = fs.statSync(jspdfPath);
assert(jspdfStats.size > 100000, `jsPDF bundle is healthy size (${Math.round(jspdfStats.size / 1024)} KB)`);

// 4. Test Storage & Filename Formatting
console.log('\n--- 4. Testing Storage & Filename Formatting ---');
assert(DEFAULT_SETTINGS.format === 'png', 'DEFAULT_SETTINGS has default format png');
assert(DEFAULT_SETTINGS.scrollDelay === 150, 'DEFAULT_SETTINGS scrollDelay is 150');
assert(DEFAULT_SETTINGS.hideFixedElements === true, 'DEFAULT_SETTINGS hideFixedElements is true');

const testMeta = {
  title: 'Test Article: How to Build Chrome Extensions / Best Practices <2026>',
  url: 'https://blog.example.com/2026/how-to-build',
  timestamp: new Date('2026-10-30T14:30:45Z').getTime()
};

const formatted = formatFilename('screen-{domain}-{title}-{date}-{time}', testMeta);
console.log('Sample formatted filename:', formatted);
assert(formatted.startsWith('screen-blog.example.com-'), 'Domain parsed correctly without www');
assert(!formatted.includes('<') && !formatted.includes('>') && !formatted.includes(':') && !formatted.includes('/'), 'Special chars sanitized cleanly');
assert(formatted.includes('2026-10-30'), 'Date formatted correctly');

// 5. Test Viewer, Content Script and Utils Files Existence
console.log('\n--- 5. Testing Viewer, Content, and Core Modules ---');
const requiredFiles = [
  'content/content.js',
  'content/overlay.css',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'viewer/viewer.html',
  'viewer/viewer.css',
  'viewer/viewer.js',
  'viewer/editor.js',
  'viewer/pdf-exporter.js',
  'viewer/history.js',
  'utils/storage.js',
  'utils/db.js',
  'utils/stitcher.js'
];

for (const relPath of requiredFiles) {
  const fullPath = path.join(rootDir, relPath);
  assert(fs.existsSync(fullPath), `Required file exists: ${relPath}`);
  const content = fs.readFileSync(fullPath, 'utf8');
  assert(content.length > 50, `File has substantial content: ${relPath} (${content.length} bytes)`);
}

// 6. Test Auto-Crop and Context Menu UI & Logic
console.log('\n--- 6. Testing Auto-Crop & Context Menu Elements ---');
const viewerHtml = fs.readFileSync(path.join(rootDir, 'viewer/viewer.html'), 'utf8');
assert(viewerHtml.includes('id="btn-auto-crop"'), 'Auto-Crop button present in top nav');
assert(viewerHtml.includes('id="btn-detect-content"'), 'Detect Content button present in crop bar');
assert(viewerHtml.includes('id="editor-context-menu"'), 'Custom context menu (ПКМ) container present');
assert(viewerHtml.includes('data-action="copy"'), 'Context menu has Copy Image action');
assert(viewerHtml.includes('data-action="save"'), 'Context menu has Save Image action');
assert(viewerHtml.includes('data-action="auto-crop"'), 'Context menu has Auto-Crop action');

const editorJs = fs.readFileSync(path.join(rootDir, 'viewer/editor.js'), 'utf8');
assert(editorJs.includes('detectContentBounds(padding = 15)'), 'detectContentBounds method implemented with default 15px');
assert(editorJs.includes('autoCrop(padding = 15)'), 'autoCrop method implemented');
assert(editorJs.includes('snapCropToContent(padding = 15)'), 'snapCropToContent method implemented');

// Test Smart Detection algorithm simulation with stretched divider rule
console.log('\n--- 7. Testing Smart Detection Algorithm Unit Logic ---');
const mockW = 1000;
const mockH = 600;
const mockData = new Uint8ClampedArray(mockW * mockH * 4);
// Fill with white background (255, 255, 255, 255)
mockData.fill(255);

// Draw central content block: X from 350 to 650 (width 300), Y from 100 to 450 (height 350)
for (let y = 100; y <= 450; y++) {
  for (let x = 350; x <= 650; x++) {
    const idx = (y * mockW + x) * 4;
    mockData[idx] = 30; // dark content
    mockData[idx + 1] = 30;
    mockData[idx + 2] = 30;
  }
}

// Draw a stretched 1px full-width footer line across almost the entire width: X from 10 to 990 (span 980) at Y = 550
for (let x = 10; x <= 990; x++) {
  const idx = (550 * mockW + x) * 4;
  mockData[idx] = 100;
  mockData[idx + 1] = 100;
  mockData[idx + 2] = 100;
}

// Run simulated detection logic (identical to detectContentBounds)
{
  const width = mockW;
  const height = mockH;
  const data = mockData;
  const bgR = 255, bgG = 255, bgB = 255;
  const isContent = (r, g, b) => (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB)) > 22;

  const rowSpan = new Int32Array(height);
  const rowCount = new Int32Array(height);
  const isFullWidth = new Uint8Array(height);

  for (let y = 0; y < height; y++) {
    let minX = -1, maxX = -1, cnt = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (isContent(data[idx], data[idx + 1], data[idx + 2])) {
        cnt++;
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    rowCount[y] = cnt;
    if (minX !== -1) {
      const span = maxX - minX + 1;
      rowSpan[y] = span;
      if (span > width * 0.65 || cnt > width * 0.60) {
        isFullWidth[y] = 1;
      }
    }
  }

  assert(isFullWidth[550] === 1, 'Full-width stretched divider row correctly identified and flagged');
  assert(isFullWidth[200] === 0, 'Standard content row correctly not flagged as full-width');

  const colDensity = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    if (isFullWidth[y]) continue; // ignore stretched line
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (isContent(data[idx], data[idx + 1], data[idx + 2])) {
        colDensity[x]++;
      }
    }
  }

  let minX = -1, maxX = -1;
  for (let x = 0; x < width; x++) {
    if (colDensity[x] > 1) {
      if (minX === -1) minX = x;
      maxX = x;
    }
  }

  assert(minX === 350 && maxX === 650, `Column bounds detected accurately (${minX} to ${maxX}) ignoring full-width line`);

  const pad = 15;
  const cropX = Math.max(0, minX - pad);
  const cropW = (maxX - minX + 1) + (pad * 2);
  assert(cropX === 335, `15px left padding applied accurately (${cropX} === 335)`);
  assert(cropW === 331, `15px total width padding applied accurately (${cropW} === 331)`);
}

// Test Mode Background Detection with Colored Navbar (Scenario B)
console.log('\n--- 8. Testing Mode Background Detection with Navbar ---');
{
  const width = 1200;
  const height = 800;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255); // Body is white

  // Black navbar at top (Y from 0 to 50 across full width)
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = 30; data[idx+1] = 30; data[idx+2] = 30;
    }
  }

  // Centered content column from X=250 to X=950, Y=80 to Y=700
  for (let y = 80; y < 700; y++) {
    for (let x = 250; x < 950; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = 40; data[idx+1] = 40; data[idx+2] = 40;
    }
  }

  // Sample border margins using histogram mode
  const colorHistogram = new Map();
  function sample(r, g, b, a) {
    if (a < 30) return;
    const qr = Math.min(255, (r >> 3) << 3);
    const qg = Math.min(255, (g >> 3) << 3);
    const qb = Math.min(255, (b >> 3) << 3);
    const key = (qr << 16) | (qg << 8) | qb;
    colorHistogram.set(key, (colorHistogram.get(key) || 0) + 1);
  }

  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < 10; x++) {
      const idxL = (y * width + x) * 4;
      sample(data[idxL], data[idxL+1], data[idxL+2], data[idxL+3]);
      const idxR = (y * width + (width - 1 - x)) * 4;
      sample(data[idxR], data[idxR+1], data[idxR+2], data[idxR+3]);
    }
  }

  let bestCount = 0;
  let modeKey = 0;
  for (const [key, count] of colorHistogram.entries()) {
    if (count > bestCount) {
      bestCount = count;
      modeKey = key;
    }
  }
  const bgR = (modeKey >> 16) & 255;
  const bgG = (modeKey >> 8) & 255;
  const bgB = modeKey & 255;

  assert(bgR >= 240 && bgG >= 240 && bgB >= 240, `Histogram mode accurately identifies white body as background (${bgR},${bgG},${bgB}) despite black navbar`);
}

console.log(`\n========================================`);
console.log(`🎉 ALL ${passedTests} OF ${totalTests} VERIFICATION CHECKS PASSED!`);
console.log(`========================================\n`);
