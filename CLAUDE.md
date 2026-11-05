# Pagefold

Chrome extension (Manifest V3): full-page screenshots with an editor and PDF export; captures stay in the browser (IndexedDB). Part of Morlov. Plain ES modules with no build step; load the repo root via "Load unpacked". User docs are in `README.md`.

## Commands

- `npm test`: static checks (files, manifest, locales, auto-crop logic). Says nothing about whether capture works.
- `npm run test:e2e [-- filter]`: real capture in Chromium with pixel checks. Needs env `PLAYWRIGHT_CORE` (playwright-core dir) and `CHROMIUM` (chrome.exe). `SCALE=1.25` runs at a real fractional scale; use it for any stitching change.

Run the e2e suite after touching `background/`, `content/` or `utils/stitcher.js`.

## Architecture

- `background/service_worker.js` drives capture: scroll via messages, `captureVisibleTab`, stitch, save to IndexedDB, open the viewer.
- `content/content.js` is injected on demand by `ensureContentScript` (no `content_scripts` in the manifest; top frame only). It measures, scrolls, hides fixed elements, and runs the picker UIs.
- `utils/stitcher.js` assembles slices on OffscreenCanvas. Full page and element capture share this path: each slice has an actual `y` and an optional `clip` in CSS pixels.
- `viewer/` is the editor (`editor.js`), history and PDF export.

## Constraints

- Permissions are `activeTab`-based, so access exists only after a user gesture. The e2e copy adds `<all_urls>` to get around that, so the toolbar and hotkey path itself is not automated.
- `captureVisibleTab` allows 2 calls per second: `safeCaptureVisibleTab` paces them. Do not call the API directly in a loop.
- Service worker has no DOM and no `FileReader`. Chrome kills it silently after 30 s without extension API calls, so long work goes through `withKeepAlive`.
- IndexedDB rejects values over ~133 MB by aborting the transaction, not the request: store images as Blobs and listen to the transaction. DevTools keeps the worker alive, so lifetime bugs need a run with no debugger attached to it.
- Use the `y` the page reports after scrolling, never the requested one.
- A wrapper of the capture target must not be hidden as "fixed" (SPAs put the whole app in a fixed root).
- `iframe.contentDocument` returns `null` for cross-origin frames rather than throwing.
- The element picker relies on `#pagefold-element-shield` taking all pointer events; hit testing briefly disables it.
