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

// ─── Consent helper ───────────────────────────────────────────────────────────

/**
 * Dismisses YouTube's cookie consent UI if it is visible on the page.
 *
 * YouTube shows consent in two layouts:
 *   1. Redirect to consent.youtube.com  (URL-detectable)
 *   2. Inline lightbox on the video page (URL stays youtube.com/watch?v=…)
 *
 * Both layouts use a button whose aria-label is:
 *   "Accept the use of cookies and other data for the purposes described"
 *
 * We target it by aria-label (most robust) and fall back to text content.
 * Returns true if a consent button was clicked.
 */
async function dismissConsentIfPresent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any
): Promise<boolean> {
  try {
    // Target the exact aria-label YouTube uses on the Accept button.
    const ACCEPT_ARIA =
      "Accept the use of cookies and other data for the purposes described";

    // Check if the button exists within 3 s (fast bail if no consent present).
    const btn = await page
      .waitForSelector(`[aria-label="${ACCEPT_ARIA}"]`, { timeout: 3_000 })
      .catch(() => null);

    if (!btn) {
      // Fallback: scan all buttons for accept/agree text in case the aria-label
      // changes in a future YouTube UI update.
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>("button")
        );
        const target = candidates.find((el) => {
          const label = (el.getAttribute("aria-label") ?? "").toLowerCase();
          const text = (el.textContent ?? "").toLowerCase().trim();
          return (
            label.includes("accept") ||
            text === "accept all" ||
            text === "i agree" ||
            text === "agree"
          );
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });

      if (!clicked) return false;
      console.log(
        `[Transcript] [Headless] Consent dismissed (fallback text match)`
      );
    } else {
      await btn.click();
      console.log(
        `[Transcript] [Headless] Consent dismissed (aria-label match)`
      );
    }

    // Wait for the overlay / navigation to finish after clicking.
    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 })
      .catch(() => {
        // If no full navigation occurs (inline overlay), just wait a beat.
      });

    return true;
  } catch {
    return false;
  }
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
    // Use a simple mutable variable rather than a one-shot Promise so that
    // re-navigating after a consent dismiss doesn't leave a stale settled
    // promise.  The response listener is registered once and stays active for
    // the lifetime of the page regardless of how many navigations happen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedTimedText: any = null;

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
          capturedTimedText = json;
        }
      } catch {
        // non-JSON or stream already consumed — ignore
      }
    });

    // Navigate to the watch page.
    // - hl=en&gl=US: hint to avoid geo-based redirects.
    // - autoplay=1:  player starts immediately → fires the timedtext request.
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&autoplay=1`;
    console.log(`[Transcript] [Headless] Navigating to ${watchUrl}`);
    await page.goto(watchUrl, {
      waitUntil: "networkidle2",
      timeout: 45_000,
    });

    // ── Consent handling (URL-redirect AND inline overlay) ──────────────────
    //
    // YouTube shows consent in two ways depending on region / session state:
    //   1. Redirect to consent.youtube.com  → detectable via page.url()
    //   2. Inline lightbox overlay ON the video page → URL stays unchanged
    //
    // We handle both by first checking the URL and then ALWAYS scanning the
    // DOM for the "Accept all" button using its exact aria-label from YouTube's
    // markup: aria-label="Accept the use of cookies and other data for the
    // purposes described"
    //
    // After dismissing we re-navigate so the player loads cleanly without the
    // overlay blocking it.
    const consentAccepted = await dismissConsentIfPresent(page);
    if (consentAccepted) {
      console.log(
        `[Transcript] [Headless] Consent dismissed — re-navigating to video…`
      );
      // Reset any timedtext captured from the consent page (there won't be any
      // but reset for clarity).
      capturedTimedText = null;
      await page.goto(watchUrl, { waitUntil: "networkidle2", timeout: 45_000 });
    }

    // Persist updated cookies — including any consent cookies just set.
    const currentCookies = await page.cookies();
    await saveCookies(currentCookies as PersistedCookie[]);

    console.log(
      `[Transcript] [Headless] Landed on: ${page.url()} (title: "${await page.title()}")`
    );

    // ── Trigger playback (bypass autoplay policy) ───────────────────────────
    //
    // Chrome's Media Engagement Index starts at 0 for a fresh profile, so
    // autoplay=1 in the URL is silently ignored.  Without playback, no
    // timedtext request is ever fired (Vector A) and YouTube may serve a
    // restricted player bootstrap with no captionTracks (Vector B).
    //
    // Clicking the play button is the same as a user pressing play — it
    // satisfies Chrome's "user gesture" requirement and causes the player to
    // fully initialise, request captions, and begin streaming.
    try {
      // Wait briefly for the player controls to render after networkidle2.
      await page.waitForSelector(".ytp-play-button", { timeout: 5_000 });
      const playBtn = await page.$(
        '.ytp-play-button[data-title-no-tooltip="Play"], .ytp-play-button[aria-label*="Play"], .ytp-play-button'
      );
      if (playBtn) {
        await playBtn.click();
        console.log(
          `[Transcript] [Headless] Play button clicked — waiting for timedtext request…`
        );
      }
    } catch {
      console.warn(
        `[Transcript] [Headless] Could not find/click play button — continuing anyway`
      );
    }

    // ── Try Vector A result (poll after clicking play) ──────────────────────
    //
    // Now that the player is actually playing, the timedtext request fires
    // within 1–2 s.  Poll for up to 12 s to be safe on slow containers.
    if (capturedTimedText === null) {
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 12_000;
        const poll = setInterval(() => {
          if (capturedTimedText !== null || Date.now() >= deadline) {
            clearInterval(poll);
            resolve();
          }
        }, 200);
      });
    }

    try {
      if (capturedTimedText === null) {
        throw new Error(
          "Headless Vector A: no timedtext response intercepted within 8 s post-navigation"
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timedText = capturedTimedText as any;
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
        if (!raw)
          return { error: "ytInitialPlayerResponse not found in page context" };
        // Log the captions sub-tree so we can debug what YouTube actually
        // returned — useful when the player bootstrap differs by region/session.
        const captionsDebug = JSON.stringify(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (raw as any)?.captions ??
            (raw as any)?.playabilityStatus ??
            "(no captions/playability key)"
        ).slice(0, 400);
        return {
          error: `No captionTracks in ytInitialPlayerResponse. debug: ${captionsDebug}`,
        };
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
