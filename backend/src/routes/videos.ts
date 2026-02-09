import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';

const router = Router();

// GET /api/videos - Fetch all summarized videos (public)
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const channelId = req.query.channelId as string | undefined;

    const where = channelId ? { channelId } : {};

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          channel: {
            select: {
              channelName: true,
              channelUrl: true,
            },
          },
        },
      }),
      prisma.video.count({ where }),
    ]);

    res.json({
      videos,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/videos/:id - Fetch single video (public)
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    const video = await prisma.video.findUnique({
      where: { id: id },
      include: {
        channel: {
          select: {
            channelName: true,
            channelUrl: true,
          },
        },
      },
    });

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    res.json(video);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
