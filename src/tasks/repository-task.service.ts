import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { TrackedTask } from '@prisma/client';
import { githubAuthService, GitHubAuthService } from '../auth/github-auth.service';
import { decrypt } from '../auth/github-security';
import { RecommendedDevelopmentTask } from '../analysis/analysis.types';
import { GitHubIssueClient, GitHubIssueRequestError, IssueRepository } from './github-issue.client';
import { RepositoryTaskRepository, repositoryTaskRepository } from './repository-task.repository';
import { taskDto, TaskUpdate } from './task.types';
import { taskUpdate } from './task.validation';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recommendation(value: unknown): value is RecommendedDevelopmentTask {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    !!value.title.trim() &&
    value.title.length <= 200 &&
    ['high', 'medium', 'low'].includes(String(value.priority)) &&
    typeof value.rationale === 'string' &&
    Array.isArray(value.implementationSteps) &&
    value.implementationSteps.every((item) => typeof item === 'string') &&
    Array.isArray(value.acceptanceCriteria) &&
    value.acceptanceCriteria.every((item) => typeof item === 'string') &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === 'string' &&
        typeof item.url === 'string' &&
        Number.isSafeInteger(item.startLine) &&
        Number.isSafeInteger(item.endLine)
    )
  );
}

function clip(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function issueBody(
  task: RecommendedDevelopmentTask,
  goal: string,
  language: 'ko' | 'en',
  fullName: string,
  commitSha: string
) {
  const t = (ko: string, en: string) => (language === 'en' ? en : ko);
  const build = (stepLength: number) =>
    [
      `## ${t('개발 목표', 'Development goal')}`,
      clip(goal, 1500) || t('저장소 전반의 개선', 'Improve the repository'),
      `\n## ${t('제안 이유', 'Rationale')}`,
      clip(task.rationale, 1800),
      `\n## ${t('구현 단계', 'Implementation steps')}`,
      ...task.implementationSteps.map((step) => `- [ ] ${clip(step, stepLength)}`),
      `\n## ${t('완료 기준', 'Acceptance criteria')}`,
      ...task.acceptanceCriteria.map((criterion) => `- [ ] ${clip(criterion, stepLength)}`),
      `\n## ${t('코드 근거', 'Code evidence')}`,
      ...task.evidence.map(
        (item) =>
          `- [${clip(item.path, 150).replace(/[[\]\\]/g, '\\$&')}:${item.startLine}–${item.endLine}](${item.url})`
      ),
      `\n---\n${t('분석 기준 커밋', 'Analyzed commit')}: [${commitSha.slice(0, 7)}](https://github.com/${fullName}/commit/${commitSha})`,
      t(
        'AI 추천을 검토하여 작성한 작업입니다.',
        'This task was drafted from an AI recommendation for human review.'
      ),
    ].join('\n');
  const body = build(600);
  // Keep the editable default concise; the complete original remains in source.
  const bounded = body.length <= 30000 ? body : build(100);
  if (bounded.length > 30000)
    throw new ConflictException('The saved recommendation is too large to create a task draft.');
  return bounded;
}

export class RepositoryTaskService {
  constructor(
    private readonly auth: GitHubAuthService = githubAuthService,
    private readonly repository: RepositoryTaskRepository = repositoryTaskRepository,
    private readonly github: GitHubIssueClient = new GitHubIssueClient()
  ) {}

  frontendUrl() {
    return this.auth.frontendUrl();
  }

  private async requireTask(userId: string, id: string): Promise<TrackedTask> {
    const task = await this.repository.find(userId, id);
    if (!task) throw new NotFoundException('Task not found.');
    return task;
  }

  async select(sessionToken: string | undefined, analysisId: string, recommendationId: string) {
    const session = await this.auth.session(sessionToken);
    const analysis = await this.repository.findAnalysis(session.userId, analysisId);
    if (!analysis) throw new NotFoundException('Repository analysis not found.');
    if (analysis.status !== 'succeeded')
      throw new ConflictException('Select a recommendation from a successful saved analysis.');
    const result = analysis.result;
    if (!isRecord(result) || !Array.isArray(result.recommendations))
      throw new ConflictException('The saved analysis has no usable recommendations.');
    const original = result.recommendations.find(
      (item) => isRecord(item) && item.id === recommendationId
    );
    if (!original) throw new NotFoundException('Recommendation not found.');
    if (!recommendation(original))
      throw new ConflictException('The saved recommendation is invalid.');
    const sourceRepository = isRecord(result.repository) ? result.repository : {};
    const fullName = analysis.fullName ?? sourceRepository.fullName;
    const commitSha = analysis.commitSha ?? sourceRepository.commitSha;
    if (
      typeof fullName !== 'string' ||
      typeof commitSha !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(commitSha)
    )
      throw new ConflictException('The saved analysis is missing its source commit.');
    const language = result.language === 'en' ? 'en' : 'ko';
    return taskDto(
      await this.repository.select(session.userId, {
        analysisId,
        recommendationId,
        repositoryId: analysis.repositoryId,
        fullName,
        language,
        title: original.title.trim(),
        body: issueBody(original, analysis.goal, language, fullName, commitSha),
        priority: original.priority,
        source: original,
      })
    );
  }

  async list(
    sessionToken: string | undefined,
    page: number,
    repositoryId?: string,
    analysisId?: string
  ) {
    const session = await this.auth.session(sessionToken);
    const result = await this.repository.list(session.userId, page, repositoryId, analysisId);
    return { ...result, items: result.items.map(taskDto) };
  }

  async get(sessionToken: string | undefined, id: string) {
    const session = await this.auth.session(sessionToken);
    return taskDto(await this.requireTask(session.userId, id));
  }

  async update(sessionToken: string | undefined, id: string, patch: TaskUpdate) {
    const session = await this.auth.session(sessionToken);
    await this.requireTask(session.userId, id);
    const updated = await this.repository.update(session.userId, id, taskUpdate(patch));
    if (!updated) throw new NotFoundException('Task not found.');
    return taskDto(updated);
  }

  private async reconcile(token: string, task: TrackedTask, repository: IssueRepository) {
    const issue = await this.github.findByMarker(
      token,
      repository,
      `<!-- autopilot-task:${task.id} -->`
    );
    if (!issue)
      throw new ConflictException(
        'The previous issue creation outcome is unknown. No new issue was created. Check GitHub, then link its issue number or retry reconciliation.'
      );
    const saved = await this.repository.saveIssue(task.userId, task.id, issue, repository.fullName);
    if (!saved) throw new NotFoundException('Task not found.');
    return taskDto(saved);
  }

  async createIssue(sessionToken: string | undefined, id: string) {
    const session = await this.auth.session(sessionToken);
    const task = await this.requireTask(session.userId, id);
    if (task.issueNumber !== null) return taskDto(task);
    const token = decrypt(session.githubTokenEncrypted);
    const repository = await this.github.repository(token, task.repositoryId);
    if (task.issueCreationState === 'creating' || task.issueCreationState === 'uncertain')
      return this.reconcile(token, task, repository);
    if (task.issueCreationState !== 'none')
      throw new ConflictException('The task issue state is inconsistent. Reload the task.');
    if (!repository.issuesEnabled || repository.archived)
      throw new ConflictException('This repository does not currently accept GitHub Issues.');
    if (!(await this.repository.claimIssue(session.userId, id, task.updatedAt))) {
      const current = await this.requireTask(session.userId, id);
      if (current.issueNumber !== null) return taskDto(current);
      if (current.issueCreationState === 'creating' || current.issueCreationState === 'uncertain')
        return this.reconcile(token, current, repository);
      throw new ConflictException('The draft changed. Review it again before creating an issue.');
    }
    const claimed = await this.requireTask(session.userId, id);
    if (claimed.issueNumber !== null) return taskDto(claimed);
    if (!claimed.issueCreationStartedAt)
      throw new ConflictException('Could not confirm issue creation. Reload the task.');
    let issue;
    try {
      issue = await this.github.create(token, repository, {
        title: claimed.title,
        body: `${claimed.body}\n\n<!-- autopilot-task:${claimed.id} -->`,
      });
    } catch (error) {
      const rejected =
        error instanceof GitHubIssueRequestError
          ? error.definitiveRejection
          : error instanceof HttpException &&
            error.getStatus() >= 400 &&
            error.getStatus() < 500 &&
            error.getStatus() !== 408;
      // A lost response can still mean GitHub created the issue. Never retry a POST
      // unless GitHub definitively rejected it; reconcile by the server marker instead.
      try {
        if (rejected)
          await this.repository.releaseIssue(session.userId, id, claimed.issueCreationStartedAt);
        else
          await this.repository.markUncertain(session.userId, id, claimed.issueCreationStartedAt);
      } catch {
        // A surviving 'creating' state is also locked and can be reconciled safely.
        console.error('Could not persist GitHub issue creation outcome.', { taskId: id });
      }
      throw error;
    }
    // Keep 'creating' if this save fails after GitHub accepted the POST. The next
    // request reconciles the marker rather than creating a duplicate issue.
    const saved = await this.repository.saveIssue(session.userId, id, issue, repository.fullName);
    if (!saved) throw new NotFoundException('Task not found.');
    return taskDto(saved);
  }

  async syncIssue(sessionToken: string | undefined, id: string) {
    const session = await this.auth.session(sessionToken);
    const task = await this.requireTask(session.userId, id);
    if (task.issueNumber === null)
      throw new ConflictException('No GitHub issue is linked to this task.');
    const token = decrypt(session.githubTokenEncrypted);
    const repository = await this.github.repository(token, task.repositoryId);
    const issue = await this.github.get(token, repository, task.issueNumber);
    const saved = await this.repository.saveIssue(session.userId, id, issue, repository.fullName);
    if (!saved) throw new NotFoundException('Task not found.');
    return taskDto(saved);
  }

  async linkIssue(sessionToken: string | undefined, id: string, issueNumber: number) {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > 2147483647)
      throw new BadRequestException('issueNumber must be a positive integer up to 2147483647.');
    const session = await this.auth.session(sessionToken);
    const task = await this.requireTask(session.userId, id);
    if (task.issueNumber !== null && task.issueNumber !== issueNumber)
      throw new ConflictException('A different GitHub issue is already linked to this task.');
    if (
      task.issueCreationState === 'creating' &&
      (!task.issueCreationStartedAt || Date.now() - task.issueCreationStartedAt.getTime() < 30000)
    )
      throw new ConflictException(
        'Issue creation is in progress. Wait before linking an existing issue.'
      );
    const token = decrypt(session.githubTokenEncrypted);
    const repository = await this.github.repository(token, task.repositoryId);
    const issue = await this.github.get(token, repository, issueNumber);
    // A link that started before another request claimed creation must not attach
    // an arbitrary issue while that POST is in flight.
    const saved = await this.repository.saveIssue(
      session.userId,
      id,
      issue,
      repository.fullName,
      task.updatedAt,
      task.issueCreationState
    );
    if (!saved) throw new NotFoundException('Task not found.');
    return taskDto(saved);
  }
}

export const repositoryTaskService = new RepositoryTaskService();
