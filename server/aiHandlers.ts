/**
 * Shared Gemini AI logic used by both the local Express server (server.ts)
 * and the Vercel serverless functions (api/*.ts).
 *
 * This module intentionally uses the Gemini REST API via plain `fetch`
 * instead of the @google/genai SDK: serverless bundlers can crash while
 * loading the SDK (FUNCTION_INVOCATION_FAILED), while fetch-based calls have
 * no dependencies and work in any Node runtime.
 *
 * Model priority: the primary Flash Lite model is always tried first and the
 * chain falls back to the secondary model only if the primary request fails.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** REST schema type enums (Gemini API accepts the uppercase Type names). */
const Type = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
} as const;

export const GEMINI_MODEL_CHAIN = [
  process.env.GEMINI_PRIMARY_MODEL || "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];

export class MissingKeyError extends Error {
  statusCode = 401;
  constructor() {
    super(
      "No Gemini API key available. Get a 100% free Gemini API key at Google AI Studio (aistudio.google.com/apikey) and paste it in Settings, or add GEMINI_API_KEY in your Vercel Environment Variables."
    );
  }
}

export class ModelChainError extends Error {
  statusCode = 502;
  attemptedModels: string[];
  constructor(message: string, attemptedModels: string[]) {
    super(message);
    this.attemptedModels = attemptedModels;
  }
}

export class InvalidPayloadError extends Error {
  statusCode = 400;
}

/**
 * Normalizes input parts or contents into the strict Gemini REST API `contents` format:
 * [
 *   {
 *     "role": "user",
 *     "parts": [ { "text": "..." }, { "inlineData": { ... } } ]
 *   }
 * ]
 */
export function normalizeContents(input: any): any[] {
  if (!input) return [];

  // Single string prompt
  if (typeof input === "string") {
    return [{ role: "user", parts: [{ text: input }] }];
  }

  // Already a single Content object: { parts: [...] }
  if (!Array.isArray(input) && typeof input === "object" && Array.isArray(input.parts)) {
    return [{ role: input.role || "user", parts: input.parts }];
  }

  if (Array.isArray(input)) {
    if (input.length === 0) return [];

    // Already an array of Content objects (where each item has a `parts` array)
    const isArrayOfContentObjects = input.every(
      (item) => item && typeof item === "object" && Array.isArray(item.parts)
    );
    if (isArrayOfContentObjects) {
      return input.map((item) => ({
        role: item.role || "user",
        parts: item.parts,
      }));
    }

    // Otherwise, input is an array of Part objects (e.g. [{ inlineData: ... }, { text: ... }])
    // or string parts. Clean and group them into a single Content object with `parts`.
    const parts = input
      .map((item) => {
        if (typeof item === "string") {
          return { text: item };
        }
        if (item && typeof item === "object") {
          if ("text" in item || "inlineData" in item || "functionCall" in item || "functionResponse" in item) {
            return item;
          }
        }
        return null;
      })
      .filter(Boolean);

    return [{ role: "user", parts: parts.length > 0 ? parts : [{ text: "" }] }];
  }

  return [{ role: "user", parts: [{ text: String(input) }] }];
}

/**
 * Per-request API key (sent by the browser as the X-Gemini-API-Key header)
 * always wins over the server-configured environment key.
 */
export function resolveApiKey(
  requestKey?: string | null,
  envKey?: string
): string {
  const key = (requestKey || "").trim() || (envKey || "").trim();
  if (!key) throw new MissingKeyError();
  return key;
}

function cleanBase64(imageData: string): string {
  return imageData.replace(/^data:image\/[a-z]+;base64,/, "");
}

function isAuthError(message: string): boolean {
  return /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message);
}

interface GeminiCallConfig {
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * Single REST call to the Gemini generateContent endpoint.
 * Returns the concatenated text parts; throws with the API's error message.
 */
async function callGemini(
  apiKey: string,
  model: string,
  rawContents: any,
  config: GeminiCallConfig
): Promise<string> {
  const contents = normalizeContents(rawContents);
  const generationConfig: Record<string, unknown> = {};
  if (config.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
  if (config.responseSchema) generationConfig.responseSchema = config.responseSchema;
  if (typeof config.maxOutputTokens === "number") {
    generationConfig.maxOutputTokens = config.maxOutputTokens;
  }
  if (typeof config.temperature === "number") {
    generationConfig.temperature = config.temperature;
  }

  const response = await fetch(
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        "User-Agent": "aistudio-build",
      },
      body: JSON.stringify({
        contents,
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      }),
    }
  );

  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gemini API request failed (HTTP ${response.status})`;
    throw new Error(message);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p: any) => (typeof p.text === "string" ? p.text : "")).join("").trim();
  if (!text) throw new Error("Empty response received from AI model");
  return text;
}

/**
 * Runs generateContent against the model chain: primary Flash Lite first,
 * secondary Flash Lite only when the primary attempt fails.
 */
export async function generateJsonWithFallback(
  apiKey: string,
  contents: any[],
  config: GeminiCallConfig
): Promise<{ text: string; modelUsed: string }> {
  const attempted: string[] = [];
  let lastError: unknown = null;

  for (const model of GEMINI_MODEL_CHAIN) {
    attempted.push(model);
    try {
      const text = await callGemini(apiKey, model, contents, config);
      return { text, modelUsed: model };
    } catch (err: any) {
      lastError = err;
      console.error(`Gemini request failed for model ${model}:`, err?.message || err);
      if (isAuthError(String(err?.message || ""))) break;
    }
  }

  const lastMessage =
    lastError instanceof Error ? lastError.message : String(lastError || "Unknown error");
  if (isAuthError(lastMessage)) {
    throw new ModelChainError(
      "Gemini rejected the API key. Check the key in Settings or on the server.",
      attempted
    );
  }
  throw new ModelChainError(
    `All Gemini models failed (tried: ${attempted.join(", ")}). Last error: ${lastMessage}`,
    attempted
  );
}

export type AiHandlerResult = { json: any; modelUsed?: string; status?: number };

/**
 * POST /api/analyze-page
 * Analyzes a single PDF page image and detects individual question boundaries.
 */
export async function analyzePageHandler(
  body: any,
  apiKey: string
): Promise<AiHandlerResult> {
  const {
    imageData,
    pageNumber,
    totalPages,
    pageText,
    columnLayout = "auto",
  } = body || {};

  if (!imageData) throw new InvalidPayloadError("Missing imageData in request body");

  const base64Data = cleanBase64(String(imageData));

  const prompt = `You are a world-class Document AI specialized in analyzing examination papers, academic worksheets, assignments, problem sets, and test questionnaires (printed, scanned, handwritten, or digital).

PAGE CONTEXT:
- Page Number: ${pageNumber} of ${totalPages}
- Detected Layout Hint: ${columnLayout}
${pageText ? `- Extracted Text Fragment: "${String(pageText).slice(0, 1000)}..."` : ""}

CRITICAL EXTRACTION DIRECTIVES:
1. DETECT EVERY NUMBERED QUESTION INDIVIDUALLY (MANDATORY):
   - Every single numbered item (e.g., "1.", "2.", "3.", "4.", "5.", "6.", "Q1", "Q2", "Question 1", "Problem 1", "(1)", "(2)") MUST be an independent, separate question entry in the questions array.
   - STRICT PROHIBITION: DO NOT GROUP multiple questions together (e.g., NEVER combine questions 1, 2, 3 into a single box). Each numbered problem must have its own discrete bounding box.
   - Question 1 begins at "1." and ends immediately before "2." begins. Question 2 begins at "2." and ends immediately before "3." begins, etc.
   - If Question 3 has sub-parts like (a), (b), (c) with formulas or equations, include all sub-parts inside Question 3's bounding box until Question 4 starts.

2. STRICT HEADER & FOOTER EXCLUSIONS (DO NOT INCLUDE IN BOUNDING BOXES):
   - STRICTLY EXCLUDE university names, institution headers, department banners, paper names (e.g. "Paper Name: Mathematics"), paper codes ("Paper Code: BSCM203A"), semester info ("Semester: I"), module titles ("Module 5: Infinite Series"), assignment titles ("Assignment 1"), and faculty names ("Faculty Name: Dr. Suparna Sen").
   - Question 1's top edge (ymin) MUST start right at the "1." text line — NEVER at the top of the document or inside the university header.
   - Ignore page numbers (e.g. "- 1 -", "Page 1 of 4"), scanner borders, and watermarks.

3. ACCURATE BOUNDING BOX [ymin, xmin, ymax, xmax] (0 to 1000 normalized integer scale):
   - Tight yet complete: Include the question number, prompt text, mathematical formulas, fractions, radicals, limits, summation symbols, tables, and diagrams belonging to that specific question.
   - Ensure width covers the problem text and formula margins (xmin typically ~40-80, xmax ~920-960 for standard full-width pages).

4. QUALITY & CONFIDENCE:
   - Provide confidence score (0.0 to 1.0) and title_summary containing the opening line/summary of that specific question.

Return a structured JSON object.`;

  const { text, modelUsed } = await generateJsonWithFallback(
    apiKey,
    [
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: base64Data,
        },
      },
      { text: prompt },
    ],
    {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          page_number: { type: Type.INTEGER },
          detected_layout: {
            type: Type.STRING,
            description: "e.g., 'single-column', 'two-column', 'handwritten', 'scanned-grid'",
          },
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question_number_raw: {
                  type: Type.STRING,
                  description: "e.g., 'Q1', 'Question 2', '3(a)', 'Problem 4'",
                },
                normalized_index: {
                  type: Type.INTEGER,
                  description: "Estimated sequential question number on the test",
                },
                title_summary: {
                  type: Type.STRING,
                  description: "Brief summary or opening line of the question",
                },
                box_2d: {
                  type: Type.ARRAY,
                  items: { type: Type.INTEGER },
                  description: "[ymin, xmin, ymax, xmax] normalized to 0-1000 scale",
                },
                has_diagram: {
                  type: Type.BOOLEAN,
                  description: "True if question includes diagram, image, formula block, or table",
                },
                diagram_types: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "e.g. ['geometric figure', 'circuit diagram', 'table', 'chemical formula']",
                },
                confidence: {
                  type: Type.NUMBER,
                  description: "Detection confidence between 0.0 and 1.0",
                },
                sub_parts_detected: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "e.g. ['(a)', '(b)', '(c)'] or ['(i)', '(ii)']",
                },
                is_continuation_from_previous_page: { type: Type.BOOLEAN },
                continues_to_next_page: { type: Type.BOOLEAN },
                warnings: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Any quality or cropping notes",
                },
              },
              required: [
                "question_number_raw",
                "title_summary",
                "box_2d",
                "has_diagram",
                "confidence",
              ],
            },
          },
          page_warnings: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          page_quality_score: {
            type: Type.NUMBER,
            description: "Overall legibility and scan quality (0.0 to 1.0)",
          },
        },
        required: ["page_number", "questions"],
      },
    }
  );

  return { json: JSON.parse(text), modelUsed };
}

/**
 * POST /api/validate-crop
 * Secondary AI verification for individual cropped question images.
 */
export async function validateCropHandler(
  body: any,
  apiKey: string
): Promise<AiHandlerResult> {
  const { croppedImageData, questionLabel } = body || {};
  if (!croppedImageData) throw new InvalidPayloadError("Missing croppedImageData");

  const base64Data = cleanBase64(String(croppedImageData));

  const prompt = `Validate the quality of this cropped question image (Expected question: "${questionLabel || "Unknown"}").
Check:
1. Is the question title/number clearly visible and complete?
2. Is any text truncated or clipped at the top, bottom, left, or right edges?
3. Are all diagrams, formulas, or tables fully enclosed without being cut in half?
4. Does this crop contain only this question (no accidental overlapping fragments of next question)?
5. Is readability clear?

Return structured JSON.`;

  const { text, modelUsed } = await generateJsonWithFallback(
    apiKey,
    [
      {
        inlineData: {
          mimeType: "image/png",
          data: base64Data,
        },
      },
      { text: prompt },
    ],
    {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          is_valid: { type: Type.BOOLEAN },
          is_text_truncated: { type: Type.BOOLEAN },
          is_question_number_visible: { type: Type.BOOLEAN },
          is_diagram_intact: { type: Type.BOOLEAN },
          is_single_question_only: { type: Type.BOOLEAN },
          readability_score: { type: Type.NUMBER, description: "0.0 to 1.0" },
          suggestions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "is_valid",
          "is_text_truncated",
          "is_question_number_visible",
          "is_diagram_intact",
          "is_single_question_only",
          "readability_score",
        ],
      },
    }
  );

  return { json: JSON.parse(text), modelUsed };
}

/**
 * POST /api/map-book-chapters
 * Book pagination & structural mapping from TOC snippets and candidate headers.
 */
export async function mapBookChaptersHandler(
  body: any,
  apiKey: string
): Promise<AiHandlerResult> {
  const {
    tocText = "",
    candidateChapters = [],
    totalPages,
    bookTitleHint = "",
    tocImageData = null,
    tocImages = [],
    firstPageOffsets = [],
    userInstruction = "",
  } = body || {};

  if (!totalPages || totalPages < 1) {
    throw new InvalidPayloadError("Missing or invalid totalPages");
  }

  const prompt = `You are a world-class Document AI and Book Structural Analysis specialist.
Your task is to analyze the Table of Contents, headings, and structural markers of this long-form book PDF and segregate it into all of its constituent chapters / units with exact physical PDF page boundaries.

DOCUMENT DETAILS:
- Total Physical PDF Pages: ${totalPages}
- Detected/Hinted Book Title: "${bookTitleHint || "Engineering / Academic Textbook"}"
${userInstruction ? `- User Note/Instruction: "${userInstruction}"` : ""}

${tocText ? `EXTRACTED TABLE OF CONTENTS & EARLY PAGES TEXT:
"""
${String(tocText).slice(0, 15000)}
"""` : ""}

${candidateChapters.length > 0 ? `DISCOVERED CANDIDATE HEADING SIGNALS:
${JSON.stringify(candidateChapters.slice(0, 200), null, 2)}` : ""}

${firstPageOffsets.length > 0 ? `DETECTED PRINTED-TO-PHYSICAL PAGE SAMPLES:
${JSON.stringify(firstPageOffsets, null, 2)}` : ""}

CRITICAL REQUIREMENTS & SEGREGATION DIRECTIVES:
1. DETECT EVERY CHAPTER / UNIT IN FULL:
   - Identify ALL chapters, units, or major parts present in the Table of Contents or document.
   - For major textbooks (such as B.S. Grewal, Higher Engineering Mathematics, standard engineering, science, or literature textbooks), extract ALL numbered chapters (e.g. Unit I / Unit II or Chapter 1: Solution of Equations, Chapter 2: Linear Algebra & Matrices, Chapter 3: Vector Calculus, etc.).
   - If there are 10, 15, 25, or 35 chapters in the book, extract EVERY SINGLE ONE of them sequentially. DO NOT group the whole book into just 1 or 2 chapters.

2. PRINTED PAGE TO PHYSICAL PDF PAGE CALIBRATION:
   - In most published books, printed page numbers (e.g. "Page 1") start AFTER front matter (covers, preface, TOC).
   - If printed page 1 corresponds to physical page P_offset (e.g. physical page 16 or 20), convert every printed page number from the TOC to its physical PDF page: physical_page = printed_page + offset.
   - If no offset is obvious, use the physical page where Chapter 1 starts.

3. STRICT ZERO-GAP PHYSICAL PAGINATION:
   - Chapter 1 (or Front Matter) must start at physical page 1. If Chapter 1 starts at physical page X > 1, create Chapter 0 ("Front Matter & Contents", start_page: 1, end_page: X - 1).
   - Each subsequent Chapter i ends on physical page (start_page of Chapter i+1) - 1.
   - The final chapter MUST end on the absolute last page of the PDF (${totalPages}).
   - No gaps and no overlapping pages between consecutive chapters.

4. ACCURATE TITLES:
   - Capture full formal titles, e.g. "Unit 1: Algebra, Vectors and Geometry", "Chapter 1: Solution of Equations", "Chapter 2: Linear Algebra, Determinants, Matrices", etc.

Return valid JSON with:
{
  "book_title": "Full Book Title",
  "total_discovered_chapters": number,
  "chapters": [
    {
      "chapter_index": 1,
      "chapter_title": "Chapter Name",
      "start_page": 1,
      "end_page": 45
    }
  ]
}`;

  const contents: any[] = [];

  if (tocImageData) {
    contents.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: cleanBase64(String(tocImageData)),
      },
    });
  }

  if (Array.isArray(tocImages) && tocImages.length > 0) {
    for (const img of tocImages.slice(0, 15)) {
      const base64Data = typeof img === "string" ? cleanBase64(img) : img.data;
      if (base64Data) {
        contents.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Data,
          },
        });
      }
    }
  }

  contents.push({ text: prompt });

  const { text, modelUsed } = await generateJsonWithFallback(apiKey, contents, {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        book_title: {
          type: Type.STRING,
          description: "The formal title of the book",
        },
        total_discovered_chapters: {
          type: Type.INTEGER,
          description: "Total number of chapters found",
        },
        chapters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              chapter_index: {
                type: Type.INTEGER,
                description: "Sequential order starting from 1 (or 0 for Prologue/Introduction/Preface)",
              },
              chapter_title: {
                type: Type.STRING,
                description: "The formal name or number of the chapter as written in the text",
              },
              start_page: {
                type: Type.INTEGER,
                description: "The absolute physical PDF page number where this chapter begins",
              },
              end_page: {
                type: Type.INTEGER,
                description: "The absolute physical PDF page number where this chapter ends",
              },
            },
            required: ["chapter_index", "chapter_title", "start_page", "end_page"],
          },
        },
      },
      required: ["book_title", "total_discovered_chapters", "chapters"],
    },
  });

  const parsed = JSON.parse(text);

  // Enforce strict pagination post-processing guardrails (zero gaps, zero overlaps, final page = totalPages)
  if (parsed.chapters && parsed.chapters.length > 0) {
    parsed.chapters.sort((a: any, b: any) => a.start_page - b.start_page);

    if (parsed.chapters[0].start_page > 1) {
      const firstStart = parsed.chapters[0].start_page;
      const hasFrontMatter = parsed.chapters.some((c: any) => c.start_page === 1);
      if (!hasFrontMatter) {
        parsed.chapters.unshift({
          chapter_index: 0,
          chapter_title: "Front Matter & Contents",
          start_page: 1,
          end_page: firstStart - 1,
        });
      }
    }

    for (let i = 0; i < parsed.chapters.length; i++) {
      const curr = parsed.chapters[i];
      if (i < parsed.chapters.length - 1) {
        const next = parsed.chapters[i + 1];
        curr.end_page = next.start_page - 1;
      } else {
        curr.end_page = totalPages;
      }
    }

    let seqIdx = parsed.chapters[0].start_page === 1 && parsed.chapters[0].chapter_title.toLowerCase().includes('front') ? 0 : 1;
    for (let i = 0; i < parsed.chapters.length; i++) {
      parsed.chapters[i].chapter_index = seqIdx++;
    }

    parsed.total_discovered_chapters = parsed.chapters.length;
  }

  return { json: parsed, modelUsed };
}

/**
 * POST /api/detect-chapter-title
 * Fast chapter title detection on a chapter's starting page.
 */
export async function detectChapterTitleHandler(
  body: any,
  apiKey: string
): Promise<AiHandlerResult> {
  const { pageNumber, imageData, pageText, chapterIndex } = body || {};
  if (!pageNumber) throw new InvalidPayloadError("Missing pageNumber in request body");

  const contents: any[] = [];

  if (imageData) {
    contents.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: cleanBase64(String(imageData)),
      },
    });
  }

  const prompt = `You are a specialized, high-speed book structural analyzer.
Analyze Page ${pageNumber} of this book, which is designated as the STARTING / OPENING PAGE of a chapter or section${chapterIndex ? ` (Chapter #${chapterIndex})` : ""}.
${pageText ? `Extracted Page Text Fragment: "${String(pageText).slice(0, 1500)}"` : ""}

TASK:
Examine the top headings, chapter numbering, and titles on this specific starting page. Extract the exact chapter or unit title introduced here.

EXAMPLES OF DESIRED TITLES:
- "Chapter 1: Solution of Equations"
- "1. Solution of Equations"
- "Unit I: Linear Algebra & Matrices"
- "Chapter 2: Differential Calculus"
- "Vector Spaces & Linear Transformations"
- "Front Matter / Contents"
- "Preface"
- "Appendix A: Mathematical Tables"

DIRECTIVES:
1. Extract the clean, formal chapter or unit title as printed on this starting page.
2. If both a chapter number/unit and title are present, format cleanly as "Chapter X: Title", "Unit X: Title", or "X. Title".
3. Ignore author names, university headers, page numbers, and copyright footers.
4. Return a concise, high-confidence title (under 80 characters).

Return JSON.`;

  contents.push({ text: prompt });

  const { text, modelUsed } = await generateJsonWithFallback(apiKey, contents, {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        chapter_title: {
          type: Type.STRING,
          description: "The extracted chapter or section title",
        },
        is_chapter_opener: {
          type: Type.BOOLEAN,
          description: "True if this page represents a chapter/unit start",
        },
        confidence: {
          type: Type.NUMBER,
          description: "Confidence score between 0.0 and 1.0",
        },
      },
      required: ["chapter_title"],
    },
  });

  return { json: JSON.parse(text), modelUsed };
}

/**
 * POST /api/validate-gemini-key
 * Lightweight check that a user-supplied key actually works with the model chain.
 * Returns 200 with { valid: false } (instead of an HTTP error) so the UI can
 * show a friendly message.
 */
export async function validateGeminiKeyHandler(
  apiKey: string
): Promise<AiHandlerResult> {
  const attempted: string[] = [];
  let lastMessage = "Unknown error";

  // The key is valid as long as the API accepts the request (no auth/model
  // rejection) — empty or truncated text output is not a key failure.
  for (const model of GEMINI_MODEL_CHAIN) {
    attempted.push(model);
    try {
      const reply = await callGemini(apiKey, model, [{ text: "Reply with a single word: OK" }], {});
      return {
        json: {
          valid: true,
          model_used: model,
          models: GEMINI_MODEL_CHAIN,
          reply,
        },
        modelUsed: model,
      };
    } catch (err: any) {
      lastMessage = String(err?.message || err);
      console.error(`Gemini key validation failed for model ${model}:`, lastMessage);
      if (isAuthError(lastMessage)) break;
    }
  }

  const invalidKey = isAuthError(lastMessage);
  return {
    json: {
      valid: false,
      error: invalidKey
        ? "Gemini rejected this API key. Double-check that you copied the full key and that it is enabled for the Gemini API."
        : `Could not reach Gemini (tried: ${attempted.join(", ")}). Last error: ${lastMessage}`,
      models: GEMINI_MODEL_CHAIN,
    },
  };
}

/** Clockwise rotation (degrees) applied to each candidate, in the order the client sends them. */
const ORIENTATION_CANDIDATE_ANGLES = [0, 90, 180, 270] as const;

/**
 * Which image edge the TOP of the text points at → clockwise rotation that makes it upright.
 * e.g. text top pointing at the right edge means the page was turned 90° CW, so rotate 270° CW.
 */
const TEXT_TOP_EDGE_TO_ROTATION: Record<string, 0 | 90 | 180 | 270> = {
  top: 0,
  right: 270,
  bottom: 180,
  left: 90,
};

/** Tolerant JSON parse: strips markdown fences / leading prose some models emit. */
function parseModelJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("AI returned malformed orientation JSON");
  }
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

// Orientation answers are tiny, but "thinking" Flash models spend output tokens
// on reasoning first — a small cap truncates the JSON and silently forces the
// weaker local fallback. Keep generous headroom.
const ORIENTATION_MAX_OUTPUT_TOKENS = 4096;

/**
 * POST /api/detect-orientation
 * Document orientation analyzer using Gemini Vision.
 *
 * Preferred payload: `{ candidates: [dataUrl0, dataUrl90, dataUrl180, dataUrl270] }` —
 * the same page pre-rotated clockwise by 0/90/180/270°. Asking the model to pick
 * the upright option is far more reliable than asking it for a rotation angle
 * (models routinely confuse clockwise vs counter-clockwise).
 *
 * Legacy payload: `{ imageData }` — the model reports which edge the top of the
 * text points at, and the angle is derived deterministically here.
 *
 * Response: `{ rotationNeeded, isUpright, isMirroredHorizontally, confidence, reason, detectedTextSample }`
 * where rotationNeeded is the clockwise rotation to apply to candidate 0 / imageData.
 */
export async function detectOrientationHandler(
  body: any,
  apiKey: string
): Promise<AiHandlerResult> {
  const { imageData, candidates } = body || {};
  const candidateList: string[] = Array.isArray(candidates)
    ? candidates.filter((c: unknown) => typeof c === "string" && c.length > 0)
    : [];

  if (candidateList.length === ORIENTATION_CANDIDATE_ANGLES.length) {
    return detectOrientationFromCandidates(candidateList, apiKey);
  }
  if (!imageData) throw new InvalidPayloadError("Missing imageData or candidates in request body");
  return detectOrientationFromSingleImage(String(imageData), apiKey);
}

async function detectOrientationFromCandidates(
  candidateList: string[],
  apiKey: string
): Promise<AiHandlerResult> {
  const parts: any[] = [
    {
      text: `You are an expert document vision analyzer. You will see 4 candidate rotations of the SAME document (exam question paper, worksheet, problem set, assignment, book spread, notebook, receipt, or academic notes).
Exactly one option shows the document upright so it is readable.

CRITICAL DIRECTIVE FOR SCREENSHOTS & DEVICE FRAMES:
If this image is a mobile/tablet/desktop screenshot or has a camera border or photo viewer frame:
- Device UI, status bars (clock, battery, wifi, signal bars), browser address bars, navigation controls, or outer black/gray letterbox bars are OFTEN oriented differently from the document inside!
- YOU MUST COMPLETELY DISREGARD all device status bars, clock, battery icons, browser chrome, or letterboxing borders!
- Base your judgment SOLELY on the core document/page content: text lines, handwriting, question numbers (e.g. "1.", "2.", "Q1", "Problem 1", "3(a)"), mathematical equations, integrals, summation, fractions, diagrams, and paragraphs.
- The document is upright ONLY when its text lines run HORIZONTALLY from left to right, and letters/digits are upright (not upside down and not tilted sideways).

Below are the 4 options:`,
    },
  ];
  candidateList.forEach((dataUrl, i) => {
    parts.push({ text: `Option ${i + 1}:` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: cleanBase64(dataUrl) } });
  });
  parts.push({
    text: `Pick the option in which the document is upright:
- Option 1 represents 0° additional rotation (the document as currently viewed).
- Option 2 is rotated 90° clockwise from Option 1.
- Option 3 is rotated 180° clockwise from Option 1.
- Option 4 is rotated 270° clockwise (90° counter-clockwise) from Option 1.

Check character shapes: "e", "a", "g", "7", "4", "2", "x", "y", "Q", question labels.
Ignore outer phone status bars, battery/clock, and screenshot letterbox borders. Judge by the document text.

First, in "observations", describe what you see for each option and quote a few words read from the upright one.
Then provide:
- "uprightOption": 1, 2, 3, or 4
- "rotationNeeded": the clockwise angle to apply to Option 1: 0 (if Option 1 is upright), 90 (if Option 2 is upright), 180 (if Option 3 is upright), or 270 (if Option 4 is upright)
- "confidence": 0.0 to 1.0
- "isMirrored": true only if text is mirror-reversed
- "detectedTextSample": a few words read from the upright document`,
  });

  const { text, modelUsed } = await generateJsonWithFallback(apiKey, parts, {
    responseMimeType: "application/json",
    maxOutputTokens: ORIENTATION_MAX_OUTPUT_TOKENS,
    temperature: 0,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        observations: {
          type: Type.STRING,
          description: "Per-option notes on whether the document text is upright, upside down or sideways",
        },
        uprightOption: {
          type: Type.INTEGER,
          description: "1-based index (1, 2, 3, or 4) of the option in which the document is upright",
        },
        rotationNeeded: {
          type: Type.INTEGER,
          description: "Clockwise rotation needed: 0, 90, 180, or 270 degrees",
        },
        confidence: { type: Type.NUMBER, description: "Confidence between 0.0 and 1.0" },
        isMirrored: { type: Type.BOOLEAN, description: "True if text is mirror-reversed" },
        detectedTextSample: { type: Type.STRING, description: "A few words read from the upright option" },
      },
      required: ["observations", "uprightOption", "confidence"],
      propertyOrdering: ["observations", "uprightOption", "rotationNeeded", "confidence", "isMirrored", "detectedTextSample"],
    },
  });

  const parsed = parseModelJson(text);
  const option = Math.round(Number(parsed?.uprightOption));
  let rotationNeeded: 0 | 90 | 180 | 270 = 0;

  if (Number.isFinite(option) && option >= 1 && option <= ORIENTATION_CANDIDATE_ANGLES.length) {
    rotationNeeded = ORIENTATION_CANDIDATE_ANGLES[option - 1];
  } else if (typeof parsed?.rotationNeeded === "number") {
    const rawRot = ((((Math.round(parsed.rotationNeeded / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    if (ORIENTATION_CANDIDATE_ANGLES.includes(rawRot)) {
      rotationNeeded = rawRot;
    }
  } else {
    throw new Error(`AI returned an invalid uprightOption: ${parsed?.uprightOption}`);
  }

  return {
    json: {
      rotationNeeded,
      isUpright: rotationNeeded === 0,
      isMirroredHorizontally: Boolean(parsed?.isMirrored),
      confidence: clampConfidence(parsed?.confidence),
      detectedTextSample: parsed?.detectedTextSample || "",
      reason:
        rotationNeeded === 0
          ? "Document is already upright"
          : `AI detected the page needs a ${rotationNeeded}° clockwise turn to be upright`,
      observations: parsed?.observations || "",
      mode: "candidates",
    },
    modelUsed,
  };
}

async function detectOrientationFromSingleImage(
  imageData: string,
  apiKey: string
): Promise<AiHandlerResult> {
  const prompt = `You are an expert document vision analyzer. Examine this image of a document (exam paper, worksheet, book page, notebook, problem set, form, or receipt).

CRITICAL DIRECTIVE FOR SCREENSHOTS & DEVICE FRAMES:
If this image is a mobile or desktop screenshot (showing a phone status bar, battery icon, clock, wifi, carrier, browser address bar, or photo viewer UI around a document):
- YOU MUST COMPLETELY DISREGARD the device status bar, clock, battery icon, browser chrome, or black letterbox borders!
- Base your judgment SOLELY on the inner document content (the printed text, handwriting, question numbers, mathematical equations, tables, figures, headings).
- Determine the orientation of the DOCUMENT itself, NOT the phone screen.

TASK:
Determine which edge of the image the TOP of the document text / headings points towards:
- "top": The document text reads normally from left-to-right horizontally; the document is already upright.
- "right": The document was turned 90° clockwise; the tops of the letters point towards the RIGHT edge (reading downward).
- "bottom": The document is upside down; the tops of the letters point towards the BOTTOM edge.
- "left": The document was turned 90° counter-clockwise; the tops of the letters point towards the LEFT edge (reading upward).

Determine the exact clockwise rotation angle needed to make the document upright:
- If textTopEdge is "top" -> rotationNeeded = 0
- If textTopEdge is "right" -> rotationNeeded = 270 (rotate 270° CW / 90° CCW to make upright)
- If textTopEdge is "bottom" -> rotationNeeded = 180 (rotate 180° to make upright)
- If textTopEdge is "left" -> rotationNeeded = 90 (rotate 90° CW to make upright)

First describe what you see in "observations" (quote a few words you can read from the document, ignoring phone status bars), then provide "textTopEdge", "rotationNeeded", and "confidence".`;

  const { text, modelUsed } = await generateJsonWithFallback(
    apiKey,
    [
      { inlineData: { mimeType: "image/jpeg", data: cleanBase64(imageData) } },
      { text: prompt },
    ],
    {
      responseMimeType: "application/json",
      maxOutputTokens: ORIENTATION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          observations: { type: Type.STRING, description: "What the document text looks like and a few words read" },
          textTopEdge: {
            type: Type.STRING,
            format: "enum",
            enum: ["top", "right", "bottom", "left"],
            description: "Image edge the top of the text points towards",
          },
          rotationNeeded: {
            type: Type.INTEGER,
            description: "Clockwise rotation needed in degrees: 0, 90, 180, or 270",
          },
          confidence: { type: Type.NUMBER, description: "Confidence between 0.0 and 1.0" },
          isMirrored: { type: Type.BOOLEAN, description: "True if text is mirror-reversed" },
          detectedTextSample: { type: Type.STRING, description: "Sample text read from the document" },
        },
        required: ["observations", "textTopEdge", "confidence"],
        propertyOrdering: ["observations", "textTopEdge", "rotationNeeded", "confidence", "isMirrored", "detectedTextSample"],
      },
    }
  );

  const parsed = parseModelJson(text);
  const edge = String(parsed?.textTopEdge || "").toLowerCase().trim();
  let rotationNeeded: 0 | 90 | 180 | 270 = 0;

  if (edge in TEXT_TOP_EDGE_TO_ROTATION) {
    rotationNeeded = TEXT_TOP_EDGE_TO_ROTATION[edge];
  } else if (typeof parsed?.rotationNeeded === "number") {
    const rawRot = ((((Math.round(parsed.rotationNeeded / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    if (ORIENTATION_CANDIDATE_ANGLES.includes(rawRot)) {
      rotationNeeded = rawRot;
    }
  } else {
    throw new Error(`AI returned an invalid textTopEdge: ${parsed?.textTopEdge}`);
  }

  return {
    json: {
      rotationNeeded,
      isUpright: rotationNeeded === 0,
      isMirroredHorizontally: Boolean(parsed?.isMirrored),
      confidence: clampConfidence(parsed?.confidence),
      detectedTextSample: parsed?.detectedTextSample || "",
      reason:
        rotationNeeded === 0
          ? "Document is already upright"
          : `AI detected the page needs a ${rotationNeeded}° clockwise turn to be upright`,
      observations: parsed?.observations || "",
      mode: "single",
    },
    modelUsed,
  };
}
