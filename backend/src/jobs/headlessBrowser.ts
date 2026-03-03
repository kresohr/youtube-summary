/**
 * Method 3: Headless browser transcript extraction.
 *
 * EDUCATIONAL PURPOSE
 * -------------------
 * This module demonstrates how a real Chromium session — patched to hide all
 * automation fingerprints — can extract caption data from YouTube even when
 * the two server-side methods (HTML scraper + InnerTube API) are blocked by
 * bot mitigation.
 *
 * Two extraction vectors are demonstrated in sequence:
 *
 *   Vector A — Network interception
 *     A `page.on("response")` listener is registered before navigation.
 *     When the YouTube player fires the JSON3 timedtext CDN request as part of
 *     its normal initialisation, we capture the raw response body directly.
 *     This shows that even short-lived, signed CDN URLs are captured by any
 *     observer sitting between the browser and the network.
 *
 *   Vector B — In-page JS eval + in-browser fetch  (fallback)
 *     If no timedtext response is intercepted within 15 s, we call
 *     `page.evaluate()` to run code *inside* the browser's V8 engine.
 *     From there we read `window.ytInitialPlayerResponse` (the same data the
 *     player uses internally), pick the best caption track, and call the
 *     browser's own `fetch()` with `credentials: "include"`.  Because this
 *     fetch originates from inside the browser, it carries the full session
 *     cookie jar automatically — making it indistinguishable from a real user
 *     clicking the captions button.
 *
 * HOW TO PREVENT THIS ON YOUR OWN STREAMING SERVICE
 * --------------------------------------------------
 *   1. Short-lived, server-signed caption tokens bound to a session ID.
 *      The token encodes {videoId, userId, expiresAt, ip} and is verified
 *      server-side.  A stolen URL is useless after ~30 s.
 *   2. DRM-encrypted caption streams (Widevine/PlayReady).  The key is only
 *      released to trusted CDM implementations, not to JavaScript.
 *   3. Rate-limit timedtext requests per session and block cookie-less
 *      requests entirely.
 *   4. Serve captions as encrypted blobs decrypted by a TEE/CDM rather than
 *      as plain JSON.
 *
 * Cookie persistence
 * ------------------
 * After every successful run the browser's cookies are serialised to
 * `backend/data/yt-cookies.json` (ignored by git).  On the next run they are
 * restored so the headless session looks like a returning user, avoiding the
 * extra friction YouTube applies to fresh sessions.
 */

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  json3ToSegments,
  type Json3Event,
  type TranscriptSegment,
} from "./youtubeTranscript.js";

// ─── Module-level setup ───────────────────────────────────────────────────────

// Register the stealth plugin once at module load time.
// It patches 17+ fingerprinting vectors:
//   • removes navigator.webdriver
//   • spoofs Chrome runtime object, permissions, plugins, mimeTypes
//   • randomises canvas/WebGL fingerprints
//   • patches iframe contentWindow
//   • overrides user-agent language headers
puppeteerExtra.use(StealthPlugin());

// package.json has no "type": "module", so NodeNext compiles .ts → CommonJS.
// __dirname is therefore the standard CJS global (provided via @types/node).
//   dev (tsx):      __dirname = backend/src/jobs  → ../../data = backend/data ✓
//   prod (tsc):     __dirname = backend/dist/jobs → ../../data = backend/data ✓
/** Absolute path to the cookie store (backend/data/yt-cookies.json). */
const DATA_DIR = join(__dirname, "..", "..", "data");
const COOKIES_PATH = join(DATA_DIR, "yt-cookies.json");

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of puppeteer's CookieParam that we persist to JSON. */
interface PersistedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

async function loadCookies(): Promise<PersistedCookie[]> {
  try {
    const raw = await readFile(COOKIES_PATH, "utf-8");
    const cookies = JSON.parse(raw) as PersistedCookie[];
    console.log(
      `[Transcript] [Headless] Loaded ${cookies.length} persisted cookie(s) from ${COOKIES_PATH}`
    );
    return cookies;
  } catch {
    // File does not yet exist — that is fine on the first run.
    return [];
  }
}

async function saveCookies(cookies: PersistedCookie[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(
    `[Transcript] [Headless] Persisted ${cookies.length} cookie(s) → ${COOKIES_PATH}`
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch a YouTube transcript using a stealth-patched headless Chromium session.
 *
 * Launches the browser, restores any saved cookies, navigates to the watch
 * page, and captures captions via one of the two vectors described at the top
 * of this file.  Saves updated cookies before closing the browser.
 */
export async function fetchTranscriptViaHeadless(
  videoId: string
): Promise<TranscriptSegment[]> {
  console.log(
    `[Transcript] [Headless] Launching stealth Chromium for ${videoId}`
  );

  const browser = await puppeteerExtra.launch({
    headless: true,
    // Use the system Chromium when running inside Docker (Alpine).
    // PUPPETEER_EXECUTABLE_PATH is set in the Dockerfile; locally Puppeteer
    // falls back to its own bundled Chrome when the variable is absent.
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
    args: [
      // Required when running as root (CI / Docker)
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Avoids /dev/shm exhaustion in constrained environments
      "--disable-dev-shm-usage",
      // Purely cosmetic — no GPU in a headless server
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
    ],
  });

  try {
    const page = await browser.newPage();

    // Realistic desktop viewport matching our spoofed UA
    await page.setViewport({ width: 1280, height: 720 });

    // Restore persisted session cookies so this run looks like a returning user
    const savedCookies = await loadCookies();
    if (savedCookies.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.setCookie(...(savedCookies as any[]));
    }

    // ── Vector A: network interception ─────────────────────────────────────
    //
    // Register a response listener BEFORE navigation.  When the YouTube
    // player fires its timedtext request (as part of normal player init),
    // this listener captures the full response body — including any
    // short-lived signed token in the URL and the decoded JSON3 payload.
    //
    // This is transparent to YouTube's server.  The request looks exactly
    // like a real Chrome request because it IS a real Chrome request.

    let resolveIntercepted!: (data: unknown) => void;
    let rejectIntercepted!: (err: Error) => void;

    const interceptedPromise = new Promise<unknown>((resolve, reject) => {
      resolveIntercepted = resolve;
      rejectIntercepted = reject;
    });

    const interceptTimeout = setTimeout(() => {
      rejectIntercepted(
        new Error(
          "Headless Vector A: no timedtext response intercepted within 15 s"
        )
      );
    }, 15_000);

    page.on("response", async (response) => {
      const url = response.url();

      // The YouTube player fetches timedtext from URLs that always contain
      // the string "timedtext" — regardless of whether it goes via the
      // youtube.com origin or a signed googlevideo.com CDN path.
      if (!url.includes("timedtext")) return;

      try {
        const body = await response.text();
        if (body.length < 10) return; // empty / sentinel response

        const json = JSON.parse(body);
        // JSON3 caption responses always have an `events` array
        if (Array.isArray(json.events)) {
          console.log(
            `[Transcript] [Headless] Vector A: intercepted timedtext response (${body.length} bytes) from ${url.slice(0, 80)}…`
          );
          clearTimeout(interceptTimeout);
          resolveIntercepted(json);
        }
      } catch {
        // Either the body was not JSON or the response stream was already
        // consumed — ignore and keep waiting.
      }
    });

    // Navigate to the watch page.  waitUntil: "networkidle2" lets the player
    // fully initialise (including firing the timedtext request) before we
    // proceed.
    console.log(
      `[Transcript] [Headless] Navigating to https://www.youtube.com/watch?v=${videoId}`
    );
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    // Persist updated cookies unconditionally so we accumulate session state
    // across runs even if transcript extraction later fails.
    const currentCookies = await page.cookies();
    await saveCookies(currentCookies as PersistedCookie[]);

    // ── Try Vector A result ────────────────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timedText = (await interceptedPromise) as any;
      const events: Json3Event[] = timedText?.events ?? [];
      const segments = json3ToSegments(events, "en");

      if (segments.length > 0) {
        const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
        console.log(
          `[Transcript] Success (Headless / Vector A — network interception) for ${videoId}: ` +
            `${segments.length} segment(s), ~${charCount} chars`
        );
        return segments;
      }

      console.warn(
        `[Transcript] [Headless] Vector A: intercepted response had 0 segments — trying Vector B`
      );
    } catch (interceptErr) {
      const msg =
        interceptErr instanceof Error
          ? interceptErr.message
          : String(interceptErr);
      console.warn(
        `[Transcript] [Headless] Vector A failed: ${msg} — trying Vector B`
      );
    }

    // ── Vector B: in-page JS eval + in-browser fetch ───────────────────────
    //
    // page.evaluate() executes code INSIDE the browser's V8 engine.
    // From inside the page we can:
    //   1. Read window.ytInitialPlayerResponse — the same data structure the
    //      player uses internally — to obtain the caption track URL.
    //   2. Call the browser's own fetch() with { credentials: "include" },
    //      which automatically attaches all session cookies.
    //
    // The resulting HTTP request is indistinguishable from one made by a real
    // user clicking the captions button because it originates from the same
    // browser context, with the same cookies, the same TLS fingerprint, and
    // the same JavaScript call-stack.
    //
    // The only way to prevent this is to ensure the caption URL itself cannot
    // be replayed — i.e. short-lived tokens bound to the session + IP, or
    // DRM-encrypted payloads that require a trusted CDM to decrypt.

    console.log(
      `[Transcript] [Headless] Vector B: extracting ytInitialPlayerResponse via page.evaluate()`
    );

    const vectorBResult = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pr = (window as any).ytInitialPlayerResponse;
      if (!pr)
        return { error: "ytInitialPlayerResponse not found in page context" };

      const tracks: Array<{
        baseUrl: string;
        languageCode: string;
        kind?: string;
      }> = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

      if (tracks.length === 0) {
        return { error: "No captionTracks in ytInitialPlayerResponse" };
      }

      // Rank tracks: manual captions first, English preferred
      const sorted = [...tracks].sort((a, b) => {
        const am = a.kind !== "asr" ? 0 : 1;
        const bm = b.kind !== "asr" ? 0 : 1;
        if (am !== bm) return am - bm;
        const ae = a.languageCode?.startsWith("en") ? 0 : 1;
        const be = b.languageCode?.startsWith("en") ? 0 : 1;
        return ae - be;
      });

      const track = sorted[0];
      const rawUrl = track.baseUrl.replace(/&amp;/g, "&");
      const timedTextUrl = rawUrl.includes("fmt=")
        ? rawUrl.replace(/fmt=[^&]*/, "fmt=json3")
        : `${rawUrl}&fmt=json3`;

      // KEY INSIGHT: this fetch runs inside the browser.
      // The browser sends its full cookie jar automatically — including any
      // session cookies that YouTube set earlier in this page visit.
      // No server-side scraper can replicate this without a full browser session.
      const resp = await fetch(timedTextUrl, { credentials: "include" });
      if (!resp.ok) {
        return {
          error: `timedtext fetch failed inside browser: HTTP ${resp.status}`,
        };
      }
      const body = await resp.text();
      return { body, lang: track.languageCode };
    });

    if ("error" in vectorBResult) {
      throw new Error(`Headless Vector B: ${vectorBResult.error}`);
    }

    const { body, lang } = vectorBResult as { body: string; lang: string };
    if (!body || body.length === 0) {
      throw new Error(
        `Headless Vector B: in-browser fetch returned empty body`
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timedText = JSON.parse(body) as any;
    const events: Json3Event[] = timedText?.events ?? [];
    const segments = json3ToSegments(events, lang);

    if (segments.length === 0) {
      throw new Error(
        `Headless Vector B: timedtext response yielded no segments for ${videoId}`
      );
    }

    const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
    console.log(
      `[Transcript] Success (Headless / Vector B — in-page JS eval + in-browser fetch) for ${videoId}: ` +
        `${segments.length} segment(s), ~${charCount} chars`
    );
    return segments;
  } finally {
    // Always close the browser — even on error — to avoid zombie Chromium processes
    await browser.close();
    console.log(`[Transcript] [Headless] Browser closed for ${videoId}`);
  }
}
