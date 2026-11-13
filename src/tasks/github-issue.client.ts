import { BadGatewayException, ConflictException, HttpException } from '@nestjs/common';

export interface IssueRepository {
  id: string;
  fullName: string;
  htmlUrl: string;
  issuesEnabled: boolean;
  archived: boolean;
}

export interface GitHubIssue {
  number: number;
  url: string;
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  body: string | null;
}

export class GitHubIssueRequestError extends HttpException {
  constructor(
    message: string,
    status: number,
    readonly definitiveRejection: boolean
  ) {
    super(message, status);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const issueNumberValid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

function repositoryPath(repository: IssueRepository) {
  return repository.fullName.split('/').map(encodeURIComponent).join('/');
}

function parseIssue(
  value: unknown,
  repository: IssueRepository,
  expectedNumber?: number
): GitHubIssue {
  if (
    !isRecord(value) ||
    !issueNumberValid(value.number) ||
    (expectedNumber !== undefined && value.number !== expectedNumber) ||
    value.pull_request !== undefined ||
    typeof value.html_url !== 'string' ||
    value.html_url !== `https://github.com/${repository.fullName}/issues/${value.number}` ||
    typeof value.state !== 'string' ||
    !['open', 'closed'].includes(value.state) ||
    (value.body !== null && typeof value.body !== 'string') ||
    (value.state_reason !== undefined &&
      value.state_reason !== null &&
      (typeof value.state_reason !== 'string' ||
        !['completed', 'not_planned', 'reopened'].includes(value.state_reason)))
  ) {
    throw new BadGatewayException('GitHub returned an invalid issue.');
  }
  return {
    number: value.number,
    url: value.html_url,
    state: value.state as GitHubIssue['state'],
    stateReason: (value.state_reason ?? null) as GitHubIssue['stateReason'],
    body: value.body,
  };
}

export class GitHubIssueClient {
  private async request(
    path: string,
    token: string,
    body?: { title: string; body: string },
    deadline?: AbortSignal
  ) {
    const headers = new Headers();
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-GitHub-Api-Version', '2026-03-10');
    if (body) headers.set('Content-Type', 'application/json');
    const timeout = AbortSignal.timeout(10000);
    const signal = deadline ? AbortSignal.any([timeout, deadline]) : timeout;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal,
      });
    } catch {
      throw new GitHubIssueRequestError(
        'GitHub is temporarily unavailable. Try again later.',
        502,
        false
      );
    }
    if (!response.ok) {
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      const messages = new Map<number, string>([
        [400, 'GitHub could not accept this issue request. Review its title and body.'],
        [401, 'Reconnect your GitHub account.'],
        [403, 'GitHub access was denied.'],
        [404, 'The GitHub repository or issue is not accessible.'],
        [410, 'GitHub Issues are unavailable for this repository.'],
        [422, 'GitHub could not accept this issue. Review its title and body.'],
      ]);
      const status = limited
        ? 429
        : [400, 401, 403, 404, 410, 422].includes(response.status)
          ? response.status
          : 502;
      throw new GitHubIssueRequestError(
        limited
          ? 'GitHub rate limit reached. Try again later.'
          : (messages.get(status) ?? 'GitHub request failed. Try again later.'),
        status,
        response.status >= 400 && response.status < 500 && response.status !== 408
      );
    }
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response body');
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        chunks.push(part.value);
      }
      return {
        data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        headers: response.headers,
      };
    } catch {
      throw new GitHubIssueRequestError(
        'GitHub returned an invalid response. Try again later.',
        502,
        false
      );
    }
  }

  async repository(token: string, repositoryId: string): Promise<IssueRepository> {
    if (!/^[1-9][0-9]{0,19}$/.test(repositoryId))
      throw new BadGatewayException('Invalid saved repository ID.');
    const { data } = await this.request(`/repositories/${repositoryId}`, token);
    if (
      !isRecord(data) ||
      !Number.isSafeInteger(data.id) ||
      String(data.id) !== repositoryId ||
      typeof data.full_name !== 'string' ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(data.full_name) ||
      data.full_name.split('/').some((part) => part === '.' || part === '..') ||
      data.html_url !== `https://github.com/${data.full_name}` ||
      typeof data.has_issues !== 'boolean' ||
      typeof data.archived !== 'boolean'
    )
      throw new BadGatewayException('GitHub returned an invalid repository.');
    return {
      id: repositoryId,
      fullName: data.full_name,
      htmlUrl: data.html_url,
      issuesEnabled: data.has_issues,
      archived: data.archived,
    };
  }

  async create(
    token: string,
    repository: IssueRepository,
    draft: { title: string; body: string }
  ): Promise<GitHubIssue> {
    const { data } = await this.request(
      `/repos/${repositoryPath(repository)}/issues`,
      token,
      draft
    );
    return parseIssue(data, repository);
  }

  async get(token: string, repository: IssueRepository, number: number): Promise<GitHubIssue> {
    if (!issueNumberValid(number))
      throw new BadGatewayException('Invalid saved GitHub issue number.');
    const { data } = await this.request(
      `/repos/${repositoryPath(repository)}/issues/${number}`,
      token
    );
    return parseIssue(data, repository, number);
  }

  async findByMarker(
    token: string,
    repository: IssueRepository,
    marker: string
  ): Promise<GitHubIssue | null> {
    const deadline = AbortSignal.timeout(30000);
    for (let page = 1; page <= 10; page++) {
      const { data, headers } = await this.request(
        `/repos/${repositoryPath(repository)}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`,
        token,
        undefined,
        deadline
      );
      if (!Array.isArray(data) || data.length > 100)
        throw new BadGatewayException('GitHub returned invalid issue history.');
      const matches = data.filter(
        (item) =>
          isRecord(item) &&
          item.pull_request === undefined &&
          typeof item.body === 'string' &&
          item.body.split(/\r?\n/).includes(marker)
      );
      if (matches.length > 1)
        throw new ConflictException(
          'Multiple matching issues were found. Link the correct issue number.'
        );
      if (matches.length === 1) return parseIssue(matches[0], repository);
      if (data.length < 100 || !(headers.get('link') ?? '').includes('rel="next"')) return null;
    }
    return null;
  }
}
