import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { fetchAndSummarizeVideos } from '../jobs/fetchVideos.js';

const router = Router();

// POST /api/admin/trigger-fetch - Manually trigger video fetch for 'main' channels (protected)
router.post('/trigger-fetch', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ message: 'Video fetch job triggered for main channels. Processing in background.' });

    // Run the job in the background (don't await) — only 'main' channels
    fetchAndSummarizeVideos('main').catch((error) => {
      console.error('Manual trigger error:', error instanceof Error ? error.message : 'Unknown error');
    });
  } catch (error) {
    console.error('Error triggering fetch:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/fetch-category - Manually trigger video fetch for a specific non-main category (protected)
router.post('/fetch-category', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { category } = req.body;

    if (typeof category !== 'string') {
      res.status(400).json({ error: 'category is required' });
      return;
    }

    const normalizedCategory = category.trim().toLowerCase();

    if (!normalizedCategory) {
      res.status(400).json({ error: 'category is required' });
      return;
    }

    if (normalizedCategory.length > 50) {
      res.status(400).json({ error: 'category exceeds maximum length' });
      return;
    }

    if (normalizedCategory === 'main') {
      res.status(400).json({ error: 'Use /trigger-fetch to fetch main channels' });
      return;
    }

    res.json({ message: `Video fetch job triggered for "${normalizedCategory}" channels. Processing in background.` });

    // Run the job in the background (don't await)
    fetchAndSummarizeVideos(normalizedCategory).catch((error) => {
      console.error(`Fetch-category trigger error (${normalizedCategory}):`, error instanceof Error ? error.message : 'Unknown error');
    });
  } catch (error) {
    console.error('Error triggering category fetch:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
