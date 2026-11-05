# Chrome Web Store listing: Pagefold

Copy for the Developer Dashboard, field by field. Name and short description
come from `_locales/*/messages.json` automatically; keep them in sync.

Upload: `npm run pack` → `pagefold.zip`.

## Store listing tab

**Category:** Tools
**Language:** English (add Russian as a second listing language)

### Detailed description (en)

Pagefold takes a screenshot of a whole web page, however long, and gives it
back as one image or PDF.

Four ways to capture:
• Entire page: scrolls the page for you, hides sticky headers so they don't
  repeat down the page, and stitches everything into one image.
• Visible area: what you see right now.
• Selected area: drag a rectangle.
• One element: hover a card, a table or an article and click it. Arrow keys
  move to the parent or child element.

Then edit the result:
• Crop, rotate, flip
• Blur out passwords, emails and personal data
• Arrows, lines, boxes, ovals, text, highlighter, pen
• Numbered steps (1, 2, 3) for bug reports and how-tos
• Undo and redo

Save it the way you need:
• PNG, or JPG and WebP with a quality slider
• PDF, either split into A4 or Letter pages or as one long page
• Copy to clipboard in one click

Your captures are kept in a history inside your browser, with search by page
title or address.

Keyboard shortcuts: Alt+Shift+P (entire page), Alt+Shift+V (visible area),
Alt+Shift+S (selected area), Alt+Shift+E (element). You can also right-click a
page to capture it.

Free, no sign-up, no ads. Pagefold is part of Morlov (https://morlov.app),
small free tools made by one person.

### Detailed description (ru)

Pagefold делает скриншот всей веб-страницы, какой бы длинной она ни была, и
сохраняет его одной картинкой или PDF.

Четыре способа снять:
• Всю страницу: прокручивает её сама, прячет прилипающие шапки, чтобы они не
  повторялись по всей длине, и склеивает всё в одно изображение.
• Видимую область: то, что сейчас на экране.
• Выделенную область: обведите прямоугольник.
• Один элемент: наведите на карточку, таблицу или статью и кликните. Стрелки
  переключают на родительский или вложенный элемент.

Потом снимок можно поправить:
• Обрезать, повернуть, отразить
• Размыть пароли, почту и личные данные
• Стрелки, линии, рамки, овалы, текст, маркер, карандаш
• Нумерованные шаги (1, 2, 3) для баг-репортов и инструкций
• Отмена и повтор

И сохранить как удобно:
• PNG, либо JPG и WebP с выбором качества
• PDF: по листам A4 или Letter, либо одной длинной страницей
• Копирование в буфер обмена в один клик

Снимки хранятся в истории внутри вашего браузера, с поиском по заголовку и
адресу страницы.

Горячие клавиши: Alt+Shift+P (вся страница), Alt+Shift+V (видимая область),
Alt+Shift+S (область), Alt+Shift+E (элемент). Ещё можно снять страницу через
меню правой кнопки мыши.

Бесплатно, без регистрации и рекламы. Pagefold входит в Morlov
(https://morlov.app): небольшие бесплатные инструменты, которые делает один
человек.

### Graphics

- Icon 128×128: `icons/icon128.png`
- Screenshots 1280×800: `store/screenshots/*.png`
- Small promo tile 440×280: `store/promo-440x280.png`

### Links

- Homepage: https://morlov.app/ (switch to https://morlov.app/pagefold/ once that page exists)
- Support: https://github.com/mpishchaev/pagefold/issues

## Privacy practices tab

**Single purpose:** Capture screenshots of the web page in the current tab,
then edit and save them as images or PDF.

**Permission justifications:**

| Permission | Why |
|---|---|
| `activeTab` | Capture the tab the user is on, only after they click the toolbar button, a shortcut or the context menu. |
| `scripting` | Inject the capture script into that tab to scroll it, measure it, hide sticky headers while capturing and show the area and element pickers. |
| `storage` | Keep the user's settings (format, quality, file name template, theme). |
| `unlimitedStorage` | Keep the capture history in IndexedDB; a single full-page capture can be tens of megabytes. |
| `downloads` | Save the image or PDF to the Downloads folder when the user exports it or turns on auto-download. |
| `contextMenus` | Add the capture modes to the page's right-click menu. |
| `notifications` | Tell the user when a capture fails (for example, on pages Chrome does not allow extensions to capture). |

**Remote code:** No. All code, including jsPDF, ships inside the package.

**Data usage:** Collects no user data. Check none of the data types.
Captures, history and settings stay in the user's browser; the extension
makes no network requests. Certify all three statements (not sold, not used
for unrelated purposes, not used for creditworthiness).

**Privacy policy URL:** https://morlov.app/privacy/
