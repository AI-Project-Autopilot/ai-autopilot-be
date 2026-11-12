import express from 'express';
import passport from 'passport';
import {
  createProject,
  getProject,
  updateProject,
  deleteProject,
} from './project.controller';
import { authorization } from '../common/guards/authorization';

const router = express.Router();

router.post('/', passport.authenticate('access-token', { session: false }), createProject);

router.get(
  '/:projectId',
  passport.authenticate('access-token', { session: false }),
  authorization,
  getProject
);

router.patch(
  '/:projectId',
  passport.authenticate('access-token', { session: false }),
  authorization,
  updateProject
);

router.delete(
  '/:projectId',
  passport.authenticate('access-token', { session: false }),
  authorization,
  deleteProject
);

export default router;
