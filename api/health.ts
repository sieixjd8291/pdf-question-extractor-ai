import { GEMINI_MODEL_CHAIN } from "../server/aiHandlers.js";

export default async function handler(req: any, res: any) {
  if (res.setHeader) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Gemini-API-Key, Authorization");
  }

  if (req.method === "OPTIONS") {
    if (typeof res.status === "function") return res.status(200).json({});
    res.statusCode = 200;
    return res.end();
  }

  const payload = {
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    models: GEMINI_MODEL_CHAIN,
    timestamp: new Date().toISOString(),
  };

  if (typeof res.status === "function") return res.status(200).json(payload);
  res.statusCode = 200;
  return res.end(JSON.stringify(payload));
}

