import express from "express";
import { createServer as createHttpServer } from "node:http";
import path from "path";
import dotenv from "dotenv";
import {
  analyzePageHandler,
  detectChapterTitleHandler,
  detectOrientationHandler,
  mapBookChaptersHandler,
  validateCropHandler,
  validateGeminiKeyHandler,
  resolveApiKey,
  AiHandlerResult,
  GEMINI_MODEL_CHAIN,
} from "./aiHandlers";
import { compileLatex } from "./latexHandler";
import { automaticallyRepairLatex } from "./latexRepairHandler";
import { handleAutoOrientRoute } from "./handwrittenOrientationService";
import multer from "multer";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.disable("x-powered-by");

// Middleware for parsing large JSON payloads (unrestricted file size)
app.use(express.json({ limit: "2000mb" }));
app.use(express.urlencoded({ extended: true, limit: "2000mb" }));

// The browser may send a user-supplied Gemini key with every AI request
// (X-Gemini-API-Key); it always wins over the server environment key.
function keyFromRequest(req: express.Request): string {
  const headerValue = req.headers["x-gemini-api-key"];
  const requestKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return resolveApiKey(requestKey, process.env.GEMINI_API_KEY);
}

function sendAiResult(res: express.Response, result: AiHandlerResult) {
  if (result.modelUsed) res.setHeader("X-Gemini-Model-Used", result.modelUsed);
  res.json(result.json);
}

// Centralized error mapping for the AI handlers
function aiRoute(handler: (req: express.Request) => Promise<AiHandlerResult>) {
  return async (req: express.Request, res: express.Response) => {
    try {
      const result = await handler(req);
      sendAiResult(res, result);
    } catch (error: any) {
      console.error(`AI route ${req.path} failed:`, error?.message || error);
      res
        .status(error.statusCode || 500)
        .json({ error: error.message || "AI request failed" });
    }
  };
}

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    models: GEMINI_MODEL_CHAIN,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/analyze-page", aiRoute((req) =>
  analyzePageHandler(req.body, keyFromRequest(req))));

app.post("/api/detect-orientation", aiRoute((req) =>
  detectOrientationHandler(req.body, keyFromRequest(req))));

app.post("/api/local-orient", upload.single("image"), handleAutoOrientRoute);

app.post("/api/validate-crop", aiRoute((req) =>
  validateCropHandler(req.body, keyFromRequest(req))));

app.post("/api/map-book-chapters", aiRoute((req) =>
  mapBookChaptersHandler(req.body, keyFromRequest(req))));

app.post("/api/detect-chapter-title", aiRoute((req) =>
  detectChapterTitleHandler(req.body, keyFromRequest(req))));

app.post("/api/validate-gemini-key", aiRoute(async (req) => {
  const hasKey = Boolean(req.headers["x-gemini-api-key"] || process.env.GEMINI_API_KEY);
  if (!hasKey) {
    return { json: { valid: false, error: "No API key provided." } };
  }
  return validateGeminiKeyHandler(keyFromRequest(req));
}));

// LaTeX Studio: compile a .tex source with local TeX engine or remote fallback.
// Binary PDF on success; JSON error (with compiler log on 422) otherwise.
app.post("/api/latex-compile", async (req, res) => {
  try {
    const outcome = await compileLatex(req.body?.tex, req.body?.files);
    if (outcome.pdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("X-LaTeX-Engine", outcome.engine || "tex");
      if (outcome.via) res.setHeader("X-LaTeX-Via", outcome.via);
      res.send(outcome.pdf);
    } else {
      res.status(outcome.statusCode).json(outcome.json);
    }
  } catch (error: any) {
    console.error("LaTeX compile route failed:", error?.message || error);
    res.status(500).json({ error: error.message || "LaTeX compilation failed." });
  }
});

app.post('/api/latex-repair', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const result = await automaticallyRepairLatex(req.body, req.get('x-gemini-api-key') || undefined);
    res.status(result.status).json(result.json);
  } catch (error: any) {
    console.error("LaTeX repair route failed:", error?.message || error);
    res.status(500).json({ error: error?.message || "LaTeX repair failed." });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

async function startServer() {
  const httpServer = createHttpServer(app);
  // Vite middleware in development
  if (process.env.NODE_ENV !== "production") {
    const {createServer} = await import("vite");
    const vite = await createServer({
      server: {
        middlewareMode: true,
        // Share the proxied HTTP port instead of opening an unreachable HMR port.
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    const status = Number(error?.status || error?.statusCode) || 500;
    res.status(status).json({ error: status === 500 ? "Internal server error." : error?.message || "Request failed." });
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`PDF Studio server listening on port ${PORT}`);
  });
}

startServer().catch(error=>{console.error("Server startup failed:",error);process.exit(1);});
