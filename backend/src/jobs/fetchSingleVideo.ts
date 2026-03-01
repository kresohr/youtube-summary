import { randomUUID } from "crypto";
import { query } from "../lib/db.js";
import { extractVideoId } from "./youtubeTranscript.js";
import {
  getTranscriptFromYouTube,
  generateSummaryWithOpenRouter,
  fetchVideoDurations,
} from "./fetchVideos.js";

/** UUID of the sentinel "Standalone" channel row created by init.sql */
export const MANUAL_CHANNEL_ID = "00000000-0000-0000-0000-000000000000";

interface VideoSnippet {
  title: string;
  thumbnails: { high?: { url: string }; default?: { url: string } };
  publishedAt: string;
}

interface SingleVideoJob {
  status: "pending" | "done" | "error";
  video?: SingleVideoResult;
  error?: string;
}

export interface SingleVideoResult {
  id: string;
  videoId: string;
  title: string;
  thumbnail: string;
  summary: string;
  videoUrl: string;
  publishedAt: string;
  fetchedAt: string;
  durationSeconds: number | null;
}

/** In-memory job tracker */
const jobs = new Map<string, SingleVideoJob>();

/** Auto-clean completed/errored jobs after 5 minutes */
function scheduleCleanup(jobId: string): void {
  setTimeout(() => {
    jobs.delete(jobId);
  }, 5 * 60 * 1000);
}

/** Fetch video metadata (title, thumbnail, publishedAt) from YouTube Data API */
async function fetchVideoMetadata(
  videoId: string
): Promise<{ title: string; thumbnail: string; publishedAt: string } | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set");
    return null;
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.items || data.items.length === 0) return null;

    const snippet: VideoSnippet = data.items[0].snippet;
    return {
      title: snippet.title,
      thumbnail:
        snippet.thumbnails.high?.url ??
        snippet.thumbnails.default?.url ??
        "",
      publishedAt: snippet.publishedAt,
    };
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    return null;
  }
}

/** Process a single video: transcript → summary → DB insert */
async function processSingleVideo(
  jobId: string,
  videoUrl: string,
  videoId: string
): Promise<void> {
  try {
    console.log(`[SingleVideo] Starting job ${jobId} for video ${videoId}`);

    // 1. Check for duplicate
    const existing = await query("SELECT id FROM videos WHERE video_id = $1", [
      videoId,
    ]);
    if (existing.rows.length > 0) {
      jobs.set(jobId, {
        status: "error",
        error: "This video has already been summarized.",
      });
      scheduleCleanup(jobId);
      return;
    }

    // 2. Fetch metadata (title, thumbnail, publishedAt)
    const metadata = await fetchVideoMetadata(videoId);
    if (!metadata) {
      jobs.set(jobId, {
        status: "error",
        error: "Could not fetch video metadata from YouTube. Check the URL.",
      });
      scheduleCleanup(jobId);
      return;
    }

    // 3. Fetch duration
    const durationsMap = await fetchVideoDurations([videoId]);
    const durationSeconds = durationsMap.get(videoId) ?? null;

    // 4. Fetch transcript
    const transcript = await getTranscriptFromYouTube(videoId);
    if (!transcript || transcript.length < 100) {
      jobs.set(jobId, {
        status: "error",
        error:
          "Could not fetch transcript for this video. It may not have captions available.",
      });
      scheduleCleanup(jobId);
      return;
    }

    // 5. Generate summary
    const summary = await generateSummaryWithOpenRouter(
      transcript,
      metadata.title
    );

    // 6. Insert into DB
    const result = await query(
      `INSERT INTO videos (id, video_id, title, thumbnail, summary, video_url, published_at, fetched_at, channel_id, duration_seconds)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7, $8)
       RETURNING id, fetched_at`,
      [
        videoId,
        metadata.title,
        metadata.thumbnail,
        summary,
        videoUrl,
        new Date(metadata.publishedAt),
        MANUAL_CHANNEL_ID,
        durationSeconds,
      ]
    );

    const row = result.rows[0];

    const videoResult: SingleVideoResult = {
      id: row.id,
      videoId,
      title: metadata.title,
      thumbnail: metadata.thumbnail,
      summary,
      videoUrl,
      publishedAt: metadata.publishedAt,
      fetchedAt: row.fetched_at,
      durationSeconds,
    };

    jobs.set(jobId, { status: "done", video: videoResult });
    scheduleCleanup(jobId);
    console.log(
      `[SingleVideo] Job ${jobId} completed: "${metadata.title}"`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`[SingleVideo] Job ${jobId} failed:`, message);
    jobs.set(jobId, { status: "error", error: message });
    scheduleCleanup(jobId);
  }
}

/**
 * Start an async single-video fetch job.
 * Returns the job ID immediately; the caller polls getJobStatus() for results.
 */
export function startSingleVideoJob(videoUrl: string): {
  jobId: string;
  error?: string;
} {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return { jobId: "", error: "Invalid YouTube URL" };
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: "pending" });

  // Fire-and-forget — runs in background
  processSingleVideo(jobId, videoUrl, videoId).catch((err) => {
    console.error(`[SingleVideo] Unhandled error in job ${jobId}:`, err);
    jobs.set(jobId, {
      status: "error",
      error: "Unexpected processing error",
    });
    scheduleCleanup(jobId);
  });

  return { jobId };
}

/** Get the current status of a single-video job */
export function getJobStatus(
  jobId: string
): SingleVideoJob | undefined {
  return jobs.get(jobId);
}
