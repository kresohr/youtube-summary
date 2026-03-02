import { fetchTranscript } from "youtube-transcript-plus";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Innertube player clients to try in order.
 * WEB is tried first — it returns captions for more video types than ANDROID.
 * ANDROID is kept as a fallback since it was the library's original default.
 *
 * Background: youtube-transcript-plus hardcodes clientName: 'ANDROID' which causes
 * YouTube to omit the `captions` field for some videos, resulting in a false
 * YoutubeTranscriptNotAvailableError even when captions exist. The WEB client
 * consistently returns captions for these videos.
 */
const PLAYER_CLIENTS = [
  { clientName: "WEB", clientVersion: "2.20240731.05.00" },
  { clientName: "ANDROID", clientVersion: "20.10.38" },
] as const;

export const transcribeVideo = async (videoUrl: string) => {
  const videoId = extractVideoId(videoUrl) || videoUrl;
  console.log(
    `[Transcript] Fetching transcript for id: ${videoId} (input: ${videoUrl})`
  );

  let lastError: unknown = null;

  for (const client of PLAYER_CLIENTS) {
    console.log(
      `[Transcript] Trying Innertube client ${client.clientName} for ${videoId}`
    );
    try {
      const transcript = await fetchTranscript(videoId, {
        userAgent: USER_AGENT,
        // Override the player POST body to use the chosen Innertube client context.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        playerFetch: async (params: any) => {
          const body = JSON.parse(params.body ?? "{}");
          body.context ??= {};
          body.context.client = {
            ...(body.context.client ?? {}),
            clientName: client.clientName,
            clientVersion: client.clientVersion,
          };
          return fetch(params.url, {
            method: "POST",
            headers: {
              "User-Agent": params.userAgent ?? USER_AGENT,
              "Content-Type": "application/json",
              ...(params.headers ?? {}),
            },
            body: JSON.stringify(body),
          });
        },
      });

      const charCount = transcript.reduce(
        (sum: number, s: { text: string }) => sum + s.text.length,
        0
      );
      console.log(
        `[Transcript] Success (${client.clientName}) for ${videoId}: ${transcript.length} segment(s), ~${charCount} chars`
      );
      return transcript;
    } catch (error) {
      const errName =
        error instanceof Error ? error.constructor.name : "Unknown";
      const errMsg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Transcript] Client ${client.clientName} failed for ${videoId} [${errName}]: ${errMsg}`
      );
      lastError = error;
    }
  }

  // All Innertube clients exhausted — try TubeText as last-resort fallback
  console.warn(
    `[Transcript] All Innertube clients failed for ${videoId}, trying TubeText fallback...`
  );
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
  }

  // Everything failed
  const errName =
    lastError instanceof Error ? lastError.constructor.name : "Unknown";
  const errMsg =
    lastError instanceof Error ? lastError.message : String(lastError);
  console.error(
    `[Transcript] All sources FAILED for ${videoId} [${errName}]: ${errMsg}`
  );
  throw lastError;
};

/**
 * Fallback transcript fetch via TubeText (free, no API key needed).
 * Returns segments in the same {text, duration, offset, lang} shape as youtube-transcript-plus.
 */
async function fetchTranscriptFromTubeText(
  videoId: string
): Promise<{ text: string; duration: number; offset: number; lang: string }[]> {
  const url = `https://tubetext.app/api/transcript?videoId=${videoId}`;
  console.log(`[Transcript] TubeText request: GET ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`TubeText API error for ${videoId}: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.transcript || !Array.isArray(data.transcript)) {
    throw new Error(
      `TubeText returned unexpected shape for ${videoId}: ${JSON.stringify(data).substring(0, 200)}`
    );
  }

  // Normalise to {text, duration, offset, lang}
  return data.transcript.map(
    (segment: { text: string; duration?: number; offset?: number; lang?: string }) => ({
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
