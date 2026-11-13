import { Router } from 'express';
import githubAuthRouter from '../auth/github-auth.route';
import repositoryAnalysisRouter from '../analysis/repository-analysis.route';
import repositoryTaskRouter from '../tasks/repository-task.route';

const router = Router();

router.use('/api', githubAuthRouter);
router.use('/api', repositoryAnalysisRouter);
router.use('/api', repositoryTaskRouter);

export default router;
