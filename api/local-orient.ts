import multer from "multer";
import type { RequestHandler } from "express-serve-static-core";
import { handleAutoOrientRoute } from "../server/handwrittenOrientationService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
}).single("image") as unknown as RequestHandler;

export const config = { api: { bodyParser: false } };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      upload(req, res, (err: unknown) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : "Invalid upload.",
    });
    return;
  }

  await handleAutoOrientRoute(req, res, () => undefined);
}
