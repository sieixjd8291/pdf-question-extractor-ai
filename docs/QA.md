# Validation notes

The upload/header/settings/progress UI was tested separately from PDF and backend integrations. The test harness used the actual React components, handcrafted CSS, and equivalent Lucide icons from the installed react-icons package. It was not a production Vite build. The deployment project still uses its original lucide-react dependency.

Visually reviewed: desktop light/dark upload screens; mobile initial screen, question-upload validation error, settings, and processing. Keyboard focus containment, Escape dismissal, mode switching, settings changes, upload validation/callback, and numeric progress passed UI checks. Legacy chapter/crop-editor rendering, real PDFs, downloads, and live AI were not tested.

Production build verification remains required because package registry access was unavailable. See README.md for deployment instructions and pre-launch checks.
