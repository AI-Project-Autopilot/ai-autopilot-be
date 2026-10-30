import {
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { githubAuthService, GitHubAuthService } from '../auth/github-auth.service';
import { decrypt } from '../auth/github-security';
import { RepositoryAnalysisResult } from './analysis.types';
import { GitHubSourceClient } from './github-source.client';
import { MetaAnalysisClient } from './meta.client';
import {
  repositoryAnalysisRepository,
  RepositoryAnalysisRepository,
} from './repository-analysis.repository';

export class RepositoryAnalysisService {
  private readonly activeUsers = new Set<string>();

  constructor(
    private readonly auth: GitHubAuthService = githubAuthService,
    private readonly source: GitHubSourceClient = new GitHubSourceClient(),
    private readonly model: MetaAnalysisClient = new MetaAnalysisClient(),
    private readonly repository: RepositoryAnalysisRepository = repositoryAnalysisRepository
  ) {}

  frontendUrl() {
    return this.auth.frontendUrl();
  }

  async analyze(
    sessionToken: string | undefined,
    repositoryId: string,
    goal: string,
    signal?: AbortSignal
  ): Promise<RepositoryAnalysisResult> {
    const session = await this.auth.session(sessionToken);
    const configuration = this.model.configuration();
    if (this.activeUsers.has(session.userId))
      throw new ConflictException('An analysis is already running. Wait for it to finish.');
    this.activeUsers.add(session.userId);
    const budget = AbortSignal.timeout(110000);
    const requestSignal = signal ? AbortSignal.any([budget, signal]) : budget;
    let analysisId: string | undefined;
    try {
      const record = await this.repository.start(
        session.userId,
        repositoryId,
        goal,
        configuration.model
      );
      analysisId = record.id;
      if (requestSignal.aborted)
        throw new GatewayTimeoutException('Repository analysis was interrupted.');
      const snapshot = await this.source.snapshot(
        decrypt(session.githubTokenEncrypted),
        repositoryId,
        requestSignal
      );
      await this.repository.setSnapshot(analysisId, session.userId, snapshot);
      if (requestSignal.aborted)
        throw new GatewayTimeoutException('Repository analysis was interrupted.');
      const analysis = await this.model.analyze(snapshot, goal, requestSignal);
      if (requestSignal.aborted)
        throw new GatewayTimeoutException('Repository analysis was interrupted.');
      const result: RepositoryAnalysisResult = {
        ...analysis,
        analysisId,
        repository: snapshot.repository,
        generatedAt: new Date().toISOString(),
        context: {
          filesRead: snapshot.files.map(({ path, bytes, truncated, lineCount }) => ({
            path,
            bytes,
            truncated,
            lineCount,
          })),
          totalFiles: snapshot.totalFiles,
          skippedFiles: snapshot.skippedFiles,
          treeTruncated: snapshot.treeTruncated,
          warnings: snapshot.warnings,
        },
      };
      // A successful HTTP response always refers to a result committed to the database.
      await this.repository.succeed(analysisId, session.userId, result);
      return result;
    } catch (error) {
      if (analysisId) {
        const cancelled = signal?.aborted === true;
        const errorCode = cancelled
          ? 'CANCELLED'
          : error instanceof HttpException
            ? `HTTP_${error.getStatus()}`
            : 'INTERNAL_ERROR';
        try {
          await this.repository.fail(
            analysisId,
            session.userId,
            cancelled ? 'cancelled' : 'failed',
            errorCode
          );
        } catch {
          // Preserve the original failure and never report an unsaved result as successful.
          console.error('Could not persist analysis failure status.', { analysisId });
        }
      }
      throw error;
    } finally {
      this.activeUsers.delete(session.userId);
    }
  }

  async list(sessionToken: string | undefined, page: number, repositoryId?: string) {
    const session = await this.auth.session(sessionToken);
    return this.repository.list(session.userId, page, repositoryId);
  }

  async get(sessionToken: string | undefined, analysisId: string) {
    const session = await this.auth.session(sessionToken);
    const record = await this.repository.find(session.userId, analysisId);
    if (!record) throw new NotFoundException('Repository analysis not found.');
    return record;
  }
}

export const repositoryAnalysisService = new RepositoryAnalysisService();
