import { Router } from 'express';
import passport from '../auth/strategies/index';
import {
  acceptInvitation,
  deleteInvitation,
  getMyInvitations,
  inviteMember,
  rejectInvitation,
} from './invitation.controller';

const router = Router();

router.post(
  '/projects/:projectId/invitations',
  passport.authenticate('access-token', { session: false }),
  inviteMember
);
router.post(
  '/invitations/:invitationId/accept',
  passport.authenticate('access-token', { session: false }),
  acceptInvitation
);
router.delete(
  '/invitations/:invitationId',
  passport.authenticate('access-token', { session: false }),
  deleteInvitation
);
router.get(
  '/invitations/me',
  passport.authenticate('access-token', { session: false }),
  getMyInvitations
);
router.delete(
  '/invitations/:invitationId/reject',
  passport.authenticate('access-token', { session: false }),
  rejectInvitation
);

export default router;
