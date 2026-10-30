import { Router } from 'express';
import submissionsRouter from './submissions.js';
import languagesRouter from './languages.js';
import systemRouter from './system.js';
import metricsRouter from './metrics.js';

const router = Router();

// Submissions endpoints (primary)
router.use('/submissions', submissionsRouter);

// Run alias
router.use('/run', submissionsRouter);

// Languages endpoint
router.use('/languages', languagesRouter);

// Metrics endpoint (Prometheus)
router.use('/metrics', metricsRouter);

// System endpoints (statuses, about, workers, etc.)
router.use('/', systemRouter);

export default router;
