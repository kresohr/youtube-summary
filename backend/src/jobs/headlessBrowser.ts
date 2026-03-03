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
    // Register the response listener BEFORE navigation so that even if the
    // timedtext request fires mid-navigation we still capture it.
    // NOTE: the timer is NOT started here — it starts after navigation
    // completes, so a slow page-load (e.g. consent redirect) doesn't burn
    // through the budget before the player even initialises.
    let resolveIntercepted!: (data: unknown) => void;
    let rejectIntercepted!: (err: Error) => void;

    const interceptedPromise = new Promise<unknown>((resolve, reject) => {
      resolveIntercepted = resolve;
      rejectIntercepted = reject;
    });

    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("timedtext")) return;
      try {
        const body = await response.text();
        if (body.length < 10) return;
        const json = JSON.parse(body);
        if (Array.isArray(json.events)) {
          console.log(
            `[Transcript] [Headless] Vector A: intercepted timedtext response (${body.length} bytes) from ${url.slice(0, 80)}…`
          );
          resolveIntercepted(json);
        }
      } catch {
        // non-JSON or stream already consumed — ignore
      }
    });

    // Navigate to the watch page.
    // - hl=en&gl=US avoids GDPR consent-wall redirects.
    // - autoplay=1 tells the player to start immediately, which causes it
    //   to fire the timedtext request we are intercepting in Vector A.
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&autoplay=1`;
    console.log(`[Transcript] [Headless] Navigating to ${watchUrl}`);
    await page.goto(watchUrl, {
      waitUntil: "networkidle2",
      timeout: 45_000,
    });

    // ── Consent-page handling ───────────────────────────────────────────────
    //
    // In some regions Chromium is redirected to consent.youtube.com before
    // reaching the video. Detect this and accept, then re-navigate.
    const landedUrl = page.url();
    if (landedUrl.includes("consent.youtube.com") || landedUrl.includes("/consent")) {
      console.log(`[Transcript] [Headless] Consent page detected (${landedUrl}), accepting…`);
      try {
        // New Google consent UI: a <form> with a "Accept all" button.
        await page.waitForSelector('button, input[type="submit"]', { timeout: 5_000 });
        await page.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>('button, input[type="submit"]')
          );
          const accept = candidates.find((el) => {
            const t = el.textContent?.toLowerCase() ?? "";
            return (
              t.includes("accept") ||
              t.includes("agree") ||
              t.includes("i agree") ||
              t.includes("accept all")
            );
          });
          if (accept) accept.click();
        });
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 }).catch(() => {});
      } catch {
        console.warn(`[Transcript] [Headless] Could not dismiss consent page automatically`);
      }

      // Re-navigate to the actual video after consent
      await page.goto(watchUrl, { waitUntil: "networkidle2", timeout: 45_000 });
    }

    // Persist updated cookies — including any consent cookies just set.
    const currentCookies = await page.cookies();
    await saveCookies(currentCookies as PersistedCookie[]);

    // Log where we actually landed for debugging
    console.log(`[Transcript] [Headless] Landed on: ${page.url()} (title: "${await page.title()}")`);

    // ── Try Vector A result (short post-navigation window) ──────────────────
    //
    // Start a SHORT timer now that navigation is done.  If the timedtext
    // request already fired during page load, interceptedPromise is already
    // resolved and this races to zero.  We give it an extra 8 s in case the
    // player initialises with a brief delay after networkidle2.
    const postNavTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Headless Vector A: no timedtext response intercepted within 8 s post-navigation")),
        8_000
      )
    );

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timedText = (await Promise.race([interceptedPromise, postNavTimeout])) as any;
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

    console.log(
      `[Transcript] [Headless] Vector B: extracting ytInitialPlayerResponse via page.evaluate()`
    );

    // Poll up to 10 s for ytInitialPlayerResponse to be populated — the player
    // sometimes hydrates it a few hundred ms after networkidle2.
    const vectorBResult = await page.evaluate(async () => {
      const deadline = Date.now() + 10_000;
      let pr: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidate = (window as any).ytInitialPlayerResponse;
        if (
          candidate &&
          candidate?.captions?.playerCaptionsTracklistRenderer?.captionTracks
            ?.length > 0
        ) {
          pr = candidate as Record<string, unknown>;
          break;
        }
        // Wait 500 ms before retrying
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!pr) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (window as any).ytInitialPlayerResponse;
        if (!raw) return { error: "ytInitialPlayerResponse not found in page context" };
        return { error: "No captionTracks in ytInitialPlayerResponse" };
      }

      const tracks: Array<{
        baseUrl: string;
        languageCode: string;
        kind?: string;
      }> =
        (pr as any)?.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
        [];

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
