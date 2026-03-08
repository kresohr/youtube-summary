import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Path to the Netscape-format YouTube cookie file used by yt-dlp.
 * An admin generates this once on a machine with a logged-in browser:
 *   yt-dlp --cookies-from-browser chrome --cookies ./backend/data/yt-cookies.txt https://youtube.com
 * The file is persisted via the Docker volume mount ./backend/data:/app/data.
 *   dev (tsx):  __dirname = backend/src/jobs  → ../../data = backend/data
 *   prod (tsc): __dirname = backend/dist/jobs → ../../data = backend/data
 */
const YT_COOKIES_TXT = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "yt-cookies.txt"
);

/**
 * Thrown when a video is age-restricted or members-only and yt-dlp detects
 * that sign-in is required to access it.
 */
export class LoginRequiredError extends Error {
  constructor(videoId: string, detail: string) {
    super(
      `This video requires sign-in (age-restricted or login-gated) and cannot be transcribed without authentication. (${videoId}) — ${detail}`
    );
    this.name = "LoginRequiredError";
  }
}

/** Canonical segment shape returned by transcript sources. */
export interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
  lang: string;
}

// ─── SRT parser ───────────────────────────────────────────────────────────────

/**
 * Parse an SRT subtitle file into canonical TranscriptSegment[].
 * Handles both comma (SRT standard) and period separators in timestamps.
 * HTML tags (e.g. <c>, <font>) are stripped from text lines.
 */
function parseSrt(srtContent: string, lang = "en"): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = srtContent.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    // Locate the timestamp line (skip optional sequence-number line)
    let tsLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        tsLineIdx = i;
        break;
      }
    }
    if (tsLineIdx === -1) continue;

    const tsLine = lines[tsLineIdx];
    const tsMatch = tsLine.match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!tsMatch) continue;

    const toMs = (h: string, m: string, s: string, ms: string): number =>
      (+h * 3600 + +m * 60 + +s) * 1000 + +ms;

    const startMs = toMs(tsMatch[1], tsMatch[2], tsMatch[3], tsMatch[4]);
    const endMs = toMs(tsMatch[5], tsMatch[6], tsMatch[7], tsMatch[8]);

    const text = lines
      .slice(tsLineIdx + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "") // strip HTML tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length === 0) continue;

    segments.push({
      text,
      offset: startMs / 1000,
      duration: (endMs - startMs) / 1000,
      lang,
    });
  }

  return segments;
}

// ─── yt-dlp transcript extraction ─────────────────────────────────────────────

/**
 * Invoke `yt-dlp` to download English subtitles (manual first, then
 * auto-generated) and parse the resulting SRT file.
 *
 * Writes to a per-call temp directory so concurrent jobs cannot collide.
 * Times out after 30 s.
 */
async function fetchTranscriptViaYtDlp(
  videoId: string
): Promise<TranscriptSegment[]> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yt-transcript-"));

  try {
    console.log(`[Transcript] yt-dlp fetching subtitles for ${videoId}...`);

    // Use a pre-generated Netscape cookie file if an admin has placed one.
    const cookieArgs: string[] = [];
    try {
      await access(YT_COOKIES_TXT);
      cookieArgs.push("--cookies", YT_COOKIES_TXT);
      console.log(`[Transcript] yt-dlp: using cookies from ${YT_COOKIES_TXT}`);
    } catch {
      // File absent — proceed unauthenticated (works for many public videos)
    }

    await execFileAsync(
      "yt-dlp",
      [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-lang",
        "en",
        "--sub-format",
        "ttml",
        "--convert-subs",
        "srt",
        // tv_simply and tv clients do not require PO tokens or account cookies,
        // making them the most reliable choice from datacenter IPs.
        "--extractor-args",
        "youtube:player_client=tv_simply,tv,default",
        "-o",
        path.join(tmpDir, "t.%(ext)s"),
        ...cookieArgs,
        videoUrl,
      ],
      { timeout: 30_000 }
    );

    // yt-dlp may produce e.g. t.en.srt, t.en-US.srt, or t.en-orig.srt
    const files = await readdir(tmpDir);
    const srtFile = files.find((f) => f.endsWith(".srt"));
    if (!srtFile) {
      throw new Error(
        `yt-dlp produced no SRT file for ${videoId} (files: ${files.join(", ") || "none"})`
      );
    }

    const srtContent = await readFile(path.join(tmpDir, srtFile), "utf-8");
    const langMatch = srtFile.match(/\.([a-z]{2}(?:-[A-Za-z0-9-]+)?)?\.srt$/);
    const lang = langMatch?.[1] ?? "en";

    const segments = parseSrt(srtContent, lang);
    if (segments.length === 0) {
      throw new Error(`yt-dlp SRT parsed to 0 segments for ${videoId}`);
    }

    const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
    console.log(
      `[Transcript] yt-dlp success for ${videoId}: ${segments.length} segment(s), ~${charCount} chars`
    );
    return segments;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a transcript for the given YouTube URL using yt-dlp.
 *
 * The previously used methods (HTML scraper, InnerTube /player API, and
 * headless Chromium) have been removed — YouTube patched all of them.
 * yt-dlp is kept as the fallback transcript source for Tier 2 / Tier 3
 * of the summary cascade; Tier 1 passes the URL directly to Gemini CLI.
 *
 * Throws LoginRequiredError when the video is age-restricted / members-only.
 * Throws a generic Error when yt-dlp is unavailable or produces no subtitles.
 */
export const transcribeVideo = async (
  videoUrl: string
): Promise<TranscriptSegment[]> => {
  const videoId = extractVideoId(videoUrl) || videoUrl;
  console.log(
    `[Transcript] Fetching transcript via yt-dlp for id: ${videoId}`
  );

  try {
    return await fetchTranscriptViaYtDlp(videoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface a clean LoginRequiredError when yt-dlp reports sign-in requirement
    if (msg.includes("Sign in") || msg.includes("LOGIN_REQUIRED")) {
      throw new LoginRequiredError(videoId, msg);
    }
    console.error(`[Transcript] yt-dlp failed for ${videoId}: ${msg}`);
    throw err;
  }
};

export function extractVideoId(input: string): string | null {
  try {
    // If it's already a plain ID (11 chars), return it.
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    const url = new URL(input);
    // youtu.be short link
    if (url.hostname.includes("youtu.be")) {
      const id = url.pathname.slice(1);
      return id || null;
    }
    // watch?v=ID and other typical params
    const v = url.searchParams.get("v");
    if (v) return v;
    // fallback: try to find 11-char id in the path
    const m = url.pathname.match(/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
