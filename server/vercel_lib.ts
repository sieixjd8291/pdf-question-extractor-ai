/**
 * Minimal local typings for Vercel Node serverless functions.
 * Avoids adding @vercel/node as a dependency just for types.
 */
export interface ApiRequest {
  method?: string;
  body?: any;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status?(code: number): ApiResponse;
  setHeader?(name: string, value: string): ApiResponse;
  json?(body: unknown): void;
  statusCode?: number;
  end?(chunk?: any): void;
}

/** Standard HTTP handler wrapper shared by all api/*.ts functions. */
export function jsonError(res: any, statusCode: number, message: string): void {
  const errorData = { error: message };
  if (typeof res.status === "function") {
    res.status(statusCode);
    if (typeof res.json === "function") {
      res.json(errorData);
      return;
    }
  }
  res.statusCode = statusCode;
  if (res.setHeader) res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(errorData));
}

/** Safely returns the request body as an object regardless of whether Vercel passed it pre-parsed or stringified. */
export function getParsedBody(req: ApiRequest): any {
  if (!req || !req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

/** Extracts the user-supplied Gemini key header (if any) from a Vercel request. */
export function apiKeyFromRequest(req: ApiRequest): string | undefined {
  if (!req.headers) return undefined;
  for (const [key, val] of Object.entries(req.headers)) {
    if (key.toLowerCase() === 'x-gemini-api-key') {
      return Array.isArray(val) ? val[0] : val;
    }
  }
  return undefined;
}
