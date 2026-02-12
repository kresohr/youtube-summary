import { fetchTranscript } from "youtube-transcript-plus";

export const transcribeVideo = async (videoUrl: string) => {
  try {
    const videoId = extractVideoId(videoUrl) || videoUrl;
    console.log(`Fetching transcript for id: ${videoId}`);

    const transcript = await fetchTranscript(videoUrl, {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    });

    return transcript;
  } catch (error) {
    console.error("Error transcribing video:", error);
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
