const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Canonical segment shape returned by all transcript sources. */
export interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
  lang: string;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** "asr" = auto-generated captions; absent = manual captions */
  kind?: string;
}

interface Json3Event {
  tStartMs: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

// ─── Primary method: ytInitialPlayerResponse scraper ─────────────────────────

/**
 * Extract the ytInitialPlayerResponse JSON object from a YouTube page's raw HTML.
 * Uses bracket-depth counting (respecting strings and escape sequences) to
 * reliably locate the end of the JSON blob regardless of its size.
 */
function extractPlayerResponseFromHtml(html: string): unknown {
  const marker = "ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start === -1) {
    throw new Error("ytInitialPlayerResponse not found in page HTML");
  }

  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  let i = jsonStart;

  for (; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }

  return JSON.parse(html.slice(jsonStart, i + 1));
}

/**
 * Primary transcript method.
 * 1. Fetches the YouTube watch page (desktop HTML, Chrome UA).
 * 2. Extracts ytInitialPlayerResponse and locates captionTracks.
 * 3. Ranks tracks: manual captions > auto-generated (asr); English > other.
 * 4. Fetches the best track as JSON3 (&fmt=json3) and maps events to segments.
 */
async function fetchTranscriptViaScrape(
  videoId: string
): Promise<TranscriptSegment[]> {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[Transcript] Scraping YouTube page: ${pageUrl}`);

  const pageResponse = await fetch(pageUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!pageResponse.ok) {
    throw new Error(
      `YouTube page fetch failed for ${videoId}: HTTP ${pageResponse.status}`
    );
  }

  // Collect session cookies so server-side timedtext requests look more like a
  // real browser continuation of the same session.
  const pageCookies =
    pageResponse.headers
      .getSetCookie?.()
      ?.map((c) => c.split(";")[0])
      .join("; ") ?? "";

  const html = await pageResponse.text();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerResponse = extractPlayerResponseFromHtml(html) as any;

  const captionTracks: CaptionTrack[] | undefined =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error(`No caption tracks available for ${videoId}`);
  }

  console.log(
    `[Transcript] Found ${captionTracks.length} caption track(s) for ${videoId}: ` +
      captionTracks
        .map((t) => `${t.languageCode}${t.kind ? `(${t.kind})` : ""}`)
        .join(", ")
  );

  // Rank: manual captions first, then English preferred over other languages
  const ranked = [...captionTracks].sort((a, b) => {
    const aManual = a.kind !== "asr" ? 0 : 1;
    const bManual = b.kind !== "asr" ? 0 : 1;
    if (aManual !== bManual) return aManual - bManual;
    const aEn = a.languageCode.startsWith("en") ? 0 : 1;
    const bEn = b.languageCode.startsWith("en") ? 0 : 1;
    return aEn - bEn;
  });

  const track = ranked[0];
  // baseUrl values inside ytInitialPlayerResponse are HTML-entity-encoded
  // (& → &amp;). Decode before constructing the actual fetch URL.
  // Also normalise any existing fmt= param to json3.
  const rawBaseUrl = track.baseUrl.replace(/&amp;/g, "&");
  const trackUrl = rawBaseUrl.includes("fmt=")
    ? rawBaseUrl.replace(/fmt=[^&]*/, "fmt=json3")
    : `${rawBaseUrl}&fmt=json3`;
  console.log(
    `[Transcript] Fetching timedtext track (${track.languageCode}${track.kind ? `, ${track.kind}` : ""}) for ${videoId}`
  );

  const timedTextResponse = await fetch(trackUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      // Forwarding Referer + session cookies makes the request resemble a
      // real browser continuation, which increases the chance of a non-empty
      // response from YouTube's video-timedtext servers.
      Referer: "https://www.youtube.com/",
      ...(pageCookies ? { Cookie: pageCookies } : {}),
    },
  });

  if (!timedTextResponse.ok) {
    throw new Error(
      `TimedText fetch failed for ${videoId}: HTTP ${timedTextResponse.status}`
    );
  }

  const timedTextBody = await timedTextResponse.text();

  if (timedTextBody.length === 0) {
    // YouTube's video-timedtext server sometimes returns an empty 200 response
    // for server-side clients even when captions exist (bot mitigation). The
    // InnerTube /player API provides an alternative route to the same data.
    throw new Error(
      `TimedText endpoint returned empty body for ${videoId} — likely server-side bot mitigation`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const timedText = JSON.parse(timedTextBody) as any;
  const events: Json3Event[] = timedText?.events ?? [];

  const segments: TranscriptSegment[] = events
    .filter((e) => Array.isArray(e.segs))
    .map((e) => ({
      text: (e.segs ?? []).map((s) => s.utf8 ?? "").join(""),
      duration: (e.dDurationMs ?? 0) / 1000,
      offset: e.tStartMs / 1000,
      lang: track.languageCode,
    }))
    .filter((s) => s.text.trim().length > 0);

  if (segments.length === 0) {
    throw new Error(`TimedText track yielded no segments for ${videoId}`);
  }

  return segments;
}

// ─── Secondary method: InnerTube /player API ──────────────────────────────────

/**
 * Public default API key embedded in all YouTube web pages.
 * Not secret — YouTube bakes it into the public JS bundle.
 */
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/**
 * Innertube player clients to try in order.
 * ANDROID returns captions for the widest range of video types.
 * WEB is tried second as a fallback.
 */
const INNERTUBE_CLIENTS = [
  { clientName: "ANDROID", clientVersion: "19.44.38" },
  { clientName: "WEB", clientVersion: "2.20260303.00.00" },
] as const;

/**
 * Fetch caption tracks via the InnerTube /youtubei/v1/player API, then
 * download the best track in JSON3 format.
 *
 * This is the fallback when the page-scraping approach returns empty timedtext
 * responses (which happens when YouTube's video-timedtext servers identify
 * server-side clients via bot-mitigation heuristics).
 */
async function fetchTranscriptViaInnerTube(
  videoId: string
): Promise<TranscriptSegment[]> {
  let lastError: unknown = null;

  for (const client of INNERTUBE_CLIENTS) {
    console.log(
      `[Transcript] InnerTube client ${client.clientName} for ${videoId}`
    );
    try {
      const playerResp = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_API_KEY}`,
        {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: client.clientName,
                clientVersion: client.clientVersion,
                hl: "en",
                gl: "US",
              },
            },
          }),
        }
      );

      if (!playerResp.ok) {
        throw new Error(
          `InnerTube player API returned HTTP ${playerResp.status}`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const playerBody = (await playerResp.json()) as any;
      const captionTracks: CaptionTrack[] | undefined =
        playerBody?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (!captionTracks || captionTracks.length === 0) {
        throw new Error(
          `InnerTube ${client.clientName}: no caption tracks returned`
        );
      }

      // Rank tracks: manual first, English preferred
      const ranked = [...captionTracks].sort((a, b) => {
        const aManual = a.kind !== "asr" ? 0 : 1;
        const bManual = b.kind !== "asr" ? 0 : 1;
        if (aManual !== bManual) return aManual - bManual;
        const aEn = a.languageCode.startsWith("en") ? 0 : 1;
        const bEn = b.languageCode.startsWith("en") ? 0 : 1;
        return aEn - bEn;
      });

      const track = ranked[0];
      const rawBaseUrl = track.baseUrl.replace(/&amp;/g, "&");
      const trackUrl = rawBaseUrl.includes("fmt=")
        ? rawBaseUrl.replace(/fmt=[^&]*/, "fmt=json3")
        : `${rawBaseUrl}&fmt=json3`;

      console.log(
        `[Transcript] InnerTube ${client.clientName}: fetching timedtext (${track.languageCode}${track.kind ? `, ${track.kind}` : ""}) for ${videoId}`
      );

      const timedTextResp = await fetch(trackUrl, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!timedTextResp.ok) {
        throw new Error(`InnerTube timedtext HTTP ${timedTextResp.status}`);
      }

      const timedTextBody = await timedTextResp.text();
      if (timedTextBody.length === 0) {
        throw new Error(
          `InnerTube ${client.clientName}: timedtext endpoint returned empty body`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const timedText = JSON.parse(timedTextBody) as any;
      const events: Json3Event[] = timedText?.events ?? [];

      const segments: TranscriptSegment[] = events
        .filter((e) => Array.isArray(e.segs))
        .map((e) => ({
          text: (e.segs ?? []).map((s) => s.utf8 ?? "").join(""),
          duration: (e.dDurationMs ?? 0) / 1000,
          offset: e.tStartMs / 1000,
          lang: track.languageCode,
        }))
        .filter((s) => s.text.trim().length > 0);

      if (segments.length === 0) {
        throw new Error(
          `InnerTube ${client.clientName}: timedtext track yielded no segments`
        );
      }

      const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
      console.log(
        `[Transcript] Success (InnerTube ${client.clientName}) for ${videoId}: ${segments.length} segment(s), ~${charCount} chars`
      );
      return segments;
    } catch (err) {
      const errName = err instanceof Error ? err.constructor.name : "Unknown";
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Transcript] InnerTube ${client.clientName} failed for ${videoId} [${errName}]: ${errMsg}`
      );
      lastError = err;
    }
  }

  throw lastError ?? new Error(`InnerTube: all clients failed for ${videoId}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a transcript for the given YouTube URL or video ID.
 *
 * Strategy (tried in order, first success wins):
 *   1. HTML scraper  — fetches ytInitialPlayerResponse from the watch page,
 *                      extracts captionTracks, downloads JSON3 timedtext.
 *                      Works from browser environments; may return empty bodies
 *                      from server IPs that YouTube identifies as bots.
 *   2. InnerTube API — POSTs to /youtubei/v1/player with ANDROID then WEB
 *                      Innertube clients, retrieves fresh timedtext URLs that
 *                      are not subject to the same server-side restrictions.
 *   3. TubeText      — third-party transcript service, last resort.
 *
 * Throws if all three sources fail.
 */
export const transcribeVideo = async (
  videoUrl: string
): Promise<TranscriptSegment[]> => {
  const videoId = extractVideoId(videoUrl) || videoUrl;
  console.log(
    `[Transcript] Fetching transcript for id: ${videoId} (input: ${videoUrl})`
  );

  // ── Method 1: HTML scraper (ytInitialPlayerResponse) ─────────────────────
  try {
    const segments = await fetchTranscriptViaScrape(videoId);
    const charCount = segments.reduce((sum, s) => sum + s.text.length, 0);
    console.log(
      `[Transcript] Success (scraper) for ${videoId}: ${segments.length} segment(s), ~${charCount} chars`
    );
    return segments;
  } catch (scrapeError) {
    const errName =
      scrapeError instanceof Error ? scrapeError.constructor.name : "Unknown";
    const errMsg =
      scrapeError instanceof Error ? scrapeError.message : String(scrapeError);
    console.warn(
      `[Transcript] Scraper failed for ${videoId} [${errName}]: ${errMsg}`
    );
  }

  // ── Method 2: InnerTube /player API ──────────────────────────────────────
  console.warn(`[Transcript] Trying InnerTube fallback for ${videoId}...`);
  try {
    const segments = await fetchTranscriptViaInnerTube(videoId);
    return segments;
  } catch (innerTubeError) {
    const errName =
      innerTubeError instanceof Error
        ? innerTubeError.constructor.name
        : "Unknown";
    const errMsg =
      innerTubeError instanceof Error
        ? innerTubeError.message
        : String(innerTubeError);
    console.warn(
      `[Transcript] InnerTube fallback failed for ${videoId} [${errName}]: ${errMsg}`
    );
  }

  // ── Method 3: TubeText ───────────────────────────────────────────────────
  console.warn(`[Transcript] Trying TubeText fallback for ${videoId}...`);
  try {
    const tubeTextSegments = await fetchTranscriptFromTubeText(videoId);
    if (tubeTextSegments && tubeTextSegments.length > 0) {
      const charCount = tubeTextSegments.reduce(
        (sum, s) => sum + s.text.length,
        0
      );
      console.log(
        `[Transcript] Success (TubeText) for ${videoId}: ${tubeTextSegments.length} segment(s), ~${charCount} chars`
      );
      return tubeTextSegments;
    }
    throw new Error("TubeText returned an empty transcript");
  } catch (tubeTextError) {
    const errName =
      tubeTextError instanceof Error
        ? tubeTextError.constructor.name
        : "Unknown";
    const errMsg =
      tubeTextError instanceof Error
        ? tubeTextError.message
        : String(tubeTextError);
    console.error(
      `[Transcript] TubeText fallback FAILED for ${videoId} [${errName}]: ${errMsg}`
    );
    throw tubeTextError;
  }
};

// ─── TubeText fallback ────────────────────────────────────────────────────────

/**
 * Fallback transcript fetch via TubeText (free, no API key needed).
 * Returns segments in the canonical TranscriptSegment shape.
 */
async function fetchTranscriptFromTubeText(
  videoId: string
): Promise<TranscriptSegment[]> {
  const url = `https://tubetext.com/api/transcript?videoId=${videoId}`;
  console.log(`[Transcript] TubeText request: GET ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(
      `TubeText API error for ${videoId}: HTTP ${response.status}`
    );
  }

  const data = await response.json();

  // TubeText may nest the array under different keys depending on its version
  const rawSegments: unknown[] | undefined = Array.isArray(data.transcript)
    ? data.transcript
    : Array.isArray(data.segments)
      ? data.segments
      : Array.isArray(data.data)
        ? data.data
        : undefined;

  if (!rawSegments) {
    throw new Error(
      `TubeText returned unexpected shape for ${videoId}: ${JSON.stringify(data).substring(0, 200)}`
    );
  }

  // Normalise to TranscriptSegment shape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rawSegments.map(
    (segment: any): TranscriptSegment => ({
      text: segment.text ?? "",
      duration: segment.duration ?? 0,
      offset: segment.offset ?? 0,
      lang: segment.lang ?? "en",
    })
  );
}

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
  } catch (e) {
    return null;
  }
}
