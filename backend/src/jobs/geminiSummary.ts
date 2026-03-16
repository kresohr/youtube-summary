/**
 * Gemini REST API — multimodal video summarisation.
 *
 * Sends the YouTube URL directly to Gemini which processes the video
 * natively (audio + video understanding) and returns a structured
 * Markdown summary in a single API call.
 *
 * Auth: uses GEMINI_API_KEY from the environment.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Typed error for Gemini HTTP failures.
 * Exposes the HTTP status so callers can distinguish 429 (quota) from
 * 403 (permission denied) from other errors.
 */
export class GeminiApiError extends Error {
  public readonly status: number;
  constructor(status: number, body: string) {
    super(`Gemini API error (HTTP ${status}): ${body.slice(0, 400)}`);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

const SUMMARY_FORMAT_INSTRUCTIONS = `
You MUST always respond in valid Markdown using EXACTLY the following structure — no deviations, no extra sections, no plain text:

## 📝 Overview
A 2–4 sentence high-level description of what the video is about.

## 🔑 Key Points
- Bullet point 1
- Bullet point 2
- Bullet point 3
(Add as many bullet points as needed to cover all important points.)

## 💡 Key Takeaways
- The most important insight or lesson from the video.
- Additional takeaway if applicable.

## 🏷️ Topics Covered
- Topic 1
- Topic 2
- Topic 3

Rules:
- Always use the exact headings above (including emojis).
- Use Markdown bullet lists (- ) under every section.
- Do NOT add any text outside of these four sections.
- Do NOT wrap your response in a code block.
- The response must be valid Markdown that renders correctly.
`.trim();

/**
 * Call the Gemini REST API to summarise a YouTube video by URL.
 *
 * Gemini processes the video via multimodal understanding — no separate
 * transcript extraction step is needed.
 *
 * @param videoUrl  Full YouTube watch URL (e.g. https://youtube.com/watch?v=…)
 * @returns         Markdown summary string
 */
export async function summarizeVideo(videoUrl: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  console.log(`[Gemini] Summarising video: ${videoUrl}`);

  const prompt =
    `Summarize this YouTube video using the exact Markdown structure specified.\n\n` +
    `Video URL: ${videoUrl}\n\n` +
    SUMMARY_FORMAT_INSTRUCTIONS;

  const url = `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            fileData: {
              mimeType: "video/mp4",
              fileUri: videoUrl,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // 2 min timeout
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new GeminiApiError(response.status, errorText);
  }

  const data = await response.json();

  // Navigate the Gemini REST API response structure
  const candidate = data.candidates?.[0];
  if (!candidate) {
    const blockReason = data.promptFeedback?.blockReason;
    throw new Error(
      `Gemini returned no candidates${blockReason ? ` (blocked: ${blockReason})` : ""}`
    );
  }

  const text = candidate.content?.parts?.[0]?.text?.trim() ?? "";
  if (text.length < 50) {
    throw new Error(
      `Gemini returned an empty or too-short response (${text.length} chars)`
    );
  }

  console.log(`[Gemini] Summary received: ${text.length} chars`);
  return text;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Extract the 11-character YouTube video ID from a URL or bare ID string.
 * Supports youtube.com/watch?v=, youtu.be/, and plain 11-char IDs.
 */
export function extractVideoId(input: string): string | null {
  try {
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.slice(1);
      return id || null;
    }
    const v = url.searchParams.get("v");
    if (v) return v;
    const m = url.pathname.match(/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
