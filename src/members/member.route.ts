import { Router } from 'express';
import passport from '../auth/strategies/index';
import { getProjectMembers, removeProjectMember } from './member.controller';

const router = Router();

// 프로젝트 멤버 조회
router.get(
  '/projects/:projectId/users',
  passport.authenticate('access-token', { session: false }),
  getProjectMembers
);

// 프로젝트에서 유저 제외하기
router.delete(
  '/projects/:projectId/users/:userId',
  passport.authenticate('access-token', { session: false }),
  removeProjectMember
);

export default router;
