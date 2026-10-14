import { automaticallyRepairLatex } from '../server/latexRepairHandler.js';
import { apiKeyFromRequest, getParsedBody, jsonError } from '../server/vercel_lib.js';

export const maxDuration = 300;

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonError(res, 405, 'Method not allowed. Use POST.');
  }
  try {
    const result = await automaticallyRepairLatex(getParsedBody(req), apiKeyFromRequest(req));
    res.status(result.status).json(result.json);
  } catch (error: any) {
    console.error('LaTeX repair failed:', error?.message || error);
    jsonError(res, 500, error?.message || 'LaTeX repair failed.');
  }
}
