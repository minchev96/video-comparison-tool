# Video Comparison Tool

A React + Vite application for comparing local video/image sources and live websites side by side.

## What It Includes

- File-based comparison workspace on `/`.
- Live website comparison workspace on `/live`.
- Reverse-proxy backend for loading two remote websites in same-origin iframes.
- Mirrored interaction replay, network response capture/replay, and worker-driven pixel diffing.

## Scripts

- `npm run dev` starts the Vite frontend.
- `npm run dev:live` starts the live comparison backend on port `8787`.
- `npm run build` creates a production build.
- `npm run lint` runs ESLint across the workspace.
- `npm run preview` serves the production build locally.

## Live Website Comparison

The live mode loads two target websites through the local reverse proxy and keeps them in sync by mirroring user actions, replaying special network traffic, and diffing the rendered frames in the browser.

### Setup

Install dependencies first:

```bash
npm install
```

Install Chromium for Playwright if it is not already available:

```bash
npx playwright install chromium
```

Start the backend and frontend in separate terminals:

```bash
npm run dev:live
```

```bash
npm run dev
```

### Notes

- The top rendered website view is interactive; clicks, wheel, and keyboard actions are mirrored to both websites.
- The proxy endpoint is exposed through Vite as `/api -> http://localhost:8787`.
- The compare UI includes a threshold control, an animation-exclusion toggle, and live mismatch diagnostics.
