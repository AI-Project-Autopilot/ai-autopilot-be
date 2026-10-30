import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import prisma from '../prisma/prisma.service';
import { GitHubClient } from './github.client';
import {
  challenge,
  decrypt,
  encrypt,
  encryptionKey,
  hashToken,
  randomToken,
} from './github-security';

export type GitHubLoginResult = {
  sessionToken: string;
  expiresAt: Date;
  frontendUrl: string;
};

function validateUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new ServiceUnavailableException('Invalid GitHub login URL configuration.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
  ) {
    throw new ServiceUnavailableException('Invalid GitHub login URL configuration.');
  }
  return value as string;
}

export class GitHubAuthService {
  constructor(private readonly github: GitHubClient) {}

  frontendUrl() {
    return validateUrl(process.env.AUTOPILOT_FRONTEND_URL ?? process.env.FRONTEND_URL);
  }

  configuration() {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    const redirectUri = process.env.GITHUB_CALLBACK_URL ?? process.env.GITHUB_REDIRECT_URI;
    const frontendUrlValue = process.env.AUTOPILOT_FRONTEND_URL ?? process.env.FRONTEND_URL;
    const encryptionKeyValue = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
    const missing = [
      !clientId && 'GITHUB_CLIENT_ID',
      !clientSecret && 'GITHUB_CLIENT_SECRET',
      !redirectUri && 'GITHUB_CALLBACK_URL (or GITHUB_REDIRECT_URI)',
      !frontendUrlValue && 'AUTOPILOT_FRONTEND_URL (or FRONTEND_URL)',
      !encryptionKeyValue && 'GITHUB_TOKEN_ENCRYPTION_KEY',
    ].filter((name): name is string => Boolean(name));
    if (!clientId || !clientSecret || !redirectUri || !frontendUrlValue || !encryptionKeyValue) {
      throw new ServiceUnavailableException(
        `GitHub login is not configured: missing ${missing.join(', ')}.`
      );
    }
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKeyValue)) {
      throw new ServiceUnavailableException(
        'GitHub login is not configured: GITHUB_TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.'
      );
    }
    const frontendUrl = this.frontendUrl();
    validateUrl(redirectUri);
    encryptionKey();
    return { clientId, clientSecret, redirectUri, frontendUrl };
  }

  async begin() {
    const config = this.configuration();
    const state = randomToken();
    const browserToken = randomToken();
    const verifier = randomToken();
    await prisma.autopilotOAuthState.create({
      data: {
        stateHash: hashToken(state),
        browserHash: hashToken(browserToken),
        verifierEncrypted: encrypt(verifier),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    const query = new URLSearchParams();
    query.set('client_id', config.clientId);
    query.set('redirect_uri', config.redirectUri);
    query.set('state', state);
    query.set('scope', 'repo');
    query.set('code_challenge', challenge(verifier));
    query.set('code_challenge_method', 'S256');
    url.search = query.toString();
    return { url: url.toString(), browserToken };
  }

  async complete(
    code: string,
    state: string,
    browserToken: string,
    previousSession?: string
  ): Promise<GitHubLoginResult> {
    const config = this.configuration();
    const stateHash = hashToken(state);
    const record = await prisma.autopilotOAuthState.findUnique({ where: { stateHash } });
    if (
      !record ||
      record.browserHash !== hashToken(browserToken) ||
      record.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Invalid or expired login state. Start login again.');
    }
    const consumed = await prisma.autopilotOAuthState.deleteMany({
      where: { stateHash, browserHash: hashToken(browserToken), expiresAt: { gt: new Date() } },
    });
    if (consumed.count !== 1) throw new UnauthorizedException('Login state was already used.');
    const token = await this.github.exchange(
      code,
      decrypt(record.verifierEncrypted),
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
    const profile = await this.github.profile(token.accessToken);
    const sessionToken = randomToken();
    const expiresAt = new Date(Date.now() + Math.min(token.expiresIn ?? 28800, 28800) * 1000);
    await prisma.$transaction(async (tx) => {
      const user = await tx.autopilotUser.upsert({
        where: { githubId: String(profile.id) },
        create: {
          githubId: String(profile.id),
          login: profile.login,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
        update: { login: profile.login, name: profile.name, avatarUrl: profile.avatarUrl },
      });
      if (previousSession)
        await tx.autopilotSession.deleteMany({ where: { tokenHash: hashToken(previousSession) } });
      await tx.autopilotSession.create({
        data: {
          tokenHash: hashToken(sessionToken),
          userId: user.id,
          githubTokenEncrypted: encrypt(token.accessToken),
          expiresAt,
        },
      });
    });
    return { sessionToken, expiresAt, frontendUrl: config.frontendUrl };
  }

  async session(token?: string) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Login required.');
    const session = await prisma.autopilotSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt <= new Date())
      throw new UnauthorizedException('Session expired. Log in again.');
    return session;
  }

  async me(token?: string) {
    const { user, expiresAt } = await this.session(token);
    return {
      user: {
        id: user.id,
        githubId: user.githubId,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      expiresAt,
    };
  }

  async logout(token?: string) {
    if (token) await prisma.autopilotSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  async repositories(token: string | undefined, page: number) {
    const session = await this.session(token);
    const data = await this.github.repositories(decrypt(session.githubTokenEncrypted), page);
    return {
      items: data.items,
      page,
      perPage: 30,
      hasNextPage: data.hasNextPage,
      privateRepositoriesIncluded: data.privateRepositoriesIncluded,
    };
  }
}

export const githubAuthService = new GitHubAuthService(new GitHubClient());
