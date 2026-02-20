import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { query } from "../lib/db.js";

const router = Router();
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedChannel {
  type: "id" | "handle" | "username";
  value: string;
}

/**
 * Parse a YouTube channel URL or shorthand into a structured token.
 * Supports:
 *   https://youtube.com/channel/UCxxxxxx  → { type: 'id', value: 'UCxxxxxx' }
 *   https://youtube.com/@handle           → { type: 'handle', value: 'handle' }
 *   https://youtube.com/c/name            → { type: 'username', value: 'name' }
 *   https://youtube.com/user/name         → { type: 'username', value: 'name' }
 *   @handle                               → { type: 'handle', value: 'handle' }
 *   UCxxxxxx (bare channel ID)            → { type: 'id', value: 'UCxxxxxx' }
 */
function parseChannelUrl(input: string): ParsedChannel | null {
  const trimmed = input.trim();

  // Bare @handle
  const bareHandle = trimmed.match(/^@([a-zA-Z0-9_.\-]+)$/);
  if (bareHandle) return { type: "handle", value: bareHandle[1] };

  // Bare channel ID (UC...)
  if (/^UC[a-zA-Z0-9_\-]{22}$/.test(trimmed)) {
    return { type: "id", value: trimmed };
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.replace(/^www\./, "");
    if (hostname !== "youtube.com") return null;

    const path = parsed.pathname;

    const channelIdMatch = path.match(/^\/channel\/(UC[a-zA-Z0-9_\-]{22})$/);
    if (channelIdMatch) return { type: "id", value: channelIdMatch[1] };

    const handleMatch = path.match(/^\/@([a-zA-Z0-9_.\-]+)$/);
    if (handleMatch) return { type: "handle", value: handleMatch[1] };

    const customMatch = path.match(/^\/c\/([a-zA-Z0-9_.\-]+)$/);
    if (customMatch) return { type: "username", value: customMatch[1] };

    const userMatch = path.match(/^\/user\/([a-zA-Z0-9_.\-]+)$/);
    if (userMatch) return { type: "username", value: userMatch[1] };

    return null;
  } catch {
    return null;
  }
}

interface ResolvedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string;
}

/**
 * Resolve a parsed YouTube channel token to its actual channel ID via the YouTube Data API.
 * Returns null if the channel cannot be found or the API is unavailable.
 */
async function resolveChannelFromYouTube(
  parsed: ParsedChannel
): Promise<ResolvedChannel | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;

  // Without an API key we can only handle direct channel IDs.
  if (!apiKey) {
    if (parsed.type === "id") {
      return {
        channelId: parsed.value,
        channelName: "",
        channelUrl: `https://www.youtube.com/channel/${parsed.value}`,
      };
    }
    return null;
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("key", apiKey);

  if (parsed.type === "id") {
    url.searchParams.set("id", parsed.value);
  } else if (parsed.type === "handle") {
    url.searchParams.set("forHandle", parsed.value);
  } else {
    url.searchParams.set("forUsername", parsed.value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) return null;

  const data = await response.json();
  if (!data.items || data.items.length === 0) return null;

  const item = data.items[0];
  const channelUrl = item.snippet.customUrl
    ? `https://www.youtube.com/${item.snippet.customUrl}`
    : `https://www.youtube.com/channel/${item.id}`;

  return {
    channelId: item.id as string,
    channelName: item.snippet.title as string,
    channelUrl,
  };
}

// GET /api/channels - Fetch all channels (protected)
router.get(
  "/",
  authMiddleware,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await query(
        `SELECT c.*,
              (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) AS video_count
       FROM youtube_channels c
       ORDER BY c.added_at DESC`
      );

      const channels = result.rows.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelUrl: row.channel_url,
        addedAt: row.added_at,
        _count: { videos: parseInt(row.video_count, 10) },
      }));

      res.json(channels);
    } catch (error) {
      console.error(
        "Error fetching channels:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/channels - Add a new channel (protected)
router.post(
  "/",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { channelUrl, channelName } = req.body;

      if (!channelUrl) {
        res.status(400).json({ error: "channelUrl is required" });
        return;
      }

      if (typeof channelUrl !== "string") {
        res.status(400).json({ error: "Invalid input types" });
        return;
      }

      if (channelUrl.length > 512) {
        res.status(400).json({ error: "channelUrl exceeds maximum length" });
        return;
      }

      if (channelName !== undefined && typeof channelName !== "string") {
        res.status(400).json({ error: "Invalid channelName type" });
        return;
      }

      if (channelName && channelName.length > 255) {
        res.status(400).json({ error: "channelName exceeds maximum length" });
        return;
      }

      // Parse the YouTube URL/shorthand into a typed token.
      const parsed = parseChannelUrl(channelUrl);
      if (!parsed) {
        res.status(400).json({
          error:
            "Invalid YouTube channel URL. Supported formats: https://youtube.com/@handle, " +
            "https://youtube.com/channel/UCxxxxxx, https://youtube.com/c/name, @handle",
        });
        return;
      }

      // Resolve the actual channel ID (and optionally name/url) via YouTube API.
      let resolved: ResolvedChannel | null;
      try {
        resolved = await resolveChannelFromYouTube(parsed);
      } catch (err) {
        console.error("YouTube API resolution error:", err);
        res.status(502).json({ error: "YouTube API request failed" });
        return;
      }

      if (!resolved) {
        if (!process.env.YOUTUBE_API_KEY && parsed.type !== "id") {
          res.status(400).json({
            error:
              "Cannot resolve channel handle without YOUTUBE_API_KEY. " +
              "Use a direct channel URL (https://youtube.com/channel/UCxxxxxx) instead.",
          });
        } else {
          res.status(404).json({ error: "YouTube channel not found" });
        }
        return;
      }

      // Prefer the caller-supplied name; fall back to the one from YouTube API.
      const finalChannelName =
        (channelName && channelName.trim()) || resolved.channelName;

      if (!finalChannelName) {
        res.status(400).json({
          error:
            "channelName is required when YOUTUBE_API_KEY is not configured",
        });
        return;
      }

      // Check if channel already exists
      const existing = await query(
        "SELECT id FROM youtube_channels WHERE channel_id = $1",
        [resolved.channelId]
      );

      if (existing.rows.length > 0) {
        res.status(409).json({ error: "Channel already exists" });
        return;
      }

      const result = await query(
        `INSERT INTO youtube_channels (id, channel_id, channel_name, channel_url, added_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       RETURNING *`,
        [resolved.channelId, finalChannelName, resolved.channelUrl]
      );

      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelUrl: row.channel_url,
        addedAt: row.added_at,
      });
    } catch (error) {
      console.error(
        "Error adding channel:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /api/channels/:id - Delete a channel (protected)
router.delete(
  "/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;

      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: "Invalid channel ID format" });
        return;
      }

      const existing = await query(
        "SELECT id FROM youtube_channels WHERE id = $1",
        [id]
      );

      if (existing.rows.length === 0) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }

      await query("DELETE FROM youtube_channels WHERE id = $1", [id]);

      res.json({ message: "Channel deleted successfully" });
    } catch (error) {
      console.error(
        "Error deleting channel:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
