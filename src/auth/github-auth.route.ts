import { Router } from 'express';
import passport from './strategies/index';
import { GitHubAuthController } from './github-auth.controller';
import { githubAuthService, GitHubAuthService } from './github-auth.service';

export function createGitHubAuthRouter(
  auth: GitHubAuthService = githubAuthService,
  authenticator: Pick<typeof passport, 'authenticate'> = passport
) {
  const router = Router();
  const controller = new GitHubAuthController(auth, authenticator);
  router.get('/auth/github', controller.login);
  router.get('/auth/github/callback', controller.callback);
  router.get('/auth/me', controller.me);
  router.post('/auth/logout', controller.logout);
  router.get('/github/repositories', controller.repositories);
  return router;
}

export default createGitHubAuthRouter();
