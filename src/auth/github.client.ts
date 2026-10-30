import {
  BadGatewayException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface GitHubRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  language: string | null;
  updatedAt: string;
  openIssueCount: number;
  archived: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function repository(value: unknown): GitHubRepository {
  if (
    !isRecord(value) ||
    !isPositiveId(value.id) ||
    !isRecord(value.owner) ||
    typeof value.owner.login !== 'string' ||
    !value.owner.login ||
    typeof value.name !== 'string' ||
    !value.name ||
    typeof value.full_name !== 'string' ||
    !value.full_name ||
    (value.description !== null && typeof value.description !== 'string') ||
    typeof value.default_branch !== 'string' ||
    !value.default_branch ||
    typeof value.private !== 'boolean' ||
    typeof value.html_url !== 'string' ||
    (value.language !== null && typeof value.language !== 'string') ||
    typeof value.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(value.updated_at)) ||
    typeof value.open_issues_count !== 'number' ||
    !Number.isSafeInteger(value.open_issues_count) ||
    value.open_issues_count < 0 ||
    typeof value.archived !== 'boolean'
  ) {
    throw new BadGatewayException('Invalid GitHub repositories.');
  }
  let htmlUrl: URL;
  try {
    htmlUrl = new URL(value.html_url);
  } catch {
    throw new BadGatewayException('Invalid GitHub repositories.');
  }
  if (htmlUrl.origin !== 'https://github.com' || htmlUrl.username || htmlUrl.password) {
    throw new BadGatewayException('Invalid GitHub repositories.');
  }
  return {
    id: String(value.id),
    owner: value.owner.login,
    name: value.name,
    fullName: value.full_name,
    description: value.description,
    defaultBranch: value.default_branch,
    isPrivate: value.private,
    htmlUrl: value.html_url,
    language: value.language,
    updatedAt: value.updated_at,
    openIssueCount: value.open_issues_count,
    archived: value.archived,
  };
}

function hasNextLink(link: string | null): boolean {
  if (!link) return false;
  const links = /<[^>]+>\s*([^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = links.exec(link)) !== null) {
    const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(match[1]);
    if (relation && (relation[1] ?? relation[2]).split(/\s+/).includes('next')) return true;
  }
  return false;
}

export class GitHubClient {
  private async request(
    url: string,
    init: RequestInit
  ): Promise<{ data: unknown; headers: Headers }> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new BadGatewayException('GitHub is temporarily unavailable.');
    }
    if (response.status === 401) throw new UnauthorizedException('Reconnect your GitHub account.');
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    ) {
      throw new HttpException('GitHub rate limit reached. Try again later.', 429);
    }
    if (response.status === 403) throw new ForbiddenException('GitHub access was denied.');
    if (!response.ok) throw new BadGatewayException('GitHub request failed.');
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new BadGatewayException('Invalid GitHub response.');
    }
    return { data, headers: response.headers };
  }

  async exchange(
    code: string,
    verifier: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ) {
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    const body: Record<string, string> = {};
    body['client_id'] = clientId;
    body['client_secret'] = clientSecret;
    body.code = code;
    body['code_verifier'] = verifier;
    body['redirect_uri'] = redirectUri;
    const { data } = await this.request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!isRecord(data)) throw new BadGatewayException('Invalid GitHub response.');
    if (typeof data.error === 'string' && data.error) {
      throw new UnauthorizedException('GitHub authorization failed. Start login again.');
    }
    if (
      data.error !== undefined ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.token_type !== 'string' ||
      data.token_type.toLowerCase() !== 'bearer'
    ) {
      throw new BadGatewayException('Invalid GitHub token response.');
    }
    if (
      data.expires_in !== undefined &&
      (typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0)
    ) {
      throw new BadGatewayException('Invalid GitHub token expiration.');
    }
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in as number | undefined,
    };
  }

  private get(path: string, token: string) {
    const headers = new Headers();
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-GitHub-Api-Version', '2026-03-10');
    return this.request(`https://api.github.com${path}`, {
      headers,
    });
  }

  async profile(token: string): Promise<GitHubProfile> {
    const { data } = await this.get('/user', token);
    if (
      !isRecord(data) ||
      !isPositiveId(data.id) ||
      typeof data.login !== 'string' ||
      !data.login ||
      (data.name !== null && typeof data.name !== 'string') ||
      typeof data.avatar_url !== 'string'
    ) {
      throw new BadGatewayException('Invalid GitHub profile.');
    }
    return {
      id: data.id,
      login: data.login,
      name: data.name,
      avatarUrl: data.avatar_url,
    };
  }

  async repositories(token: string, page: number) {
    const query = new URLSearchParams();
    query.set('per_page', '30');
    query.set('page', String(page));
    query.set('sort', 'updated');
    query.set('direction', 'desc');
    query.set('affiliation', 'owner,collaborator,organization_member');
    query.set('visibility', 'all');
    const { data, headers } = await this.get(`/user/repos?${query.toString()}`, token);
    if (!Array.isArray(data)) throw new BadGatewayException('Invalid GitHub repositories.');
    return {
      items: data.map(repository),
      hasNextPage: hasNextLink(headers.get('link')),
      privateRepositoriesIncluded: (headers.get('x-oauth-scopes') ?? '')
        .split(/[,\s]+/)
        .includes('repo'),
    };
  }
}
