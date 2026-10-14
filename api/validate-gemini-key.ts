import { validateGeminiKeyHandler } from "../server/aiHandlers.js";

export default async function handler(req: any, res: any) {
  if (res.setHeader) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gemini-API-Key, Authorization");
  }

  if (req.method === "OPTIONS") {
    if (typeof res.status === "function") {
      return res.status(200).json({});
    }
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "POST") {
    if (typeof res.status === "function") {
      return res.status(405).json({ error: "Method not allowed. Use POST." });
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
  }

  try {
    const requestKeyHeader =
      req.headers?.["x-gemini-api-key"] || req.headers?.["X-Gemini-API-Key"];
    const requestKey = Array.isArray(requestKeyHeader) ? requestKeyHeader[0] : requestKeyHeader;
    const keyToUse = (requestKey || "").trim() || (process.env.GEMINI_API_KEY || "").trim();

    if (!keyToUse) {
      if (typeof res.status === "function") {
        return res.status(200).json({
          valid: false,
          error: "No API key provided. Paste your Gemini API key, then test again.",
        });
      }
      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          valid: false,
          error: "No API key provided. Paste your Gemini API key, then test again.",
        })
      );
    }

    const result = await validateGeminiKeyHandler(keyToUse);
    if (result.modelUsed && typeof res.setHeader === "function") {
      res.setHeader("X-Gemini-Model-Used", result.modelUsed);
    }

    const status = result.status || 200;
    if (typeof res.status === "function") {
      return res.status(status).json(result.json);
    }
    res.statusCode = status;
    return res.end(JSON.stringify(result.json));
  } catch (error: any) {
    console.error("validate-gemini-key failed:", error);
    const errPayload = {
      valid: false,
      error: error?.message || "Server error while validating Gemini API key.",
    };
    if (typeof res.status === "function") {
      return res.status(500).json(errPayload);
    }
    res.statusCode = 500;
    return res.end(JSON.stringify(errPayload));
  }
}

