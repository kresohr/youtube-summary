import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Path to the Gemini CLI binary installed as an npm dependency.
 *   dev  (tsx):  __dirname = backend/src/jobs  → ../../../node_modules/.bin/gemini
 *   prod (tsc):  __dirname = backend/dist/jobs → ../../../node_modules/.bin/gemini
 * Both resolve to backend/node_modules/.bin/gemini
 */
const GEMINI_BIN = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  "gemini"
);

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
 * Invoke Gemini CLI in headless / one-shot mode.
 *
 * Auth: GEMINI_API_KEY is injected directly into the child process environment
 * so the global user session (~/.gemini) is never touched and the call is safe
 * to run from cron / Docker without any prior interactive login.
 *
 * Output format: --output-format json → { response: string, stats: object }
 */
async function runGemini(prompt: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  let stdout: string;
  try {
    const result = await execFileAsync(
      GEMINI_BIN,
      [
        "--output-format",
        "json",
        "--approval-mode=yolo",
        "--model",
        "flash", // gemini-2.5-flash — fast and available on free tier
        "--prompt",
        prompt,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: {
          ...process.env,
          GEMINI_API_KEY: apiKey,
          // Suppress colour codes and interactive prompts
          NO_COLOR: "1",
          TERM: "dumb",
          // Opt-out of telemetry in automated runs
          GEMINI_TELEMETRY: "disabled",
          // Clear VS Code IDE integration env vars to prevent the
          // one-time "Connect VS Code to Gemini CLI?" interactive nudge
          // from blocking the non-interactive child process.
          GEMINI_CLI_IDE_SERVER_PORT: "",
          GEMINI_CLI_IDE_WORKSPACE_PATH: "",
        },
      }
    );
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile rejects with an object that carries .stdout/.stderr when the
    // process exits non-zero or times out.
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const detail =
      execErr.stderr?.slice(0, 400) ?? execErr.message ?? String(err);
    throw new Error(`Gemini CLI process failed: ${detail}`);
  }

  let parsed: { response?: string; error?: { message?: string } };
  try {
    // The CLI may emit a small progress header before the JSON on some builds —
    // find the first '{' so we parse only the JSON portion.
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      throw new Error("no JSON object found in output");
    }
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (parseErr) {
    throw new Error(
      `Gemini CLI returned non-JSON output (${stdout.length} chars): ${stdout.slice(0, 300)}`
    );
  }

  if (parsed.error) {
    throw new Error(
      `Gemini API error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`
    );
  }

  const response = parsed.response?.trim() ?? "";
  if (response.length < 50) {
    throw new Error(
      `Gemini returned an empty or too-short response (${response.length} chars)`
    );
  }

  return response;
}

/**
 * Tier 1 — Pass the YouTube URL directly to Gemini.
 * Gemini processes the video natively (multimodal) without needing a
 * pre-fetched transcript. This is the fastest and highest-quality path.
 */
export async function summarizeVideoWithGemini(
  videoUrl: string
): Promise<string> {
  console.log(`[Gemini] Tier 1: direct URL summarization for ${videoUrl}`);

  const prompt =
    `Summarize this YouTube video using the exact Markdown structure specified.\n\n` +
    `Video URL: ${videoUrl}\n\n` +
    SUMMARY_FORMAT_INSTRUCTIONS;

  // 2 min timeout — video understanding can be slow for long videos
  return runGemini(prompt, 120_000);
}

/**
 * Tier 2 — Feed a pre-fetched transcript (from yt-dlp) to Gemini.
 * Used when Tier 1 (direct URL) fails but yt-dlp successfully extracted
 * a transcript.
 */
export async function summarizeTranscriptWithGemini(
  transcript: string,
  videoTitle: string
): Promise<string> {
  console.log(`[Gemini] Tier 2: transcript summarization for "${videoTitle}"`);

  // Gemini handles much larger context than OpenRouter free tier
  const maxChars = 12_000;
  const truncated =
    transcript.length > maxChars
      ? transcript.substring(0, maxChars) + "..."
      : transcript;

  const prompt =
    `Summarize this YouTube video using the exact Markdown structure specified.\n\n` +
    `Title: ${videoTitle}\n\n` +
    `Transcript:\n${truncated}\n\n` +
    SUMMARY_FORMAT_INSTRUCTIONS;

  return runGemini(prompt, 90_000);
}
