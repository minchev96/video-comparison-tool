# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Live Website Comparison Mode

The `Live` page now supports website-to-website comparison by running two remote browser pages on a local backend and mirroring interactions to both.

### Start the backend service

```bash
npm run dev:live
```

### Start the frontend

```bash
npm run dev
```

### One-time Playwright setup

Install Chromium for Playwright if it is not already installed:

```bash
npx playwright install chromium
```

### Notes

- The top rendered website view is interactive; clicks, wheel, and keyboard actions are mirrored to both websites.
- The backend endpoint is proxied through Vite (`/api -> http://localhost:8787`).
