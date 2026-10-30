import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticateOptions, Strategy } from 'passport';
import { githubAuthService, GitHubAuthService, GitHubLoginResult } from '../github-auth.service';
import {
  githubCookieOptions,
  oauthCookieName,
  readGitHubCookie,
  sessionCookieName,
} from '../github-cookies';

export interface GitHubAuthenticateOptions extends AuthenticateOptions {
  action?: 'start' | 'callback';
}

// Passport supplies these actions on a separate strategy instance for each request.
// The callback route consumes the login result itself; it never sets legacy req.user.
export class GitHubStrategy implements Strategy {
  readonly name = 'github';
  success!: (result: GitHubLoginResult) => void;
  redirect!: (url: string) => void;
  error!: (error: Error) => void;

  constructor(private readonly auth: GitHubAuthService = githubAuthService) {}

  authenticate(req: Request, options: GitHubAuthenticateOptions = {}): void {
    void this.authenticateRequest(req, options).catch((error: unknown) => {
      this.error(error instanceof Error ? error : new Error('GitHub authentication failed.'));
    });
  }

  private async authenticateRequest(req: Request, options: GitHubAuthenticateOptions) {
    if (options.action !== 'callback') {
      const result = await this.auth.begin();
      if (!req.res) throw new Error('Missing GitHub authentication response.');
      req.res.cookie(oauthCookieName, result.browserToken, {
        ...githubCookieOptions(),
        maxAge: 10 * 60 * 1000,
      });
      this.redirect(result.url);
      return;
    }

    const { code, state } = req.query;
    const browserToken = readGitHubCookie(req, oauthCookieName);
    if (
      typeof code !== 'string' ||
      !code ||
      code.length > 1024 ||
      typeof state !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !browserToken ||
      !/^[A-Za-z0-9_-]{43}$/.test(browserToken)
    ) {
      throw new BadRequestException('Invalid GitHub callback. Start login again.');
    }
    const result = await this.auth.complete(
      code,
      state,
      browserToken,
      readGitHubCookie(req, sessionCookieName)
    );
    this.success(result);
  }
}

const createGithubStrategy = (auth: GitHubAuthService = githubAuthService) =>
  new GitHubStrategy(auth);

export default createGithubStrategy;
