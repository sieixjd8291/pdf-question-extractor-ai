# Codebase Audit & Safe Dead Code Elimination Plan

Comprehensive audit of all files, routes, assets, and source lines to eliminate redundant files, stale lockfiles, duplicate serverless wrappers, heavy test fixtures, and dead code without impacting application functionality.

> [!IMPORTANT]
> **User Choices Confirmed:**
> - **Approach**: Detailed audit and safe cleanup.
> - **Target Categories**: Redundant/legacy API routes and server files, unused frontend code/utility functions, unused test scripts and test fixtures in `scripts/`.
>
> **Critical Decisions Before Deletion:**
> 1. **Vercel Serverless Wrappers (`api/*` & `server/vercel_lib.ts`)**: In the AI Studio runtime (and Node/Express deployments), the backend is driven exclusively by `server/server.ts`. The root `/api/*` directory contains 10 duplicate serverless functions that wrap the server handlers. If Vercel deployment is not needed, these can be safely pruned, consolidating all API routing into `server/`.
> 2. **Verification Fixtures & Test Scripts (`scripts/fixtures/` & `scripts/verify-*.ts`)**: The 3.6 MB fixture bundle and associated verification scripts (`verify-crop-detection.ts`, `verify-local-edges.ts`, etc.) are developer-only test harnesses. Removing them saves substantial repo size and clutter while leaving application build scripts (`copy-pdf-assets.mjs`, `start.mjs`, `sw-template.js`) intact.
> 3. **Stale Lockfiles & One-Time Scripts**: `bun.lock` (42 KB) is a leftover from a Bun environment (the repo uses `npm`). `scripts/fetch-handwriting-fonts.mjs` was a one-time font scraper whose assets are already checked in.

---

## 1. Overview & Core Findings

Our audit scanned all 85+ source files, server routes, build tools, and assets using AST parsers and TypeScript strict diagnostics. We categorized all findings into 4 clear buckets:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CODEBASE AUDIT BREAKDOWN                        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. STALE ARTIFACTS & LEFTOVERS                                         │
│    • bun.lock (42 KB) - Unused Bun lockfile (project runs on npm)      │
│    • docs/QA.md - Obsolete manual QA scratchpad                        │
│                                                                        │
│ 2. ONE-TIME / NON-RUNTIME UTILITIES                                    │
│    • scripts/fetch-handwriting-fonts.mjs - One-off Google Fonts scraper│
│    • scripts/build-wasm.mjs - Rust build script (WASM is committed)    │
│    • rust/handwriting-engine/ - Uncompiled Rust source (WASM active)   │
│                                                                        │
│ 3. DUPLICATE VERCEL SERVERLESS ROUTING                                 │
│    • api/ (10 endpoints: analyze-page, detect-orientation, etc.)       │
│    • server/vercel_lib.ts - Types and helpers for Vercel functions    │
│                                                                        │
│ 4. TEST HARNESS & LARGE IMAGE FIXTURES                                 │
│    • scripts/fixtures/ (3.6 MB of heavy PNG/JPG reference images)     │
│    • scripts/verify-crop-detection.ts, verify-local-edges.ts, etc.    │
│    • package.json test scripts referencing deleted fixtures            │
│                                                                        │
│ 5. DEAD CODE IN ACTIVE SOURCE FILES                                    │
│    • src/lib/activityTracker.ts - Unused ActivityStats export         │
│    • src/components/CompressDialog.tsx - Unused React import          │
│    • src/components/assignment/QuickBar.tsx - Dead onActiveGuide prop │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed File-by-File Audit

### Group A: Stale Files & Residual Artifacts (Safe to Delete)
- **`bun.lock`**: Stale 42 KB lockfile. Project defines `"packageManager": "npm@10.9.2"` and maintains `package-lock.json`.
- **`docs/QA.md`**: Legacy developer notes describing mock tests from early staging.

### Group B: One-Time Offline Generator Scripts
- **`scripts/fetch-handwriting-fonts.mjs`**: Fetched Google Fonts and generated `public/fonts/handwriting/fonts.css`. Font binaries and CSS are checked in; script is unreferenced by build.
- **`scripts/build-wasm.mjs`**: Compiles `rust/handwriting-engine` to WASM. `src/lib/handwriting/handwriting_engine.wasm` is already checked into Git and loaded by the app.
- **`rust/` directory**: Rust source crate. Runtime relies strictly on the pre-built `.wasm` module.

### Group C: Duplicate Serverless API Functions (`api/*` & `server/vercel_lib.ts`)
- The Express server (`server/server.ts`) handles all 10 API endpoints:
  - `/api/health`
  - `/api/analyze-page`
  - `/api/detect-orientation`
  - `/api/local-orient`
  - `/api/validate-crop`
  - `/api/map-book-chapters`
  - `/api/detect-chapter-title`
  - `/api/validate-gemini-key`
  - `/api/latex-compile`
  - `/api/latex-repair`
- The `/api/*.ts` files duplicate these handlers using Vercel serverless function syntax. `server/vercel_lib.ts` exists solely to assist those Vercel handlers.
- **Decision**: Remove redundant `/api/` directory and `server/vercel_lib.ts`.

### Group D: Large Test Fixtures & Standalone Verification Scripts
- **`scripts/fixtures/`**: 6 image files totalling ~3.6 MB:
  - `complete-spread-reference.png`
  - `notebook-crop-screenshot.png`
  - `notebook-persistent-reference.png`
  - `original-notebook.jpg`
  - `partial-facing-page-reference.png`
  - `partial-notebook-reference.png`
- **`scripts/verify-*.ts`**: Test verification scripts (`verify-crop-detection.ts`, `verify-local-edges.ts`, `verify-orientation.ts`, `verify-latex-repair.ts`).
- **Essential Scripts Preserved**:
  - `scripts/copy-pdf-assets.mjs` (Required by `npm run prepare:pdf` before every dev and build run)
  - `scripts/start.mjs` (Required by `npm start`)
  - `scripts/sw-template.js` (Required by `vite.config.ts` PWA service worker builder)

### Group E: Dead Code in Core Source Files
1. **`src/lib/activityTracker.ts`**:
   - `export interface ActivityStats`: Not imported or referenced in any source or type definition. Remove interface.
2. **`src/components/CompressDialog.tsx`**:
   - `import React, { ... }`: Unused default `React` import. Clean import to `{ useEffect, useMemo, useRef, useState }`.
3. **`src/components/assignment/QuickBar.tsx`**:
   - `onActiveGuide` prop in `QuickBarProps`: Defined and destructured, but never bound or called anywhere in `QuickBar`. Remove prop from definition and destructuring.

---

## 3. Execution Plan

1. **Phase 1: Source Code Cleanup (Dead Code Lines)**
   - Remove unused `ActivityStats` interface in `src/lib/activityTracker.ts`.
   - Remove unused `React` default import in `src/components/CompressDialog.tsx`.
   - Remove unused `onActiveGuide` prop in `src/components/assignment/QuickBar.tsx`.

2. **Phase 2: Remove Stale & Redundant Files**
   - Delete `bun.lock`.
   - Delete `docs/QA.md`.
   - Delete `scripts/fetch-handwriting-fonts.mjs` and `scripts/build-wasm.mjs`.
   - Delete `scripts/fixtures/` directory and test verification scripts (`scripts/verify-*.ts`).
   - Delete duplicate `api/` directory (10 serverless files) and `server/vercel_lib.ts`.

3. **Phase 3: Package & Config Alignment**
   - In `package.json`, remove obsolete test scripts (`test:orientation`, `test:crop`, `test:latex-repair`) that pointed to the deleted verification scripts.
   - Clean up `vercel.json` if applicable.

4. **Phase 4: Full Build & Type Verification**
   - Run `tsc --noEmit` (`npm run lint`) to guarantee 0 compiler errors.
   - Run `npm run build` (`vite build && esbuild server`) to verify full client and server bundle compilation.
   - Verify server startup and dev server health.
