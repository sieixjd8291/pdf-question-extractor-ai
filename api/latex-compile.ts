import { compileRemote } from '../server/latexHandler.js';

export const config = { maxDuration: 150 };

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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST to compile.' });
  const { tex, files } = req.body || {};
  if (typeof tex !== 'string' || !tex.trim()) return res.status(400).json({ error: 'Provide non-empty LaTeX source.' });
  if (Buffer.byteLength(tex, 'utf8') > 4 * 1024 * 1024) return res.status(413).json({ error: 'LaTeX source exceeds the 4 MB limit.' });
  if (files !== undefined && (!Array.isArray(files) || files.length > 100 || files.some(file => !file || typeof file.name !== 'string' || typeof file.content !== 'string') || files.reduce((size, file) => size + Buffer.byteLength(file.content, 'utf8'), Buffer.byteLength(tex, 'utf8')) > 4 * 1024 * 1024)) return res.status(400).json({ error: 'Invalid or oversized project resources.' });
  try {
    const outcome = await compileRemote(tex, files);
    if (outcome.pdf) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('X-LaTeX-Engine', outcome.engine || 'pdflatex');
      res.setHeader('X-LaTeX-Via', 'remote');
      return res.status(200).send(outcome.pdf);
    }
    return res.status(outcome.statusCode).json(outcome.json);
  } catch (error: any) {
    console.error('LaTeX compile failed:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'LaTeX compilation failed.' });
  }
}

