# 330i Care

A phone-only maintenance tracker built only for a 2022 BMW 330i xDrive (G20, B48, JB4 tune). It is not a general car app. Every interval shows how sure it is and where it came from. Static site, no backend, no accounts. All data stays in the phone's IndexedDB. Back up and restore with a JSON file.

Files: `index.html`, `css/app.css`, `js/` (items, calc, db, app), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.

Edit service items and starting intervals in `js/items.js`. The due-date logic is in `js/calc.js`.

Host: any static host. On GitHub Pages, serve the repo root. All paths are relative, so a project subpath works.
