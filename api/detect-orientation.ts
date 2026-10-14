import { detectOrientationHandler, resolveApiKey } from "../server/aiHandlers.js";

export default async function handler(req: any, res: any) {
  if (res.setHeader) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gemini-API-Key, Authorization");
  }

  if (req.method === "OPTIONS") {
    if (typeof res.status === "function") return res.status(200).json({});
    res.statusCode = 200;
    return res.end();
  }

  if (req.method !== "POST") {
    if (typeof res.status === "function") return res.status(405).json({ error: "Method not allowed. Use POST." });
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
  }

  try {
    const requestKeyHeader = req.headers?.["x-gemini-api-key"] || req.headers?.["X-Gemini-API-Key"];
    const requestKey = Array.isArray(requestKeyHeader) ? requestKeyHeader[0] : requestKeyHeader;
    const apiKey = resolveApiKey(requestKey, process.env.GEMINI_API_KEY);

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    const result = await detectOrientationHandler(body || {}, apiKey);
    if (result.modelUsed && typeof res.setHeader === "function") {
      res.setHeader("X-Gemini-Model-Used", result.modelUsed);
    }
    const status = result.status || 200;
    if (typeof res.status === "function") return res.status(status).json(result.json);
    res.statusCode = status;
    return res.end(JSON.stringify(result.json));
  } catch (error: any) {
    console.error("detect-orientation failed:", error);
    const status = error?.statusCode || 500;
    const errPayload = { error: error?.message || "AI orientation detection failed." };
    if (typeof res.status === "function") return res.status(status).json(errPayload);
    res.statusCode = status;
    return res.end(JSON.stringify(errPayload));
  }
}
