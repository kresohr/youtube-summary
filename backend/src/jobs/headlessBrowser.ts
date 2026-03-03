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
 * Four extraction vectors are attempted in sequence:
 *
 *   Vector A — Network interception (timedtext)
 *     A `page.on("response")` listener is registered before navigation.
 *     When the YouTube player fires the JSON3 timedtext CDN request as part of
 *     its normal initialisation, we capture the raw response body directly.
 *     This shows that even short-lived, signed CDN URLs are captured by any
 *     observer sitting between the browser and the network.
 *
 *   Vector A2 — Network interception (youtubei/v1/next)
 *     The same response listener also watches for `youtubei/v1/next` responses
 *     which are fired on every page navigation and contain a full
 *     `playerResponse` with `captionTracks`.  The caption URL is extracted and
 *     fetched from inside the browser (with credentials) when Vector A yields
 *     no result from playback.
 *
 *   Vector B — In-page JS eval + in-browser fetch  (fallback)
 *     If no timedtext response is intercepted, we call `page.evaluate()` to
 *     run code *inside* the browser's V8 engine.  From there we read
 *     `window.ytInitialPlayerResponse`, pick the best caption track, and call
 *     the browser's own `fetch()` with `credentials: "include"`.  Because this
 *     fetch originates from inside the browser, it carries the full session
 *     cookie jar automatically — making it indistinguishable from a real user
 *     clicking the captions button.
 *
 *   Vector C — DOM interaction  (last resort)
 *     Clicks the "…more" description expander, then the "Show transcript"
 *     button, waits for `ytd-transcript-segment-renderer` rows to appear, and
 *     extracts the plain text from each row.  Timestamps are captured but
 *     duration is recorded as 0.
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

    // ── Vectors A / A2: network interception ───────────────────────────────
    //
    // Use simple mutable variables rather than one-shot Promises so that
    // re-navigating after a consent dismiss doesn't leave stale settled
    // promises.  The response listener is registered once and stays active for
    // the lifetime of the page regardless of how many navigations happen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedTimedText: any = null;
    let capturedNextCaptionUrl: string | null = null;
    let capturedNextCaptionLang = "en";

    page.on("response", async (response) => {
      const url = response.url();

      // Vector A: intercept the JSON3 timedtext CDN response from playback
      if (url.includes("timedtext")) {
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
        return;
      }

      // Vector A2: extract caption track URL from youtubei/v1/next (fires on
      // every navigation, no autoplay required).
      if (url.includes("youtubei/v1/next") && capturedNextCaptionUrl === null) {
        try {
          const body = await response.text();
          if (body.length < 10) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const json = JSON.parse(body) as any;
          // Caption tracks can appear at the top-level playerResponse or
          // nested inside frameworkUpdates mutations.
          const playerResponse =
            json?.playerResponse ??
            json?.frameworkUpdates?.entityBatchUpdate?.mutations?.[0]?.payload
              ?.playerResponse;
          const tracks: Array<{
            baseUrl: string;
            languageCode: string;
            kind?: string;
          }> =
            playerResponse?.captions?.playerCaptionsTracklistRenderer
              ?.captionTracks ?? [];
          if (tracks.length > 0) {
            // Rank: manual captions first, English preferred
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
            capturedNextCaptionUrl = rawUrl.includes("fmt=")
              ? rawUrl.replace(/fmt=[^&]*/, "fmt=json3")
              : `${rawUrl}&fmt=json3`;
            capturedNextCaptionLang = track.languageCode;
            console.log(
              `[Transcript] [Headless] Vector A2: got captionTrack URL from youtubei/v1/next (lang: ${track.languageCode})`
            );
          }
        } catch {
          // parse error — ignore
        }
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
      capturedNextCaptionUrl = null;
      capturedNextCaptionLang = "en";
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
        `[Transcript] [Headless] Vector A: intercepted response had 0 segments — trying Vector A2`
      );
    } catch (interceptErr) {
      const msg =
        interceptErr instanceof Error
          ? interceptErr.message
          : String(interceptErr);
      console.warn(
        `[Transcript] [Headless] Vector A failed: ${msg} — trying Vector A2`
      );
    }

    // ── Vector A2: in-browser fetch of caption URL from /next response ───────
    //
    // If the timedtext CDN request was never fired (autoplay blocked), but the
    // navigation itself returned a /next response with captionTracks, we can
    // still fetch the timed-text by issuing the request from inside the
    // browser (with credentials: "include") using the URL we extracted above.
    if (capturedNextCaptionUrl !== null) {
      console.log(
        `[Transcript] [Headless] Vector A2: fetching timedtext using URL from /next response…`
      );
      try {
        const vectorA2Result = await page.evaluate(
          async (
            timedTextUrl: string
          ): Promise<{ body: string } | { error: string }> => {
            const resp = await fetch(timedTextUrl, { credentials: "include" });
            if (!resp.ok) return { error: `HTTP ${resp.status}` };
            const body = await resp.text();
            if (body.length === 0) return { error: "empty body" };
            return { body };
          },
          capturedNextCaptionUrl
        );
        if ("body" in vectorA2Result) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const timedText = JSON.parse(vectorA2Result.body) as any;
          const events: Json3Event[] = timedText?.events ?? [];
          const segments = json3ToSegments(events, capturedNextCaptionLang);
          if (segments.length > 0) {
            const charCount = segments.reduce(
              (sum, s) => sum + s.text.length,
              0
            );
            console.log(
              `[Transcript] Success (Headless / Vector A2 — youtubei/v1/next) for ${videoId}: ` +
                `${segments.length} segment(s), ~${charCount} chars`
            );
            return segments;
          }
        } else {
          console.warn(
            `[Transcript] [Headless] Vector A2 fetch failed: ${
              (vectorA2Result as { error: string }).error
            }`
          );
        }
      } catch (a2Err) {
        console.warn(
          `[Transcript] [Headless] Vector A2 failed: ${
            a2Err instanceof Error ? a2Err.message : String(a2Err)
          }`
        );
      }
    } else {
      console.warn(
        `[Transcript] [Headless] Vector A2 skipped: no caption URL captured from /next responses`
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

        // Detect bot-mitigation / age-gate before reporting a generic error.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status: string | undefined = (raw as any)?.playabilityStatus
          ?.status;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reason: string | undefined = (raw as any)?.playabilityStatus
          ?.reason;
        if (
          status === "LOGIN_REQUIRED" ||
          status === "UNPLAYABLE" ||
          status === "ERROR"
        ) {
          return {
            error: `playabilityStatus=${status}${reason ? ` — ${reason}` : ""}`,
            loginRequired: status === "LOGIN_REQUIRED",
          };
        }

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

    let vectorBErrorMsg: string | null = null;
    if ("error" in vectorBResult) {
      const msg = (vectorBResult as { error: string; loginRequired?: boolean })
        .error;
      const isLoginRequired =
        (vectorBResult as { loginRequired?: boolean }).loginRequired === true;
      if (isLoginRequired) {
        // YouTube is actively blocking this session — no point retrying with
        // a different vector.  Surface a concise, actionable error.
        throw new Error(
          `Headless Vector B: bot-detection/LOGIN_REQUIRED — ${msg}`
        );
      }
      vectorBErrorMsg = msg;
    } else {
      const { body, lang } = vectorBResult as { body: string; lang: string };
      if (!body || body.length === 0) {
        vectorBErrorMsg = "in-browser fetch returned empty body";
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timedText = JSON.parse(body) as any;
        const events: Json3Event[] = timedText?.events ?? [];
        const segments = json3ToSegments(events, lang);
        if (segments.length === 0) {
          vectorBErrorMsg = `timedtext response yielded no segments for ${videoId}`;
        } else {
          const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
          console.log(
            `[Transcript] Success (Headless / Vector B — in-page JS eval + in-browser fetch) for ${videoId}: ` +
              `${segments.length} segment(s), ~${charCount} chars`
          );
          return segments;
        }
      }
    }

    if (vectorBErrorMsg) {
      console.warn(
        `[Transcript] [Headless] Vector B failed: ${vectorBErrorMsg} — trying Vector C`
      );
    }

    // ── Vector C: DOM interaction — click “Show transcript” ────────────────────
    //
    // Last resort: mimic a user opening the transcript panel in the YouTube UI.
    //   1. Expand the video description (“…more” button).
    //   2. Click “Show transcript” inside the expanded description.
    //   3. Wait for ytd-transcript-segment-renderer rows to render.
    //   4. Extract the timestamp + text from each row.
    //
    // Duration is not available from the UI so it is recorded as 0.
    console.log(
      `[Transcript] [Headless] Vector C: clicking "Show transcript" in description`
    );
    try {
      // Step 1: Expand the description (the “…more” / #expand button)
      try {
        await page.waitForSelector(
          "tp-yt-paper-button#expand, ytd-text-inline-expander #expand",
          { timeout: 5_000 }
        );
        await page.click(
          "tp-yt-paper-button#expand, ytd-text-inline-expander #expand"
        );
      } catch {
        // Expander may already be visible or absent — continue
      }

      // Step 2: Click the "Show transcript" button in the expanded description
      await page.waitForSelector(
        "ytd-video-description-transcript-section-renderer button",
        { timeout: 6_000 }
      );
      await page.click(
        "ytd-video-description-transcript-section-renderer button"
      );

      // Step 3: Wait for transcript segment rows to appear in the panel
      await page.waitForSelector("ytd-transcript-segment-renderer", {
        timeout: 10_000,
      });

      // Step 4: Extract timestamp + text from every segment row
      const rawSegments = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll("ytd-transcript-segment-renderer")
        );
        return rows.map((row) => {
          const tsEl = row.querySelector("[class*='timestamp']");
          const textEl = row.querySelector("[class*='segment-text']") ?? row;
          const tsText = tsEl?.textContent?.trim() ?? "";
          let offset = 0;
          const parts = tsText.split(":").map(Number);
          if (parts.length === 2) offset = parts[0] * 60 + parts[1];
          else if (parts.length === 3)
            offset = parts[0] * 3600 + parts[1] * 60 + parts[2];
          return { text: textEl.textContent?.trim() ?? "", offset };
        });
      });

      const segments: TranscriptSegment[] = rawSegments
        .filter((s) => s.text.length > 0)
        .map((s) => ({
          text: s.text,
          offset: s.offset,
          duration: 0,
          lang: "en",
        }));

      if (segments.length === 0) {
        throw new Error("no segment text found in DOM");
      }

      const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
      console.log(
        `[Transcript] Success (Headless / Vector C — DOM interaction) for ${videoId}: ` +
          `${segments.length} segment(s), ~${charCount} chars`
      );
      return segments;
    } catch (vectorCErr) {
      const msg =
        vectorCErr instanceof Error ? vectorCErr.message : String(vectorCErr);
      throw new Error(`Headless Vector C: ${msg}`);
    }
  } finally {
    // Always close the browser — even on error — to avoid zombie Chromium processes
    await browser.close();
    console.log(`[Transcript] [Headless] Browser closed for ${videoId}`);
  }
}
