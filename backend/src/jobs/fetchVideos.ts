import { query } from "../lib/db.js";
import { summarizeVideo, GeminiApiError } from "./geminiSummary.js";

/** Maximum duration (in seconds) for a video to be considered a YouTube Short. */
const SHORTS_MAX_DURATION_SECONDS = 60;

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
 * Summarise a single video via the Gemini REST API.
 *
 * Gemini processes the YouTube URL directly using multimodal understanding
 * (audio + video) — no separate transcript extraction is needed.
 *
 * Returns null when Gemini fails with a recoverable/unknown error —
 * caller should enqueue the video to pending_videos for a later retry.
 *
 * Re-throws GeminiApiError for 429 (quota) and 403 (permission denied)
 * so the caller can handle them distinctly.
 */
export async function getVideoSummaryForVideo(
  videoId: string,
  _title: string,
  _description: string | null
): Promise<string | null> {
  const videoUrl = `https://youtube.com/watch?v=${videoId}`;

  try {
    console.log(`[Summary] Gemini summarisation for ${videoId}...`);
    const summary = await summarizeVideo(videoUrl);
    console.log(`[Summary] Succeeded for ${videoId}: ${summary.length} chars`);
    return summary;
  } catch (err) {
    if (err instanceof GeminiApiError && (err.status === 429 || err.status === 403)) {
      throw err; // Let caller handle quota / permission errors
    }
    console.warn(
      `[Summary] Failed for ${videoId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Retry pending videos that previously had no usable content. */
async function processPendingVideos(): Promise<void> {
  // Purge any Shorts that were queued before the filter was in place
  const purged = await query(
    "DELETE FROM pending_videos WHERE duration_seconds IS NOT NULL AND duration_seconds <= $1",
    [SHORTS_MAX_DURATION_SECONDS]
  );
  if (purged.rowCount && purged.rowCount > 0) {
    console.log(`[Pending] Purged ${purged.rowCount} queued Short(s).`);
  }

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

      const summary = await getVideoSummaryForVideo(
        row.video_id,
        row.title,
        row.description
      );

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
      // 429 → bubble up so the cron retry wrapper can sleep & retry
      if (error instanceof GeminiApiError && error.status === 429) {
        throw error;
      }
      // 403 → permanently skip this video
      if (error instanceof GeminiApiError && error.status === 403) {
        console.log(
          `[Pending] Permission denied for "${row.title}" (${row.video_id}) — removing from queue.`
        );
        await query("DELETE FROM pending_videos WHERE video_id = $1", [
          row.video_id,
        ]);
        continue;
      }
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

      const allVideos = await fetchLatestVideos(channel.channel_id, 24);
      console.log(`  Found ${allVideos.length} videos in last 24h`);

      // Filter out YouTube Shorts (≤ 60 s)
      const videos = allVideos.filter((v) => {
        if (v.durationSeconds !== null && v.durationSeconds <= SHORTS_MAX_DURATION_SECONDS) {
          console.log(
            `  [Shorts] Skipping Short: ${v.title} (${v.durationSeconds}s)`
          );
          return false;
        }
        return true;
      });
      if (videos.length < allVideos.length) {
        console.log(
          `  Filtered out ${allVideos.length - videos.length} Short(s), ${videos.length} video(s) remaining`
        );
      }

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

        let summary: string | null;
        try {
          summary = await getVideoSummaryForVideo(
            video.id,
            video.title,
            video.description
          );
        } catch (err) {
          // 429 → bubble up so the cron retry wrapper can sleep & retry
          if (err instanceof GeminiApiError && err.status === 429) {
            throw err;
          }
          // 403 → permanently skip this video, do NOT queue to pending
          if (err instanceof GeminiApiError && err.status === 403) {
            console.log(
              `  [403] Permission denied for "${video.title}" (${video.id}) — skipping permanently.`
            );
            continue;
          }
          throw err; // unexpected — let outer catch handle
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
      // 429 must propagate to the cron retry wrapper
      if (error instanceof GeminiApiError && error.status === 429) {
        throw error;
      }
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
