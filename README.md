# PDF Studio

A clean, responsive interface for the PDF Studio application. Four workflows are included: book chapter mapping, question extraction, a LaTeX studio, and a cam scanner.

## Cam Scanner mode

The fourth tool turns the device camera, uploaded photos or PDF files into clean scanned pages, entirely in the browser:

- **Capture / import** — "Use camera" opens the rear camera (getUserMedia) with a shutter for multi-page capture; "Upload images / PDF" and drag-and-drop accept JPG/PNG images **and PDF files** (every PDF page is rasterized into an editable page). Captures are downscaled to a 2048-px long edge so pixel processing stays fast on mobile.
- **Perspective crop** — **every captured or uploaded photo is auto-cropped in the background**, for any document type: pages, ID cards, receipts, dark or glossy cards. Detection is a **six-point dual-path contour engine** (the scanner-industry outline: top-left, top-center, top-right, bottom-right, bottom-center, bottom-left — the center vertices follow edges that bow, like a book gutter). It runs on **raw luminance** (background-normalized images would brighten a dark carpet/table until it looked like paper, erasing the very contrast that separates document from background) through two simultaneous preprocessing paths whose best-confidence survivor wins: **Path A** (clean, high-contrast frames) — grayscale → **bilateral filter** (melts texture noise, keeps edges) → **Otsu global binarization** → **Canny edge detection** on the binary; **Path B** (shadows, low contrast, white-on-white) — grayscale → **heavy median blur** → **adaptive Gaussian threshold** (block 15, C 2) → **morphological closing with an elliptical kernel** bridging broken edge segments. Each path's largest mass is **convex-hulled** and **Douglas–Peucker-simplified with the epsilon auto-tuned from 0.02·perimeter until exactly 6 dominant vertices** emerge, ordered clockwise into the canonical layout; the polygon is rejected outright unless strictly **convex and ≥ 20% of the frame**, and among survivors the best **confidence** (perimeter edge support + coverage, area-ranked so text clusters can't beat the document outline) wins. The hexagon's corner vertices then get the **blurred-field boundary sweep** refinement (perpendicular rays, two-strip separation, sub-pixel, polarity-aware) and the **content-aware anti-clip snap**, with a hair-**inside** bias — a background sliver in the crop is far more visible than the sliver of page it trades for. If both paths decline, the **multi-detector pipeline** (Hough line pairs, bright/dark segmentation, edge density, polarity-aware scoring; frame borders included so pages cut off by the photo edge crop correctly) runs as the cognitive fallback, and if everything declines, a **Smart Margin Fallback** lays down a perfectly centered outline at 10% padding for the user to tweak manually. Warping is **piecewise affine**: straight-sided pages use the quad grid, while a genuinely bowed six-point outline is flattened by a four-triangle mesh matched to the output rectangle by arc length, so gutter curves are flattened instead of smeared. Finally a **content-aware anti-clip snap** applies an "ink" mask (dark-on-locally-bright pixels — text, ruled lines, card print; dark table backdrops explicitly fail this test) and pushes each edge outward just enough that no document content is clipped, bounded so stray marks can't inflate the crop. If nothing scores above a confidence floor the app crops nothing rather than guessing wrong. The crop editor shows the outline as **four corner handles plus four mid-edge handles** (a mid-edge drag slides that whole side in/out while keeping it parallel to itself) with "Auto detect" / "Whole image" / "Done". Rotating a page carries the crop outline across the rotation (corner coordinates are remapped into the new orientation), so a cropped page stays cropped and the exported page comes out rotated, like rotating a page in a scanner app.
- **Filters** — Original, **SuperScan** (razor-sharp text on pure white), **Magic** (vivid colors on clean white paper, CamScanner-style) and **Grayscale** (clean mono tones). The core operation is **flat-field correction** — each channel is divided by its own blurred background so paper becomes uniformly white and lighting gradients vanish — and sharpening is a noise-floored, luminance-only unsharp mask so edges get crisp without grain or color fringing. Each filter renders a **live thumbnail preview** of the actual page in the Filter panel, like onlinedocscanner's popup.
- **Clean-up eraser** — an Adobe-Scan-style manual eraser (an **Erase** button next to Crop on desktop and in the mobile bar). Brushing over stains, pen marks, smudges or shadows fills them with the color of their **nearest surrounding paper**: each stroke's dabs are rasterized into a mask, a **two-pass chamfer nearest-neighbour transform** finds every masked pixel's closest un-brushed pixel, the stain colors are scrubbed out, and a small box blur over the cleaned region turns the fill into one smooth color gradient with a 1.5-px feathered rim — marks melt into the page instead of being painted flat white. The eraser panel holds a **Size slider, stroke-level Undo/Redo, Clear and Done** plus a **zoom system for precision work**: **pinch-to-zoom and two-finger pan on touch** (one finger draws, two fingers zoom/pan — a pinch that starts mid-stroke cancels the partial stroke cleanly), cursor-centered **wheel zoom** and **Ctrl/middle-drag pan** on desktop, **Ctrl+Z / Ctrl+Y (⌘Z / ⌘Y) keyboard undo/redo** for keyboard devices, and Zoom-/Zoom+/Fit buttons with a live percentage. The brush keeps a constant **on-screen** size, so zooming in makes strokes finer in image space; stroke coordinates are normalized against the transformed canvas, so erasing stays pixel-accurate at any zoom, and the zoom is clipped to the preview frame and fully reset on exit. Strokes are stored normalized to the warped page, so previews and full-resolution exports erase identically, and strokes ride along with 90° rotations (coordinates are remapped like the crop outline). The eraser runs **after the filter and tone pipeline and changes neither** — filters and adjustments behave exactly as before; the eraser just repairs the final image, so it stays WYSIWYG no matter which filter is active.
- **Manual adjustments** — brightness, contrast, sharpness and saturation sliders per page, with reset, plus "Apply to all pages" for both filters and adjustments.
- **Manage pages** — thumbnail strip with quick reorder, delete, and add-more; the active page is edited in place. A dedicated **Rearrange mode** (toolbar button, enabled from two pages) shows all pages as a large grid where they can be **drag-and-drop reordered** — with per-page move-earlier/later arrow buttons as the touch fallback — plus delete, so multi-page documents can be assembled in any order before export.
- **Export** — a single **Export** button (desktop and mobile) opens a dropdown menu where the format is chosen per export: **PDF** (pages placed on A4, Letter, or a fit-to-image sheet per the saved preference, with none/small/normal margins and scans auto-centered and rotated to match), **JPG** or **PNG** (single download, sequential downloads, or a ZIP — multi-image exports are always ZIP-packaged on iOS-like browsers). The **Settings → Cam scanner** tab holds the defaults: export quality with three presets (Small file 60% / Balanced 80% / Best 92%) **plus a fine-tune slider (40–100%)** for a custom value — applied to JPG exports and PDF embeds; PNG stays lossless — plus page size and margins. Exports always re-render from the full-resolution capture, not the preview. The document name is edited inline on desktop; on mobile a pencil button opens a rename dialog.
- **Instant rotation** — rotating a page snaps immediately: the rendered preview bitmap is rotated in place with a single canvas draw (exact, because the enhancement pipeline is rotation-invariant) and a render-signature check prevents the preview effect from re-running the whole pipeline for the rotation, while the crop outline is remapped along with it. Exports still render from the full-resolution capture at the new angle.

Everything is client-side canvas processing — no uploads. Camera capture requires HTTPS (or localhost) and camera permission; if it is blocked, upload remains available.

**Performance** — the pipeline is tuned to stay snappy at any page count: rotate + perspective-warp run at the TARGET resolution (previews, thumbnails and interactive slider renders never pay full-capture geometry cost — only exports do), the flat-field background is computed at ¼ resolution and bilinearly upsampled (~16× cheaper, visually identical), decoded images are kept in a true LRU cache instead of a wipe-all, slider renders are throttled with a debounced full-quality upgrade, rotation is a single in-place canvas draw, and auto-crop detections on multi-photo imports are serialised with UI yields so the app stays responsive while edges are found in the background.

**Mobile UI** — on phones (≤720px) the editor follows the classic scanner-app layout: a large centered preview, the page strip beneath it, and a **fixed bottom action bar — Crop · Filter · Adjust · Rotate · Export** (no draw tool). Filter and Adjust open as **bottom sheets** over the page (backdrop tap, Done, or Escape closes them) so the preview stays visible while choosing; page delete/reorder live on the always-visible strip buttons; the export menu anchors upward from the bar. Every control meets 44px-class touch-target sizing, safe-area insets are respected on notched devices, horizontal swipes in the strip don't trigger pull-to-refresh, and double-tap-zoom delays are suppressed on scanner controls.

## Dashboard

The app opens on a **Dashboard** landing screen that is now a projects browser for the LaTeX workspace (Prism/Overleaf-style):

- **Sidebar** — "Your projects" (folder overview), "All projects" (every project, most recently updated first), and your workspace **folders** with project counts.
- **Folder rows** — the main panel lists your folders; click one to see the projects inside it.
- **Project open** — clicking a project opens it in **LaTeX Studio on a new screen**, scoped to just that project's files (other folders and projects are not shown).
- **Search & create** — search across all folders and projects by name, and create new folders or projects from the header buttons. Rename and delete are available as hover actions on each row.
- **Tool cards** — below the projects browser sit the three tools: Chapter mapper, Question extractor, and LaTeX studio. The top navigation has a single **Dashboard** entry; all modes are chosen from here, so the upload screen no longer shows a "Choose your workflow" picker. Opening LaTeX studio from the card shows the full workspace.

## What changed

- Added the **LaTeX Studio** mode: an Overleaf-style split workspace where you write or upload LaTeX source, press Compile (or Ctrl+Enter), and preview the generated PDF side by side. Details below.

- Rebuilt the header and upload workspace with a restrained blue accent, consistent spacing, readable typography, and clearer tool selection.
- Added responsive desktop/mobile layouts and automatic light/dark styling.
- Simplified settings to controls that affect the existing pipeline: render quality, export format, and file naming. Settings persist locally on the device.
- Rebuilt question cards with always-visible preview, crop adjustment, copy, and download actions. Removed hard-coded quality/audit claims from the cards.
- Applied a shared visual theme to the existing chapter and crop editors.
- Added inline invalid-file and processing-error feedback; an empty-results state; duplicate-upload protection; and safer workflow switching.
- Fixed the progress prop mismatch that caused invalid progress values.
- Fixed question fullscreen preview for PDF export: preview a raster image rather than loading a PDF into an image element.
- Added focus containment, Escape dismissal, and focus restoration to settings and question-preview dialogs.
- Removed external font requests and the old global fetch shim.
- Added local PDF worker/font/CMap/WASM assets and a configurable hosting port.
- Added production start scripts and a Dockerfile.

## Requirements

- Node.js 22.13 or later (Node 22 LTS recommended).
- npm and internet access to install the dependencies from the supplied project.
- A modern browser with Web Workers and Canvas support.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Development prepares the PDF support assets automatically.

## Check and run for deployment

```bash
npm install
npm run check
npm start
```

`npm run check` runs TypeScript checking and builds the frontend plus the Node server. Do not deploy if this command fails. `npm start` explicitly sets production mode and serves the compiled application.

The server listens on `0.0.0.0` and uses the hosting platform's `PORT` environment variable, falling back to port 3000.

### Node hosting service

- Build command: `npm install && npm run check`
- Start command: `npm start`
- Health check path: `/api/health`
- Deploy the complete project, not only the frontend `dist/assets` folder.
- The app assumes it is served at the domain root, not a nested subpath.

After the first successful install, commit the generated `package-lock.json` and use `npm ci` for repeatable subsequent builds. The old Bun lock was removed because it no longer matches the updated manifest.

### Docker

```bash
docker build -t pdf-studio .
docker run --rm -p 3000:3000 pdf-studio
```

If optional AI features are configured, pass a private environment file with `--env-file .env`. Do not copy secret files into the image.

## LaTeX Studio mode

The third workflow is a compact, Overleaf-style LaTeX workspace:

- **Projects, folders & files** — the sidebar is a draggable tree organized exactly like Overleaf's: optional **folders** group **projects**, and each project holds its `.tex` code files. Folders are optional — projects can live directly in the workspace root, and can be dragged into a folder (or back out to the root) at any time. Files can be dragged between projects. Create, rename, and delete anything; the tree, open file, and layout preferences persist in the browser's localStorage. Importing a dropped or opened `.tex` file adds it to the active project (creating one if needed). Existing saves from earlier versions migrate automatically.
- **Editor** — monospace source editor with a line gutter, Tab indentation, and Ctrl+Enter to compile.
- **Templates** — Blank document, Article, Question paper (exam style), and Math notes. Replacing a non-empty file asks for confirmation.
- **Compile** — two-tier compilation, Overleaf mechanism in miniature:
  1. `POST /api/latex-compile` uses a TeX engine installed on the server host (checked in order: `tectonic`, `xelatex`, `pdflatex`, `lualatex`). Tectonic runs one pass; the classic engines run two so cross-references and tables of contents resolve. Responses are binary PDFs on success or JSON with the compiler log on failure (422).
  2. If the host has no TeX engine (or on a static/serverless deployment, where `api/latex-compile.ts` always answers 501), the editor transparently falls back to a public web compilation service.
- **Preview & export** — the compiled PDF renders inline in the browser viewer, with engine/compile-time/size info and one-click PDF and .tex downloads. An external-link button opens the compiled PDF in its own browser tab. An optional **Auto** toggle recompiles shortly after you stop typing (after the first manual compile). For batch export, select any files in the sidebar (or **Select all**) and download either a ZIP of the `.tex` sources or a ZIP that compiles every selected file first — a progress indicator shows which file is building, and failures are reported per file.
- **Layout** — the sidebar and the editor/preview split are both adjustable by dragging their dividers (arrow keys and double-click-to-reset also work; both widths are remembered per browser). On narrow screens the panes stack and the dividers hide.

Errors show the tail of the compiler log inline, so broken documents are debuggable in both tiers. The public fallback is a third-party service — for private or sensitive documents, run a deployment with a server-side TeX engine (install tectonic or MiKTeX/TeX Live on the host) instead.

## Optional AI configuration

AI features (AI chapter mapping, AI chapter-title detection, page analysis) call Gemini through the app's API endpoints. The model priority chain is **`gemini-3.5-flash-lite` first**, with automatic fallback to **`gemini-3.1-flash-lite`** only when the primary model fails. Override the IDs with `GEMINI_PRIMARY_MODEL` / `GEMINI_FALLBACK_MODEL`.

### User-supplied API keys (recommended)

Each user can paste their own Gemini API key in **Settings → Gemini AI** (gear icon):

- The key is stored only in that browser's localStorage — never on the server.
- It is sent per request in the `X-Gemini-API-Key` header and used for that request only.
- **Test connection** runs a live request through the model chain and reports which model answered (`/api/validate-gemini-key`).
- A server-side `GEMINI_API_KEY` is optional; the user's key always wins when both exist. Deployed sites without either key return a clear 401 message from the AI routes.

Copy `.env.example` to `.env` only if you want a server-side fallback key. Keep API keys on the server or in the user's browser; never use a `VITE_` prefix for secrets.

For an internet-facing service with paid AI routes, add authentication, rate limits, request quotas, and appropriate privacy disclosures before launch. The UI redesign is not a security audit, and the original API routes remain unauthenticated.

## Deploy to Vercel

The app deploys to Vercel as a static Vite build plus Node serverless functions under `api/` (no Express server needed):

1. Push the repository to GitHub and import it in Vercel (or run `npx vercel` locally). Vercel reads `vercel.json`: build command `npm run vercel-build`, output directory `dist`, and SPA rewrites.
2. The API endpoints are available at `/api/analyze-page`, `/api/validate-crop`, `/api/map-book-chapters`, `/api/detect-chapter-title`, and `/api/validate-gemini-key` with a 60-second max duration for long AI responses. `/api/latex-compile` also exists there but always returns 501 — serverless functions cannot run a TeX engine, so LaTeX Studio compiles through its public web fallback.
3. Optional: set `GEMINI_API_KEY`, `GEMINI_PRIMARY_MODEL`, and `GEMINI_FALLBACK_MODEL` in Project → Settings → Environment Variables as a server-side fallback key. Most users should instead add their own key in the app's Settings UI.

## Deploy to Netlify

`netlify.toml` builds the frontend only; the `api/` functions do not run there, so AI features require the Node-hosting or Vercel deployment instead.

## Important processing limitations

- Text-based question detection does not add OCR. Image-only/scanned question papers need OCR before upload.
- Automatic boundaries are a starting point; review chapter ranges and question crops before exporting.
- High-resolution rendering of very large PDFs can use substantial browser memory. Prefer appropriate rendering quality scales on constrained devices.
- Question PDF exports contain raster crops, not newly reconstructed vector text.
- No user documents are persisted by this UI; preferences are stored in localStorage.

## Validation status — read before deployment

The redesigned upload/header/settings/progress components were built in an isolated UI test harness, visually reviewed at desktop and 390-pixel mobile widths, and tested for workflow selection, invalid-file handling, file-selection callbacks, settings changes, dialog keyboard behavior, and numeric progress. Both light and dark entry screens were reviewed. See `docs/QA.md` and the included preview screenshots.

All application TS/TSX source modules passed a syntax/transpilation check. This is **not** a full dependency-aware TypeScript check.

**A complete production build, real-PDF integration tests, chapter/crop-editor end-to-end tests, downloads, and live AI calls could not be verified in the editing environment because package-registry access was unavailable.** Run the commands and smoke checks below in your own environment before deployment. No live site was deployed.

### Pre-launch smoke checks

- [ ] `npm install` completes; inspect dependencies and commit the lockfile.
- [ ] `npm run check` succeeds.
- [ ] `npm start` serves the app and `/api/health` returns `status: ok`.
- [ ] Upload a bookmarked textbook; review/edit boundaries; export chapter PDFs and JSON.
- [ ] Upload a searchable exam PDF; inspect questions; edit a crop; export JPG, PNG, PDF, and ZIP.
- [ ] Check no-question, damaged-PDF, password-protected-PDF, and oversized-file cases.
- [ ] Test the results and crop editor on your supported mobile and desktop browsers.
- [ ] Configure and test available AI model IDs if using server-side enhancements.
- [ ] In LaTeX Studio: compile the Blank template, check the preview and PDF download, introduce a deliberate error and confirm the log appears, then toggle Auto and edit to confirm recompilation stops when typing stops.
- [ ] Add public-deployment security controls before exposing paid AI routes.
