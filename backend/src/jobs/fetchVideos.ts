import { query } from "../lib/db.js";
import { transcribeVideo, LoginRequiredError } from "./youtubeTranscript.js";
import {
  summarizeVideoWithGemini,
  summarizeTranscriptWithGemini,
} from "./geminiSummary.js";

interface YouTubeVideoItem {
  id: { videoId: string };
  snippet: {
    title: string;
    description: string;
    thumbnails: {
      high: { url: string };
    };
    publishedAt: string;
  };
}

interface YouTubeVideoDetails {
  id: string;
  contentDetails: {
    duration: string; // ISO 8601 duration, e.g. "PT1H2M3S"
  };
}

interface ParsedVideo {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  publishedAt: string;
  durationSeconds: number | null;
}

/** Parse an ISO 8601 duration string (e.g. "PT1H2M3S") to total seconds. */
export function parseIso8601Duration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/** Batch-fetch contentDetails durations for up to 50 video IDs in one API call. */
export async function fetchVideoDurations(
  videoIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (videoIds.length === 0) return map;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return map;

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("id", videoIds.join(","));
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return map;
    const data = await response.json();
    if (!data.items || !Array.isArray(data.items)) return map;
    for (const item of data.items as YouTubeVideoDetails[]) {
      map.set(item.id, parseIso8601Duration(item.contentDetails.duration));
    }
  } catch (error) {
    console.error("Error fetching video durations:", error);
  }

  return map;
}

/** Fetch latest videos from a YouTube channel published in the last N hours. */
async function fetchLatestVideos(
  channelId: string,
  hoursAgo: number
): Promise<ParsedVideo[]> {
  const publishedAfter = new Date(
    Date.now() - hoursAgo * 60 * 60 * 1000
  ).toISOString();

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set");
    return [];
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "date");
  url.searchParams.set("publishedAfter", publishedAfter);
  url.searchParams.set("maxResults", "10");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `YouTube API error for channel ${channelId}: ${response.status} - ${errorText}`
    );
    return [];
  }

  const data = await response.json();

  if (!data.items || !Array.isArray(data.items)) {
    return [];
  }

  const parsed: Omit<ParsedVideo, "durationSeconds">[] = data.items.map(
    (item: YouTubeVideoItem) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail: item.snippet.thumbnails.high.url,
      publishedAt: item.snippet.publishedAt,
    })
  );

  const durationsMap = await fetchVideoDurations(parsed.map((v) => v.id));

  return parsed.map((v) => ({
    ...v,
    durationSeconds: durationsMap.get(v.id) ?? null,
  }));
}

/**
 * Fetch transcript from YouTube via yt-dlp.
 * Returns the full transcript text, or null if unavailable.
 * Rethrows LoginRequiredError so callers can skip sign-in-gated videos.
 */
export async function getTranscriptFromYouTube(
  videoId: string
): Promise<string | null> {
  console.log(
    `[GetTranscript] Starting transcript fetch for videoId: ${videoId}`
  );
  try {
    const videoUrl = `https://youtube.com/watch?v=${videoId}`;
    const transcriptSegments = await transcribeVideo(videoUrl);

    if (!transcriptSegments || transcriptSegments.length === 0) {
      console.warn(`[GetTranscript] No segments returned for ${videoId}`);
      return null;
    }

    const fullText = transcriptSegments
      .map((segment: { text: string }) => segment.text)
      .join(" ");

    console.log(
      `[GetTranscript] Transcript for ${videoId}: ${fullText.length} chars`
    );
    return fullText;
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[GetTranscript] FAILED for ${videoId} [${errName}]: ${errMsg}`
    );
    if (error instanceof LoginRequiredError) throw error;
    return null;
  }
}

/**
 * Generate a summary using OpenRouter API — last-resort Tier 3 fallback.
 */
export async function generateSummaryWithOpenRouter(
  transcript: string,
  videoTitle: string
): Promise<string> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY is not set");
      return transcript.substring(0, 300) + "...";
    }

    const maxChars = 8000;
    const truncatedTranscript =
      transcript.length > maxChars
        ? transcript.substring(0, maxChars) + "..."
        : transcript;

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://gladansam.xyz/fetch",
          "X-Title": "YouTube Summary System",
        },
        body: JSON.stringify({
          model: "openrouter/free",
          messages: [
            {
              role: "system",
              content: `You are a helpful assistant that creates structured summaries of YouTube videos.
You MUST always respond in valid Markdown using EXACTLY the following structure — no deviations, no extra sections, no plain text:

## 📝 Overview
A 2–4 sentence high-level description of what the video is about.

## 🔑 Key Points
- Bullet point 1
- Bullet point 2
- Bullet point 3
(Add as many bullet points as needed to cover all important points.)

## 💡 Key Takeaways
- The most important insight or lesson from the video.
- Additional takeaway if applicable.

## 🏷️ Topics Covered
- Topic 1
- Topic 2
- Topic 3

Rules:
- Always use the exact headings above (including emojis).
- Use Markdown bullet lists (- ) under every section.
- Do NOT add any text outside of these four sections.
- Do NOT wrap your response in a code block.
- The response must be valid Markdown that renders correctly.`,
            },
            {
              role: "user",
              content: `Summarize this YouTube video using the exact Markdown structure specified.\n\nTitle: ${videoTitle}\n\nTranscript:\n${truncatedTranscript}`,
            },
          ],
          temperature: 0.7,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error: ${response.status} - ${errorText}`
      );
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating summary with OpenRouter:", error);
    return transcript.substring(0, 300) + "...";
  }
}

/**
 * Three-tier summary cascade for a single video.
 *
 * Tier 1 — Gemini CLI receives the YouTube URL directly (multimodal). Gemini
 *           processes the video natively — no transcript extraction needed.
 *           Fastest and highest quality when GEMINI_API_KEY is set.
 *
 * Tier 2 — yt-dlp extracts transcript → Gemini CLI summarises the text.
 *           Used when Tier 1 fails (e.g. very new video not yet indexed).
 *
 * Tier 3 — OpenRouter free model with the best available text (yt-dlp
 *           transcript or video description). Last resort.
 *
 * Returns null when no usable content is found — caller should enqueue the
 * video to pending_videos for a later retry, or discard it.
 *
 * Rethrows LoginRequiredError so callers can skip sign-in-gated videos.
 */
export async function getVideoSummaryForVideo(
  videoId: string,
  title: string,
  description: string | null
): Promise<string | null> {
  const videoUrl = `https://youtube.com/watch?v=${videoId}`;
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);

  // ── Tier 1: Gemini CLI — direct YouTube URL ───────────────────────────────
  if (hasGemini) {
    try {
      console.log(`[Summary] Tier 1 (Gemini direct) for ${videoId}...`);
      const summary = await summarizeVideoWithGemini(videoUrl);
      console.log(
        `[Summary] Tier 1 succeeded for ${videoId}: ${summary.length} chars`
      );
      return summary;
    } catch (err) {
      console.warn(
        `[Summary] Tier 1 failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Fetch transcript via yt-dlp (shared input for Tiers 2 & 3) ───────────
  let transcript: string | null = null;
  try {
    transcript = await getTranscriptFromYouTube(videoId);
  } catch (err) {
    if (err instanceof LoginRequiredError) throw err;
    // yt-dlp unavailable or no subtitles — continue to description fallback
  }

  // ── Tier 2: yt-dlp transcript → Gemini CLI ────────────────────────────────
  if (transcript && transcript.length >= 100 && hasGemini) {
    try {
      console.log(`[Summary] Tier 2 (yt-dlp + Gemini) for ${videoId}...`);
      const summary = await summarizeTranscriptWithGemini(transcript, title);
      console.log(
        `[Summary] Tier 2 succeeded for ${videoId}: ${summary.length} chars`
      );
      return summary;
    } catch (err) {
      console.warn(
        `[Summary] Tier 2 failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Tier 3: OpenRouter with best available text ───────────────────────────
  const bestText =
    transcript && transcript.length >= 100
      ? transcript
      : description && description.length >= 100
        ? description
        : null;

  if (bestText) {
    console.log(`[Summary] Tier 3 (OpenRouter) for ${videoId}...`);
    return generateSummaryWithOpenRouter(bestText, title);
  }

  // No usable content found
  return null;
}

/** Retry pending videos that previously had no usable content. */
async function processPendingVideos(): Promise<void> {
  const pendingResult = await query(
    "SELECT * FROM pending_videos ORDER BY added_at ASC",
    []
  );
  const pending = pendingResult.rows;
  if (pending.length === 0) return;

  console.log(
    `[${new Date().toISOString()}] Processing ${pending.length} pending video(s)...`
  );

  for (const row of pending) {
    try {
      console.log(
        `[Pending] Retrying "${row.title}" (${row.video_id}), retry_count=${row.retry_count}`
      );

      let summary: string | null = null;
      try {
        summary = await getVideoSummaryForVideo(
          row.video_id,
          row.title,
          row.description
        );
      } catch (err) {
        if (err instanceof LoginRequiredError) {
          console.warn(
            `[Pending] Discarding login-required video "${row.title}" (${row.video_id}): sign-in-gated`
          );
          await query("DELETE FROM pending_videos WHERE video_id = $1", [
            row.video_id,
          ]);
          continue;
        }
        throw err;
      }

      if (!summary) {
        if (row.retry_count >= 1) {
          console.log(
            `[Pending] Discarding "${row.title}" — no content after retry`
          );
          await query("DELETE FROM pending_videos WHERE video_id = $1", [
            row.video_id,
          ]);
        } else {
          await query(
            "UPDATE pending_videos SET retry_count = retry_count + 1 WHERE video_id = $1",
            [row.video_id]
          );
          console.log(
            `[Pending] No content yet for "${row.title}", will retry next run.`
          );
        }
        continue;
      }

      await query(
        `INSERT INTO videos (id, video_id, title, thumbnail, summary, video_url, published_at, fetched_at, channel_id, duration_seconds)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7, $8)
         ON CONFLICT (video_id) DO NOTHING`,
        [
          row.video_id,
          row.title,
          row.thumbnail,
          summary,
          row.video_url,
          row.published_at,
          row.channel_id,
          row.duration_seconds,
        ]
      );
      await query("DELETE FROM pending_videos WHERE video_id = $1", [
        row.video_id,
      ]);
      console.log(`[Pending] ✓ Processed: ${row.title}`);
    } catch (error) {
      console.error(
        `[Pending] Error processing ${row.title}:`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}

/**
 * Main cron function: fetch latest videos from channels, summarize, and store.
 * @param categoryFilter - Only process channels with this category (default: 'main')
 */
export async function fetchAndSummarizeVideos(
  categoryFilter: string = "main"
): Promise<void> {
  console.log(
    `[${new Date().toISOString()}] Starting video fetch job for category: "${categoryFilter}"...`
  );

  const channelsResult = await query(
    "SELECT * FROM youtube_channels WHERE LOWER(category) = LOWER($1)",
    [categoryFilter]
  );
  const channels = channelsResult.rows;

  if (channels.length === 0) {
    console.log("No channels configured. Skipping.");
    return;
  }

  let processedCount = 0;

  for (const channel of channels) {
    try {
      console.log(
        `[${new Date().toISOString()}] Processing channel: ${channel.channel_name}`
      );

      const videos = await fetchLatestVideos(channel.channel_id, 24);
      console.log(`  Found ${videos.length} videos in last 24h`);

      for (const video of videos) {
        const [existsInVideos, existsInPending] = await Promise.all([
          query("SELECT id FROM videos WHERE video_id = $1", [video.id]),
          query("SELECT id FROM pending_videos WHERE video_id = $1", [
            video.id,
          ]),
        ]);

        if (existsInVideos.rows.length > 0 || existsInPending.rows.length > 0) {
          console.log(
            `  Skipping already processed/queued video: ${video.title}`
          );
          continue;
        }

        console.log(`  Processing: ${video.title} (${video.id})`);

        let summary: string | null = null;
        try {
          summary = await getVideoSummaryForVideo(
            video.id,
            video.title,
            video.description
          );
        } catch (err) {
          if (err instanceof LoginRequiredError) {
            console.warn(
              `  Skipping login-required video "${video.title}" (${video.id})`
            );
            continue;
          }
          throw err;
        }

        if (!summary) {
          console.log(`  No content for "${video.title}" — queuing for retry.`);
          await query(
            `INSERT INTO pending_videos (id, video_id, title, thumbnail, description, video_url, published_at, channel_id, duration_seconds)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (video_id) DO NOTHING`,
            [
              video.id,
              video.title,
              video.thumbnail,
              video.description,
              `https://youtube.com/watch?v=${video.id}`,
              new Date(video.publishedAt),
              channel.id,
              video.durationSeconds,
            ]
          );
          continue;
        }

        await query(
          `INSERT INTO videos (id, video_id, title, thumbnail, summary, video_url, published_at, fetched_at, channel_id, duration_seconds)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7, $8)`,
          [
            video.id,
            video.title,
            video.thumbnail,
            summary,
            `https://youtube.com/watch?v=${video.id}`,
            new Date(video.publishedAt),
            channel.id,
            video.durationSeconds,
          ]
        );

        processedCount++;
        console.log(`  ✓ Saved video: ${video.title}`);
      }
    } catch (error) {
      console.error(
        `Error processing channel ${channel.channel_name}:`,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  console.log(
    `[${new Date().toISOString()}] Fetch job complete. Processed ${processedCount} new video(s).`
  );

  await processPendingVideos();
}
