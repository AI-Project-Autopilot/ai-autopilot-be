import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { IssueCreationState, Prisma, PrismaClient } from '@prisma/client';
import prisma from '../prisma/prisma.service';
import { GitHubIssue } from './github-issue.client';
import { TaskDraft, TaskUpdate } from './task.types';

function requireOwner(userId: string) {
  if (typeof userId !== 'string' || !userId) throw new UnauthorizedException('Login required.');
}

export class RepositoryTaskRepository {
  constructor(
    private readonly db: Pick<PrismaClient, 'trackedTask' | 'repositoryAnalysis'> = prisma
  ) {}

  async findAnalysis(userId: string, analysisId: string) {
    requireOwner(userId);
    return this.db.repositoryAnalysis.findFirst({
      where: { id: analysisId, userId },
      select: {
        id: true,
        repositoryId: true,
        fullName: true,
        goal: true,
        status: true,
        commitSha: true,
        result: true,
      },
    });
  }

  async select(userId: string, data: TaskDraft) {
    requireOwner(userId);
    return this.db.trackedTask.upsert({
      where: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Prisma generates this compound unique selector.
        userId_analysisId_recommendationId: {
          userId,
          analysisId: data.analysisId,
          recommendationId: data.recommendationId,
        },
      },
      create: {
        ...data,
        userId,
        source: JSON.parse(JSON.stringify(data.source)) as Prisma.InputJsonValue,
      },
      // Re-selecting a recommendation preserves the user's reviewed draft and progress.
      update: {},
    });
  }

  async find(userId: string, id: string) {
    requireOwner(userId);
    return this.db.trackedTask.findFirst({ where: { id, userId } });
  }

  async list(userId: string, page: number, repositoryId?: string, analysisId?: string) {
    requireOwner(userId);
    if (!Number.isSafeInteger(page) || page < 1 || page > 999999)
      throw new BadRequestException('page must be a positive integer up to 999999.');
    const rows = await this.db.trackedTask.findMany({
      where: {
        userId,
        ...(repositoryId ? { repositoryId } : {}),
        ...(analysisId ? { analysisId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 20,
      take: 21,
    });
    return { items: rows.slice(0, 20), page, perPage: 20, hasNextPage: rows.length > 20 };
  }

  async update(userId: string, id: string, patch: TaskUpdate) {
    requireOwner(userId);
    const contentChange = patch.title !== undefined || patch.body !== undefined;
    const changed = await this.db.trackedTask.updateMany({
      where: {
        id,
        userId,
        ...(contentChange ? { issueCreationState: 'none', issueNumber: null } : {}),
      },
      data: patch,
    });
    if (changed.count !== 1)
      throw new ConflictException('The issue draft is locked or unavailable. Reload the task.');
    return this.find(userId, id);
  }

  async claimIssue(userId: string, id: string, updatedAt: Date): Promise<boolean> {
    requireOwner(userId);
    const claimed = await this.db.trackedTask.updateMany({
      where: { id, userId, updatedAt, issueCreationState: 'none', issueNumber: null },
      data: { issueCreationState: 'creating', issueCreationStartedAt: new Date() },
    });
    return claimed.count === 1;
  }

  async releaseIssue(userId: string, id: string, startedAt: Date) {
    requireOwner(userId);
    await this.db.trackedTask.updateMany({
      where: {
        id,
        userId,
        issueCreationState: 'creating',
        issueCreationStartedAt: startedAt,
        issueNumber: null,
      },
      data: { issueCreationState: 'none', issueCreationStartedAt: null },
    });
  }

  async markUncertain(userId: string, id: string, startedAt: Date) {
    requireOwner(userId);
    await this.db.trackedTask.updateMany({
      where: {
        id,
        userId,
        issueCreationState: 'creating',
        issueCreationStartedAt: startedAt,
        issueNumber: null,
      },
      data: { issueCreationState: 'uncertain' },
    });
  }

  async saveIssue(
    userId: string,
    id: string,
    issue: GitHubIssue,
    fullName: string,
    expectedUpdatedAt?: Date,
    expectedCreationState?: IssueCreationState
  ) {
    requireOwner(userId);
    const current = await this.find(userId, id);
    if (!current || (current.issueNumber !== null && current.issueNumber !== issue.number))
      throw new ConflictException(
        'A different issue is already linked or the task is unavailable.'
      );
    const status =
      issue.state === 'closed'
        ? issue.stateReason === 'not_planned'
          ? 'cancelled'
          : 'completed'
        : current.issueState === 'closed'
          ? 'in_progress'
          : undefined;
    if (
      (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) ||
      (expectedCreationState && current.issueCreationState !== expectedCreationState)
    )
      throw new ConflictException(
        'The task changed while checking the issue. Reload it before linking.'
      );
    try {
      const updated = await this.db.trackedTask.updateMany({
        where: {
          id,
          userId,
          updatedAt: expectedUpdatedAt ?? current.updatedAt,
          issueNumber: current.issueNumber,
          issueCreationState: expectedCreationState ?? current.issueCreationState,
        },
        data: {
          fullName,
          issueNumber: issue.number,
          issueUrl: issue.url,
          issueState: issue.state,
          issueStateReason: issue.stateReason,
          issueSyncedAt: new Date(),
          issueCreationState: 'created',
          ...(status ? { status } : {}),
        },
      });
      if (updated.count !== 1)
        throw new ConflictException('The task changed. Reload it before checking the issue again.');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('This issue is already linked to another task.');
      throw error;
    }
    return this.find(userId, id);
  }
}

export const repositoryTaskRepository = new RepositoryTaskRepository();
