import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import passport from 'passport';
import { githubAuthService, GitHubAuthService, GitHubLoginResult } from './github-auth.service';
import {
  githubCookieOptions,
  oauthCookieName,
  readGitHubCookie,
  sessionCookieName,
} from './github-cookies';
import { GitHubAuthenticateOptions } from './strategies/github.strategy';

type CallbackError = 'github_login_cancelled' | 'github_auth_failed' | 'github_access_denied';

function isLoginResult(value: unknown): value is GitHubLoginResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<GitHubLoginResult>;
  return (
    typeof result.sessionToken === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(result.sessionToken) &&
    result.expiresAt instanceof Date &&
    Number.isFinite(result.expiresAt.getTime()) &&
    typeof result.frontendUrl === 'string'
  );
}

export class GitHubAuthController {
  constructor(
    private readonly auth: GitHubAuthService = githubAuthService,
    private readonly authenticator: Pick<typeof passport, 'authenticate'> = passport
  ) {}

  login: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const options: GitHubAuthenticateOptions = { session: false, action: 'start' };
    this.authenticator.authenticate('github', options)(req, res, (error?: unknown) => {
      if (error) this.forwardError(error, next);
      else next();
    });
  };

  callback: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.clearCookie(oauthCookieName, githubCookieOptions());
    try {
      if (req.query.error !== undefined) {
        this.redirectFailure(
          res,
          req.query.error === 'access_denied' ? 'github_login_cancelled' : 'github_auth_failed'
        );
        return;
      }
      const options: GitHubAuthenticateOptions = { session: false, action: 'callback' };
      this.authenticator.authenticate('github', options, (error: unknown, result?: unknown) => {
        try {
          if (error || !isLoginResult(result)) {
            this.redirectFailure(
              res,
              error instanceof HttpException && error.getStatus() === 403
                ? 'github_access_denied'
                : 'github_auth_failed'
            );
            return;
          }
          res.cookie(sessionCookieName, result.sessionToken, {
            ...githubCookieOptions(),
            expires: result.expiresAt,
          });
          res.redirect(result.frontendUrl);
        } catch (callbackError) {
          this.forwardError(callbackError, next);
        }
      })(req, res, (error?: unknown) => {
        if (error) this.forwardError(error, next);
        else next();
      });
    } catch (error) {
      this.forwardError(error, next);
    }
  };

  me = this.endpoint(async (req, res) => {
    res.json(await this.auth.me(readGitHubCookie(req, sessionCookieName)));
  });

  logout = this.endpoint(async (req, res) => {
    const allowedOrigin = new URL(this.auth.frontendUrl()).origin;
    if (req.headers.origin !== allowedOrigin)
      throw new ForbiddenException('Invalid request origin.');
    await this.auth.logout(readGitHubCookie(req, sessionCookieName));
    res.clearCookie(sessionCookieName, githubCookieOptions());
    res.status(204).end();
  });

  repositories = this.endpoint(async (req, res) => {
    const page = req.query.page;
    if (page !== undefined && (typeof page !== 'string' || !/^[1-9][0-9]{0,5}$/.test(page)))
      throw new BadRequestException('page must be a positive integer up to 999999.');
    res.json(
      await this.auth.repositories(readGitHubCookie(req, sessionCookieName), Number(page ?? 1))
    );
  });

  private endpoint(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      void handler(req, res).catch((error: unknown) => this.forwardError(error, next));
    };
  }

  private redirectFailure(res: Response, error: CallbackError) {
    const url = new URL(this.auth.frontendUrl());
    url.searchParams.set('error', error);
    res.redirect(url.toString());
  }

  private forwardError(error: unknown, next: NextFunction) {
    next(
      error instanceof HttpException
        ? error
        : new InternalServerErrorException('GitHub authentication is temporarily unavailable.')
    );
  }
}
