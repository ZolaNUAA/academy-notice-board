# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

学院通知便利贴看板 (Academy Notice Board) — a sticky-note style notification display system with WeChat group text parsing. It has two frontends (custom Node server and Next.js) but the production server is the custom Node.js server in `server.js`.

## Architecture

**Production Server**: `server.js` is a custom Node.js HTTP server (not Next.js). It handles routing, authentication, data persistence, and file uploads. Next.js in `app/` is only used for development.

**Frontend**: `index.html` is served by the Node server and loaded in the browser. API calls go to the Node server's `/api/*` endpoints.

**Storage Strategy** (`lib/storage.js`):
- CloudBase environment: files saved locally + CloudBase Storage backup
- `/mnt` available: uses `/mnt/data` for durability (Tencent Cloud COS mount)
- Local development: uses `./data`
- Files served directly by Node server (not CloudBase URLs)

**Data Files**:
- `data/notices.json` — notice records
- `data/config.json` — admin passwords and settings
- `data/uploads/` — uploaded images and attachments

## Key Commands

```bash
node server.js           # Start production server (port 3000)
npm run dev              # Start Next.js dev server (for development only)
npm ci                   # Install dependencies (for deployment)
```

## Notice Parser

The parser logic exists in two places:
- `lib/parser.ts` — frontend TypeScript version (used in Next.js dev)
- `server.js` (lines 589-1149) — Node server version (production)

They should produce identical results. Parser extracts: title, category, importance, deadline, owner, links from WeChat notification text.

**Notice types**: 科研, 教学, 研究生, 学工, 保密, 国资, 安全, 国合, 全院, 其他, 行政

## Important File Locations

| File | Purpose |
|------|---------|
| `server.js` | Main production server |
| `lib/storage.js` | File upload and storage |
| `lib/types.ts` | Notice TypeScript types |
| `lib/parser.ts` | Frontend parser (Next.js) |
| `lib/notices.ts` | Notice CRUD (Next.js API route) |
| `app/api/notices/route.ts` | Next.js API route (dev only) |
| `app/page.tsx` | Main React page (Next.js dev) |
| `components/NoticeCard.tsx` | Notice card component |

## Admin Auth

Default password: `ChangeMe@2024` (stored in `data/config.json`, hashed with salt).

## Deployment

GitHub Actions workflow in `.github/workflows/deploy.yml` deploys to Tencent CloudBase on push to main/master.