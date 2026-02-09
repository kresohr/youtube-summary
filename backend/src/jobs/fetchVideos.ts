import { query } from "../lib/db.js";

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

interface TranscriptSegment {
  text: string;
  offset?: number;
  duration?: number;
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

  const url =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&channelId=${channelId}&type=video&order=date&` +
    `publishedAfter=${publishedAfter}&maxResults=10&` +
    `key=${apiKey}`;

  const response = await fetch(url);

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
 * Get transcript from TubeText (free, no API key needed).
 */
async function getTranscriptFromTubeText(
  videoId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://tubetext.app/api/transcript?videoId=${videoId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(`TubeText API error for ${videoId}: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // TubeText returns transcript in segments
    if (data.transcript && Array.isArray(data.transcript)) {
      const fullTranscript = data.transcript
        .map((segment: TranscriptSegment) => segment.text)
        .join(" ");
      return fullTranscript;
    }

    return null;
  } catch (error) {
    console.error(
      `Error fetching transcript from TubeText for ${videoId}:`,
      error
    );
    return null;
  }
}

/**
 * Generate a summary using OpenRouter API.
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
          model: "anthropic/claude-3.5-sonnet",
          messages: [
            {
              role: "system",
              content:
                "You are a helpful assistant that creates concise summaries of YouTube videos. Summarize the main points in 3-4 sentences.",
            },
            {
              role: "user",
              content: `Summarize this YouTube video:\n\nTitle: ${videoTitle}\n\nTranscript:\n${truncatedTranscript}`,
            },
          ],
          max_tokens: 200,
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

        // Get transcript using TubeText
        let transcript = await getTranscriptFromTubeText(video.id);

        // Fallback to description if transcript unavailable
        if (!transcript || transcript.length < 100) {
          console.log(
            `  No transcript for ${video.id}, using title + description`
          );
          transcript = `Title: ${video.title}\n\nDescription: ${video.description}`;
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
      console.error(`Error processing channel ${channel.channel_name}:`, error);
    }
  }

  console.log(
    `[${new Date().toISOString()}] Job complete. Processed ${processedCount} new videos.`
  );
}
