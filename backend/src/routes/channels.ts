import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

// GET /api/channels - Fetch all channels (protected)
router.get('/', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const channels = await prisma.youTubeChannel.findMany({
      orderBy: { addedAt: 'desc' },
      include: {
        _count: {
          select: { videos: true },
        },
      },
    });

    res.json(channels);
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/channels - Add a new channel (protected)
router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { channelId, channelName, channelUrl } = req.body;

    if (!channelId || !channelName) {
      res.status(400).json({ error: 'channelId and channelName are required' });
      return;
    }

    // Check if channel already exists
    const existing = await prisma.youTubeChannel.findUnique({
      where: { channelId },
    });

    if (existing) {
      res.status(409).json({ error: 'Channel already exists' });
      return;
    }

    // Optionally validate channel exists via YouTube API
    if (process.env.YOUTUBE_API_KEY) {
      try {
        const ytResponse = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${process.env.YOUTUBE_API_KEY}`
        );
        const ytData = await ytResponse.json();

        if (!ytData.items || ytData.items.length === 0) {
          res.status(404).json({ error: 'YouTube channel not found' });
          return;
        }
      } catch (ytError) {
        console.warn('YouTube API validation failed, proceeding anyway:', ytError);
      }
    }

    const channel = await prisma.youTubeChannel.create({
      data: {
        channelId,
        channelName,
        channelUrl: channelUrl || `https://www.youtube.com/channel/${channelId}`,
      },
    });

    res.status(201).json(channel);
  } catch (error) {
    console.error('Error adding channel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/channels/:id - Delete a channel (protected)
router.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const channel = await prisma.youTubeChannel.findUnique({
      where: { id },
    });

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    await prisma.youTubeChannel.delete({
      where: { id: id },
    });

    res.json({ message: 'Channel deleted successfully' });
  } catch (error) {
    console.error('Error deleting channel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
