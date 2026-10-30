import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RepositorySnapshot, RepositorySourceFile } from './analysis.types';

const maxFiles = 16;
const maxBlobAttempts = 32;
const maxBlobBytes = 64 * 1024;
const maxFileBytes = 12 * 1024;
const maxContextBytes = 120 * 1024;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

interface SourceEntry {
  path: string;
  sha: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSha = (value: unknown): value is string =>
  typeof value === 'string' && shaPattern.test(value);
const invalidResponse = () => new BadGatewayException('Invalid GitHub source response.');
const cancelled = () => new HttpException('Repository analysis timed out or was cancelled.', 504);

function hasControl(value: string, allowTextWhitespace = false): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && (!allowTextWhitespace || ![9, 10, 12, 13].includes(code)));
  });
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes('\\') &&
    !hasControl(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

function excluded(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  const name = parts[parts.length - 1];
  return (
    parts.some((part) =>
      /^(?:node_modules|vendor|dist|build|coverage|target|generated|__generated__|certs|certificates|\.git|\.next|\.nuxt|\.venv|venv|\.aws|\.ssh|\.terraform|\.cache)$/.test(
        part
      )
    ) ||
    parts.some((part) => /^\.env/.test(part)) ||
    parts.some((part) => /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/.test(part)) ||
    /(?:service[-_]?account|firebase.*adminsdk)/.test(name) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:[._-]|$)/.test(name) ||
    /^(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials)$/.test(name) ||
    /\.(?:pem|key|p12|pfx|crt|cer|jks|keystore|lock|lockb)$/.test(name) ||
    /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|packages\.lock\.json|go\.sum)$/.test(
      name
    ) ||
    (parts.includes('.docker') && name === 'config.json') ||
    /(?:\.min\.[cm]?js|\.map|\.generated\.[^.]+|\.g\.(?:ts|cs))$/.test(name)
  );
}

function textPath(path: string): boolean {
  const name = path.split('/').pop()!.toLowerCase();
  return (
    /\.(?:[cm]?js|jsx|tsx?|py|go|java|kts?|rs|rb|php|swift|cs|cpp|cc|c|h|hpp|vue|svelte|html?|css|scss|sass|sql|graphql|gql|prisma|json|ya?ml|toml|ini|cfg|properties|xml|mdx?|txt|sh|bash|zsh)$/.test(
      name
    ) ||
    /^(?:dockerfile(?:\..+)?|makefile|procfile|gemfile|rakefile|readme|\.gitignore|\.eslintrc|\.prettierrc)$/.test(
      name
    )
  );
}

function category(path: string): number {
  const lower = path.toLowerCase();
  const name = lower.split('/').pop()!;
  if (/^readme(?:\.|$)/.test(name)) return 0;
  if (
    /^(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|gemfile|.*\.csproj)$/.test(
      name
    )
  )
    return 1;
  if (/^(?:main|index|app|server|application)\.[^.]+$/.test(name)) return 2;
  if (/(?:^|\/)(?:auth|authentication|security)(?:\/|[._-])/.test(lower)) return 3;
  if (
    /(?:config|schema|dockerfile|makefile|eslint|prettier|tsconfig|vite|webpack)/.test(name) ||
    lower.startsWith('.github/workflows/')
  )
    return 4;
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(lower)) return 5;
  if (
    /\.(?:[cm]?js|jsx|tsx?|py|go|java|kts?|rs|rb|php|swift|cs|cpp|cc|c|h|hpp|vue|svelte)$/.test(
      name
    )
  )
    return 6;
  if (/\.(?:mdx?|txt)$/.test(name)) return 7;
  return 8;
}

function prioritize(entries: SourceEntry[]): SourceEntry[] {
  const buckets: SourceEntry[][] = Array.from({ length: 9 }, () => []);
  for (const entry of entries) buckets[category(entry.path)].push(entry);
  for (const bucket of buckets)
    bucket.sort(
      (a, b) =>
        a.path.split('/').length - b.path.split('/').length ||
        a.path.length - b.path.length ||
        a.path.localeCompare(b.path)
    );
  const ordered: SourceEntry[] = [];
  // Round-robin gives manifests, entry points, auth code and tests a chance in large repos.
  for (let index = 0; ordered.length < maxBlobAttempts; index++) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[index]) {
        ordered.push(bucket[index]);
        added = true;
        if (ordered.length === maxBlobAttempts) break;
      }
    }
    if (!added) break;
  }
  return ordered;
}

function redact(content: string): string {
  const conceal = (value: string) => value.replace(/[^\r\n]+/g, '[REDACTED]');
  return content
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      conceal
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, conceal)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,255}|AIza[A-Za-z0-9_-]{30,}|[A]KIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,}|EAA[A-Za-z0-9]{40,})\b/g,
      conceal
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, conceal)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, conceal)
    .replace(
      /(["']?[\w.-]{0,100}(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w.-]{0,100}["']?\s*[:=]\s*)(["'`])([^\r\n]*?)\2/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`
    )
    .replace(
      /(["']?[\w.-]{0,100}(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w.-]{0,100}["']?\s*:\s*)(?!["'`\s])([^\s#,}\r\n]+)/gi,
      (_match, prefix: string) => `${prefix}[REDACTED]`
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
}

function limitText(content: string, byteLimit: number): string {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= byteLimit) return content;
  let end = byteLimit;
  const lastNewline = bytes.lastIndexOf(10, end - 1);
  if (lastNewline >= 0) end = lastNewline + 1;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return '';
}

export class GitHubSourceClient {
  async snapshot(
    token: string,
    repositoryId: string,
    signal?: AbortSignal
  ): Promise<RepositorySnapshot> {
    if (!/^[1-9][0-9]{0,15}$/.test(repositoryId) || !Number.isSafeInteger(Number(repositoryId)))
      throw new BadRequestException('repositoryId must be a positive integer.');
    const metadata = await this.request(`/repositories/${repositoryId}`, token, 256 * 1024, signal);
    if (
      !isRecord(metadata) ||
      metadata.id !== Number(repositoryId) ||
      typeof metadata.full_name !== 'string' ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(metadata.full_name) ||
      metadata.full_name.split('/').some((part) => part === '.' || part === '..') ||
      typeof metadata.private !== 'boolean'
    )
      throw invalidResponse();
    if (metadata.default_branch === null || metadata.default_branch === '')
      throw new UnprocessableEntityException('Repository has no readable default branch yet.');
    if (
      typeof metadata.default_branch !== 'string' ||
      metadata.default_branch.length > 1024 ||
      hasControl(metadata.default_branch)
    )
      throw invalidResponse();
    const fullName = metadata.full_name;
    const repoPath = fullName.split('/').map(encodeURIComponent).join('/');
    const ref = encodeURIComponent(`heads/${metadata.default_branch}`);
    const commit = await this.request(
      `/repos/${repoPath}/commits/${ref}?per_page=1`,
      token,
      2 * 1024 * 1024,
      signal
    );
    if (
      !isRecord(commit) ||
      !isSha(commit.sha) ||
      !isRecord(commit.commit) ||
      !isRecord(commit.commit.tree) ||
      !isSha(commit.commit.tree.sha)
    )
      throw invalidResponse();
    const treeSha = commit.commit.tree.sha;
    const tree = await this.request(
      `/repos/${repoPath}/git/trees/${treeSha}?recursive=1`,
      token,
      8 * 1024 * 1024,
      signal
    );
    if (
      !isRecord(tree) ||
      tree.sha !== treeSha ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > 100000 ||
      typeof tree.truncated !== 'boolean'
    )
      throw invalidResponse();
    const entries = tree.tree.map((value): SourceEntry => {
      if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        !isSha(value.sha) ||
        !['blob', 'tree', 'commit'].includes(String(value.type)) ||
        typeof value.mode !== 'string' ||
        !['100644', '100755', '120000', '040000', '160000'].includes(value.mode) ||
        (value.type === 'blob' &&
          (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0))
      )
        throw invalidResponse();
      return value as unknown as SourceEntry;
    });
    const blobs = entries.filter((entry) => entry.type === 'blob');
    const candidates = blobs.filter(
      (entry) =>
        ['100644', '100755'].includes(entry.mode) &&
        safePath(entry.path) &&
        !excluded(entry.path) &&
        textPath(entry.path) &&
        entry.size! <= maxBlobBytes
    );
    const warnings = new Set<string>();
    if (tree.truncated)
      warnings.add(
        'GitHub returned an incomplete file tree; file totals cover returned entries only.'
      );
    if (blobs.some((entry) => entry.size! > maxBlobBytes))
      warnings.add('Files larger than 64 KiB were excluded from the source sample.');
    const files: RepositorySourceFile[] = [];
    let totalBytes = 0;
    for (const entry of prioritize(candidates)) {
      if (files.length >= maxFiles || totalBytes >= maxContextBytes) break;
      const content = await this.blob(repoPath, entry, token, signal);
      if (content === null || !content.trim()) continue;
      const sanitized = redact(content);
      if (sanitized !== content)
        warnings.add('Potential credentials in sampled files were redacted.');
      const limited = limitText(sanitized, Math.min(maxFileBytes, maxContextBytes - totalBytes));
      if (!limited) continue;
      const truncated = limited !== sanitized;
      if (truncated)
        warnings.add('Some sampled file contents were truncated to fit analysis limits.');
      const bytes = Buffer.byteLength(limited, 'utf8');
      totalBytes += bytes;
      files.push({
        path: entry.path,
        content: limited,
        bytes,
        truncated,
        lineCount: limited.split('\n').length,
      });
    }
    if (!files.length)
      throw new UnprocessableEntityException('Repository has no supported readable source files.');
    if (files.length < blobs.length || tree.truncated)
      warnings.add('Analysis uses a bounded text-file sample; omitted files were not inspected.');
    return {
      repository: {
        id: repositoryId,
        fullName,
        defaultBranch: metadata.default_branch,
        htmlUrl: `https://github.com/${repoPath}`,
        isPrivate: metadata.private,
        commitSha: commit.sha,
      },
      files,
      totalFiles: blobs.length,
      skippedFiles: blobs.length - files.length,
      treeTruncated: tree.truncated,
      warnings: [...warnings],
    };
  }

  private async blob(
    repoPath: string,
    entry: SourceEntry,
    token: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const data = await this.request(
      `/repos/${repoPath}/git/blobs/${entry.sha}`,
      token,
      100 * 1024,
      signal
    );
    if (
      !isRecord(data) ||
      data.sha !== entry.sha ||
      data.encoding !== 'base64' ||
      data.size !== entry.size ||
      typeof data.content !== 'string'
    )
      throw invalidResponse();
    const base64 = data.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      throw invalidResponse();
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== entry.size || bytes.length > maxBlobBytes) throw invalidResponse();
    const sha = createHash(entry.sha.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (sha !== entry.sha) throw invalidResponse();
    if (bytes.includes(0)) return null;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return hasControl(text, true) ? null : text;
    } catch {
      return null;
    }
  }

  private async request(
    path: string,
    token: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const requestSignal = AbortSignal.any(
      signal ? [signal, AbortSignal.timeout(10000)] : [AbortSignal.timeout(10000)]
    );
    if (requestSignal.aborted) throw cancelled();
    const headers = new Headers();
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-GitHub-Api-Version', '2026-03-10');
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method: 'GET',
        headers,
        signal: requestSignal,
        redirect: 'error',
      });
    } catch {
      if (requestSignal.aborted) throw cancelled();
      throw new BadGatewayException('GitHub source is temporarily unavailable.');
    }
    if (response.status === 401) throw new UnauthorizedException('Reconnect your GitHub account.');
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    )
      throw new HttpException('GitHub rate limit reached. Try again later.', 429);
    if (response.status === 403)
      throw new ForbiddenException('GitHub repository access was denied.');
    if (response.status === 404)
      throw new NotFoundException('Repository source was not found or is not accessible.');
    if (response.status === 409 || response.status === 422)
      throw new UnprocessableEntityException(
        'Repository has no readable source at this reference.'
      );
    if (!response.ok) throw new BadGatewayException('GitHub source request failed.');
    const length = response.headers.get('content-length');
    if (length && Number(length) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw invalidResponse();
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw invalidResponse();
        }
        chunks.push(value);
      }
      if (requestSignal.aborted) throw cancelled();
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (requestSignal.aborted) throw cancelled();
      if (error instanceof HttpException) throw error;
      throw invalidResponse();
    } finally {
      reader.releaseLock();
    }
  }
}
