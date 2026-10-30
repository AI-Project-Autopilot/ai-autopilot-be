import { Request } from 'express';

export const sessionCookieName = 'autopilot_session';
export const oauthCookieName = 'autopilot_oauth';

export const githubCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api',
});

export const readGitHubCookie = (req: Request, name: string): string | undefined =>
  typeof req.cookies?.[name] === 'string' ? req.cookies[name] : undefined;
