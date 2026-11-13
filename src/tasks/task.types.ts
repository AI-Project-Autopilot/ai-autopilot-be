import { IssueCreationState, TrackedTask, TrackedTaskStatus } from '@prisma/client';
import { AnalysisLanguage, RecommendedDevelopmentTask } from '../analysis/analysis.types';

export interface TaskDraft {
  analysisId: string;
  recommendationId: string;
  repositoryId: string;
  fullName: string;
  language: AnalysisLanguage;
  title: string;
  body: string;
  priority: RecommendedDevelopmentTask['priority'];
  source: RecommendedDevelopmentTask;
}

export interface TaskUpdate {
  title?: string;
  body?: string;
  status?: TrackedTaskStatus;
}

export interface RepositoryTask {
  id: string;
  analysisId: string;
  recommendationId: string;
  repositoryId: string;
  fullName: string;
  language: string;
  title: string;
  body: string;
  priority: string;
  status: TrackedTaskStatus;
  issueNumber: number | null;
  issueUrl: string | null;
  issueState: string | null;
  issueStateReason: string | null;
  issueCreationState: IssueCreationState;
  issueCreationStartedAt: string | null;
  issueSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function taskDto(task: TrackedTask): RepositoryTask {
  return {
    id: task.id,
    analysisId: task.analysisId,
    recommendationId: task.recommendationId,
    repositoryId: task.repositoryId,
    fullName: task.fullName,
    language: task.language,
    title: task.title,
    body: task.body,
    priority: task.priority,
    status: task.status,
    issueNumber: task.issueNumber,
    issueUrl: task.issueUrl,
    issueState: task.issueState,
    issueStateReason: task.issueStateReason,
    issueCreationState: task.issueCreationState,
    issueCreationStartedAt: task.issueCreationStartedAt?.toISOString() ?? null,
    issueSyncedAt: task.issueSyncedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}
