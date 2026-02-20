import { query } from "../lib/db.js";
import { transcribeVideo } from "./youtubeTranscript.js";

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

interface ParsedVideo {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  publishedAt: string;
}

/**
 * Fetch latest videos from a YouTube channel published in the last N hours.
 */
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

  return data.items.map((item: YouTubeVideoItem) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnail: item.snippet.thumbnails.high.url,
    publishedAt: item.snippet.publishedAt,
  }));
}

/**
 * Get transcript from YouTube via youtube-transcript-plus.
 */
async function getTranscriptFromYouTube(
  videoId: string
): Promise<string | null> {
  try {
    const videoUrl = `https://youtube.com/watch?v=${videoId}`;
    const transcriptSegments = await transcribeVideo(videoUrl);

    if (!transcriptSegments || transcriptSegments.length === 0) {
      return null;
    }

    return transcriptSegments.map((segment: { text: string }) => segment.text).join(" ");
  } catch (error) {
    console.error(`Error fetching transcript for ${videoId}:`, error);
    return null;
  }
}

/**
 * Generate a summary using OpenRouter API with a free model.
 */
async function generateSummaryWithOpenRouter(
  transcript: string,
  videoTitle: string
): Promise<string> {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY is not set");
      return transcript.substring(0, 300) + "...";
    }

    // Truncate transcript if too long
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
          model: "openrouter/free", // Free Model
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
 * Main function: fetch latest videos from all channels, extract transcripts,
 * generate summaries, and store in database.
 */
export async function fetchAndSummarizeVideos(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Starting video fetch job...`);

  const channelsResult = await query("SELECT * FROM youtube_channels");
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

      // Fetch latest videos from YouTube API (last 24 hours)
      const videos = await fetchLatestVideos(channel.channel_id, 24);

      console.log(`  Found ${videos.length} videos in last 24h`);

      for (const video of videos) {
        // Check if video already exists in DB
        const existsResult = await query(
          "SELECT id FROM videos WHERE video_id = $1",
          [video.id]
        );

        if (existsResult.rows.length > 0) {
          console.log(`  Skipping already processed video: ${video.title}`);
          continue;
        }

        console.log(`  Processing video: ${video.title}`);

        // Get transcript using YouTube's official API
        let transcript = await getTranscriptFromYouTube(video.id);

        // Fallback to description if transcript unavailable
        if (!transcript || transcript.length < 100) {
          console.log(
            `  No transcript for ${video.id}, using title + description`
          );
          transcript = `Description: ${video.description}`;
        }

        // Generate summary using OpenRouter
        const summary = await generateSummaryWithOpenRouter(
          transcript,
          video.title
        );

        // Save to database
        await query(
          `INSERT INTO videos (id, video_id, title, thumbnail, summary, video_url, published_at, fetched_at, channel_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW(), $7)`,
          [
            video.id,
            video.title,
            video.thumbnail,
            summary,
            `https://youtube.com/watch?v=${video.id}`,
            new Date(video.publishedAt),
            channel.id,
          ]
        );

        processedCount++;
        console.log(`  ✓ Saved video: ${video.title}`);
      }
    } catch (error) {
      console.error(`Error processing channel ${channel.channel_name}:`, error instanceof Error ? error.message : "Unknown error");
    }
  }

  console.log(
    `[${new Date().toISOString()}] Job complete. Processed ${processedCount} new videos.`
  );
}
