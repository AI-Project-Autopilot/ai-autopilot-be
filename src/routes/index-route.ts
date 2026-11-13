import { Router } from 'express';
import githubAuthRouter from '../auth/github-auth.route';
import repositoryAnalysisRouter from '../analysis/repository-analysis.route';

const router = Router();

router.use('/api', githubAuthRouter);
router.use('/api', repositoryAnalysisRouter);

export default router;
