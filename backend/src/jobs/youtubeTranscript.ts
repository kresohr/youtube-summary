import { fetchTranscript } from "youtube-transcript-plus";

export const transcribeVideo = async (videoUrl: string) => {
  const videoId = extractVideoId(videoUrl) || videoUrl;
  console.log(
    `[Transcript] Fetching transcript for id: ${videoId} (input: ${videoUrl})`
  );

  try {
    const transcript = await fetchTranscript(videoId, {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    console.log(
      `[Transcript] Success for ${videoId}: ${transcript.length} segment(s), ~${transcript.reduce((sum: number, s: { text: string }) => sum + s.text.length, 0)} chars`
    );
    return transcript;
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Transcript] FAILED for ${videoId} [${errName}]: ${errMsg}`);
    throw error;
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
  } catch (e) {
    return null;
  }
}
