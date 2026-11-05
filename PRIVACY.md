# Pagefold privacy policy

Last updated: 2026-11-05

Pagefold is a Chrome extension that takes screenshots of web pages. This page
says what it does with your data. Everything here can be checked in the source
code in this repository.

## What Pagefold collects

Nothing. Pagefold has no account, no server and no analytics. The extension
makes no network requests: the PDF library it uses (jsPDF) ships inside the
extension.

## What stays in your browser

- **Your screenshots and their history** are stored in your browser's
  IndexedDB, together with the page title, the page address and the date of
  each capture. You can delete one capture or clear the whole history in the
  extension.
- **Your settings** (image format, quality, file name template, theme and
  similar) are stored in `chrome.storage.local`.
- **A short debug log** of the last capture steps, including the address of
  the captured page, is stored in `chrome.storage.local` so that you can copy
  it into a bug report with the "Copy debug log" button. The extension never
  sends it anywhere.

Uninstalling the extension removes all of this.

## When Pagefold reads a page

Only when you ask for a capture: by clicking the toolbar button, pressing a
shortcut or choosing a capture in the right-click menu. It then reads the
current tab to scroll it, measure it and take the screenshot. It does not
read pages in the background.

## What leaves your device

Only what you choose to export: a file you download, or an image you copy to
the clipboard.

## Contact

Questions about this policy: open an issue at
https://github.com/mpishchaev/pagefold/issues or write via the contacts on
https://morlov.app/about/.
