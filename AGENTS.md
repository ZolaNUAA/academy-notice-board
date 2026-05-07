# Repository Guidelines

## Project Structure & Module Organization

This repository contains an academy notice board with a custom Node.js production server and a secondary Next.js development surface. `server.js` is the main runtime: it serves `index.html`, handles auth, routes `/api/*`, uploads, and persistence. Shared storage and parsing helpers live in `lib/`, including `lib/storage.js`, `lib/parser.ts`, and `lib/types.ts`. Next.js files are under `app/` and `components/`; keep behavior aligned with production logic when editing them. Runtime data is stored in `data/`, uploaded files in `uploads/` or `data/uploads/`, and generated manuals or deployment notes are in root Markdown/PDF files and `deploy/`.

## Build, Test, and Development Commands

- `npm install` installs Node dependencies from `package-lock.json`.
- `npm start` or `node server.js` starts the production server on port `3000`.
- `./test.sh` runs browser-driven smoke tests against `http://localhost:3000` and writes screenshots to `test_screenshots/`.

Start the server before running `./test.sh`. This project currently has no separate build, lint, or unit-test script in `package.json`.

## Coding Style & Naming Conventions

Use JavaScript for the production server and TypeScript/TSX for the Next.js files. Follow the existing style: two-space indentation in JSON/config files, semicolon-light JavaScript, descriptive camelCase identifiers, and PascalCase React components such as `NoticeCard.tsx`. Keep user-facing Chinese labels consistent with the existing UI. Avoid broad refactors in `server.js`; place focused helpers in `lib/` when logic can be shared.

## Testing Guidelines

Use `./test.sh` for end-to-end smoke coverage of login, board display, search, category filtering, expired notices, and sorting. Add or update screenshot checks when changing visible UI behavior. For parser changes, verify both the production parser in `server.js` and the TypeScript parser in `lib/parser.ts` produce matching fields: title, category, importance, deadline, owner, and links.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes with concise Chinese descriptions, for example `feat: ...`, `fix: ...`, and `refactor: ...`. Keep commits scoped to one logical change. Pull requests should describe the user-visible change, list test commands run, mention data/config migrations, and include screenshots for UI changes.

## Security & Configuration Tips

Do not commit real credentials or production passwords. Use `config.example.json` as the template and keep local secrets in `config.json` or deployment-specific configuration. Be careful with `data/notices.json`, uploads, and operation logs because they may contain internal notice content.
