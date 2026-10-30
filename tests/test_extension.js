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

console.log(`\n========================================`);
console.log(`🎉 ALL ${passedTests} OF ${totalTests} VERIFICATION CHECKS PASSED!`);
console.log(`========================================\n`);
