import { ConflictException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../prisma/prisma.service';
import { RepositoryAnalysisResult, RepositorySnapshot } from './analysis.types';

const perPage = 20;
const metadataSelect = {
  id: true,
  repositoryId: true,
  goal: true,
  status: true,
  fullName: true,
  defaultBranch: true,
  htmlUrl: true,
  commitSha: true,
  isPrivate: true,
  model: true,
  summary: true,
  errorCode: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
} satisfies Prisma.RepositoryAnalysisSelect;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function requireOwner(userId: string) {
  if (typeof userId !== 'string' || !userId) throw new UnauthorizedException('Login required.');
}

function snapshotMetadata(snapshot: RepositorySnapshot) {
  return {
    fullName: snapshot.repository.fullName,
    defaultBranch: snapshot.repository.defaultBranch,
    htmlUrl: snapshot.repository.htmlUrl,
    commitSha: snapshot.repository.commitSha,
    isPrivate: snapshot.repository.isPrivate,
  };
}

function snapshotContext(snapshot: RepositorySnapshot) {
  return {
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
  };
}

export class RepositoryAnalysisRepository {
  constructor(private readonly db: Pick<PrismaClient, 'repositoryAnalysis'> = prisma) {}

  async start(userId: string, repositoryId: string, goal: string, model: string) {
    requireOwner(userId);
    return this.db.repositoryAnalysis.create({
      data: { userId, repositoryId, goal, model, status: 'running' },
      select: { id: true },
    });
  }

  async setSnapshot(id: string, userId: string, snapshot: RepositorySnapshot): Promise<void> {
    requireOwner(userId);
    const updated = await this.db.repositoryAnalysis.updateMany({
      where: { id, userId, status: 'running' },
      data: {
        ...snapshotMetadata(snapshot),
        context: jsonValue(snapshotContext(snapshot)),
      },
    });
    if (updated.count !== 1) throw new ConflictException('Analysis is not available for update.');
  }

  async succeed(id: string, userId: string, result: RepositoryAnalysisResult): Promise<void> {
    requireOwner(userId);
    const updated = await this.db.repositoryAnalysis.updateMany({
      where: { id, userId, status: 'running' },
      data: {
        fullName: result.repository.fullName,
        defaultBranch: result.repository.defaultBranch,
        htmlUrl: result.repository.htmlUrl,
        commitSha: result.repository.commitSha,
        isPrivate: result.repository.isPrivate,
        model: result.model,
        summary: result.summary,
        result: jsonValue(result),
        context: jsonValue(result.context),
        completedAt: new Date(result.generatedAt),
        status: 'succeeded',
        errorCode: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException('Analysis is not available for update.');
  }

  async fail(
    id: string,
    userId: string,
    status: 'failed' | 'cancelled',
    errorCode: string
  ): Promise<void> {
    requireOwner(userId);
    await this.db.repositoryAnalysis.updateMany({
      where: { id, userId, status: 'running' },
      data: { status, errorCode, completedAt: new Date() },
    });
  }

  async list(userId: string, page: number, repositoryId?: string) {
    requireOwner(userId);
    if (!Number.isSafeInteger(page) || page < 1 || page > 999999)
      throw new BadRequestException('page must be a positive integer up to 999999.');
    const rows = await this.db.repositoryAnalysis.findMany({
      where: { userId, ...(repositoryId === undefined ? {} : { repositoryId }) },
      select: metadataSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage + 1,
    });
    return {
      items: rows.slice(0, perPage),
      page,
      perPage,
      hasNextPage: rows.length > perPage,
    };
  }

  async find(userId: string, id: string) {
    requireOwner(userId);
    return this.db.repositoryAnalysis.findFirst({
      where: { id, userId },
      select: { ...metadataSelect, result: true, context: true },
    });
  }
}

export const repositoryAnalysisRepository = new RepositoryAnalysisRepository();
