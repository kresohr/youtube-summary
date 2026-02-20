import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { fetchAndSummarizeVideos } from '../jobs/fetchVideos.js';

const router = Router();

// POST /api/admin/trigger-fetch - Manually trigger video fetch (protected)
router.post('/trigger-fetch', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ message: 'Video fetch job triggered. Processing in background.' });

    // Run the job in the background (don't await)
    fetchAndSummarizeVideos().catch((error) => {
      console.error('Manual trigger error:', error instanceof Error ? error.message : 'Unknown error');
    });
  } catch (error) {
    console.error('Error triggering fetch:', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
