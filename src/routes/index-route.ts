import { Router } from 'express';
import authRouter from '../auth/auth.route';
import userRouter from '../users/user.route';
import projectRouter from '../projects/project.route';
import githubAuthRouter from '../auth/github-auth.route';
import repositoryAnalysisRouter from '../analysis/repository-analysis.route';

const router = Router();

router.use('/api', githubAuthRouter);
router.use('/api', repositoryAnalysisRouter);
router.use('/auth', authRouter);
router.use('/users', userRouter);
router.use('/projects', projectRouter);

export default router;
