/**
 * Method 3: yt-dlp subtitle extraction.
 *
 * WHY THIS EXISTS
 * ---------------
 * YouTube's bot-mitigation now requires a `poToken` (Proof-of-Origin token) —
 * a JavaScript challenge response generated browser-side.  Unauthenticated HTTP
 * requests from datacenter IP ranges (e.g. Oracle Cloud, AWS, GCP) that lack a
 * valid `poToken` receive `LOGIN_REQUIRED / Sign in to confirm you're not a bot`
 * for every InnerTube client, regardless of the User-Agent or request shape.
 *
 * `yt-dlp` solves this without authentication:
 *   • It generates and attaches a `poToken` internally using its own challenge
 *     solver (regularly updated as YouTube rotates the algorithm).
 *   • It maintains up-to-date client contexts and visitor-data for all InnerTube
 *     clients, falling back across them automatically.
 *   • It handles subtitle preference, format conversion, and retry logic in one
 *     battle-tested binary.
 *
 * This method is tried after the lightweight server-side methods (HTML scraper +
 * InnerTube) fail, but before the expensive headless Chromium fallback.
 *
 * REQUIREMENTS
 * ------------
 *   • `yt-dlp` must be on PATH (installed via `pip3 install yt-dlp`).
 *   • `ffmpeg` should be available for subtitle format conversion, though
 *     yt-dlp can also request json3 directly without it.
 *   • Write access to /tmp (used only for the subtitle temp file).
 *
 * OUTPUT
 * ------
 * Returns the same `TranscriptSegment[]` shape as all other methods — parsed
 * from the json3 subtitle file yt-dlp writes to /tmp, then deleted.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  json3ToSegments,
  type Json3Event,
  type TranscriptSegment,
} from "./youtubeTranscript.js";

const execFileAsync = promisify(execFile);

// ─── Cookie helpers ───────────────────────────────────────────────────────────

/**
 * Path to the Puppeteer cookie store written by headlessBrowser.ts.
 * Resolved relative to this file: backend/src/jobs → ../../data = backend/data.
 */
const COOKIES_JSON_PATH = join(
  __dirname,
  "..",
  "..",
  "data",
  "yt-cookies.json"
);

/** Temp file where the Netscape-format cookies are written for yt-dlp. */
const NETSCAPE_COOKIES_PATH = join("/tmp", "yt-dlp-cookies.txt");

interface PuppeteerCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
}

/**
 * Converts the Puppeteer JSON cookie store (written by headlessBrowser.ts)
 * into a Netscape cookies.txt file that yt-dlp accepts via --cookies.
 *
 * Returns the path to the written Netscape file, or null if the JSON store
 * does not exist or is empty.
 *
 * Netscape format (tab-separated):
 *   domain  includesSubdomains  path  isSecure  expiry  name  value
 */
async function buildNetscapeCookiesFile(): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(COOKIES_JSON_PATH, "utf-8");
  } catch {
    return null; // file not yet created by headlessBrowser.ts
  }

  let cookies: PuppeteerCookie[];
  try {
    cookies = JSON.parse(raw) as PuppeteerCookie[];
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
  } catch {
    return null;
  }

  const lines = [
    "# Netscape HTTP Cookie File",
    "# Converted from Puppeteer JSON by youtube-summary backend",
  ];
  for (const c of cookies) {
    // Domains starting with '.' cover all subdomains; the flag column encodes this.
    const flag = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    // Session cookies have expires = -1 in Puppeteer; yt-dlp treats 0 as session.
    const expiry =
      !c.expires || c.expires < 0 ? "0" : String(Math.floor(c.expires));
    lines.push(
      `${c.domain}\t${flag}\t${c.path}\t${secure}\t${expiry}\t${c.name}\t${c.value}`
    );
  }

  await writeFile(NETSCAPE_COOKIES_PATH, lines.join("\n") + "\n", "utf-8");
  return NETSCAPE_COOKIES_PATH;
}

/** Absolute path prefix for temp subtitle files (/tmp/yt-dlp-<videoId>.*). */
function tempPrefix(videoId: string): string {
  return join("/tmp", `yt-dlp-${videoId}`);
}

/** Delete any leftover /tmp/yt-dlp-<videoId>.* files (best-effort cleanup). */
async function cleanupTempFiles(videoId: string): Promise<void> {
  try {
    const files = await readdir("/tmp");
    await Promise.all(
      files
        .filter((f) => f.startsWith(`yt-dlp-${videoId}`))
        .map((f) => unlink(join("/tmp", f)).catch(() => {}))
    );
  } catch {
    // /tmp always exists in practice; ignore errors silently.
  }
}

/**
 * Fetch a YouTube transcript using `yt-dlp`.
 *
 * Instructs yt-dlp to download only the subtitle/caption track (no video),
 * preferring English manual captions over auto-generated ones, in json3 format.
 * Reads and parses the resulting file, then deletes it.
 */
export async function fetchTranscriptViaYtDlp(
  videoId: string
): Promise<TranscriptSegment[]> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const prefix = tempPrefix(videoId);

  console.log(`[Transcript] [yt-dlp] Fetching subtitles for ${videoId}…`);

  // Attempt to pass the headless browser's persisted cookies to yt-dlp.
  // This bypasses YouTube's bot-detection for sessions that have previously
  // completed a consent flow inside the stealth Chromium instance.
  const cookiesArgs: string[] = [];
  const cookiesFile = await buildNetscapeCookiesFile();
  if (cookiesFile) {
    cookiesArgs.push("--cookies", cookiesFile);
    console.log(
      `[Transcript] [yt-dlp] Passing cookies from ${COOKIES_JSON_PATH}`
    );
  }

  try {
    await execFileAsync(
      "yt-dlp",
      [
        // Download manual captions (--write-sub) and auto-generated ones as
        // a fallback (--write-auto-sub).  Both are written only when present.
        "--write-sub",
        "--write-auto-sub",
        // Prefer English subtitles.  The "en.*" glob also matches en-US, en-GB, etc.
        // yt-dlp tries languages left-to-right and stops at the first match.
        "--sub-lang",
        "en.*,en",
        // Request json3 directly.  This is the same timedtext format our other
        // methods use, so json3ToSegments() can parse it without any conversion.
        "--sub-format",
        "json3",
        // Never download the video stream — captions only.
        "--skip-download",
        // Don't expand playlist URLs; treat the URL as a single video.
        "--no-playlist",
        // Reduce stdout noise.  Errors still go to stderr and are captured.
        "--quiet",
        "--no-warnings",
        // Inject session cookies when available (converted from Puppeteer JSON).
        ...cookiesArgs,
        // Output template — yt-dlp appends the subtitle language and extension,
        // producing e.g. /tmp/yt-dlp-<videoId>.en.json3
        "-o",
        prefix,
        url,
      ],
      {
        // 90 s is generous; a subtitle-only fetch normally completes in 5–15 s.
        timeout: 90_000,
      }
    );

    // yt-dlp names subtitle files as: <prefix>.<lang>.json3
    // e.g. /tmp/yt-dlp-ABC123.en.json3  or  /tmp/yt-dlp-ABC123.en-US.json3
    const tmpFiles = await readdir("/tmp");
    const subFiles = tmpFiles.filter(
      (f) => f.startsWith(`yt-dlp-${videoId}.`) && f.endsWith(".json3")
    );

    if (subFiles.length === 0) {
      throw new Error(
        `yt-dlp produced no .json3 subtitle file for ${videoId} — video may have no captions`
      );
    }

    // Rank: manual captions come without ".auto." in the filename; auto-subs
    // contain ".auto." or ".a." depending on the yt-dlp version.
    const ranked = subFiles.sort((a, b) => {
      const aAuto = /\.a\.|\.auto\./.test(a) ? 1 : 0;
      const bAuto = /\.a\.|\.auto\./.test(b) ? 1 : 0;
      return aAuto - bAuto; // manual (0) before auto (1)
    });

    const chosen = ranked[0];
    const raw = await readFile(join("/tmp", chosen), "utf-8");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timedText = JSON.parse(raw) as any;
    const events: Json3Event[] = timedText?.events ?? [];

    // Derive language code from filename suffix (everything between last dot
    // pair, e.g. "en" from "yt-dlp-ABC.en.json3").
    const langMatch = chosen.match(/\.([a-z]{2}(?:-[A-Z]{2})?)\.json3$/);
    const lang = langMatch ? langMatch[1] : "en";

    const segments = json3ToSegments(events, lang);

    if (segments.length === 0) {
      throw new Error(
        `yt-dlp: subtitle file "${chosen}" contained no usable segments`
      );
    }

    const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
    console.log(
      `[Transcript] [yt-dlp] Success for ${videoId}: ${segments.length} segment(s), ~${charCount} chars (${chosen})`
    );
    return segments;
  } finally {
    // Always clean up temp files even when an error is thrown.
    await cleanupTempFiles(videoId);
  }
}
