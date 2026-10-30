export interface RepositorySourceFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  lineCount: number;
}

export interface RepositorySnapshot {
  repository: {
    id: string;
    fullName: string;
    defaultBranch: string;
    htmlUrl: string;
    isPrivate: boolean;
    commitSha: string;
  };
  files: RepositorySourceFile[];
  totalFiles: number;
  skippedFiles: number;
  treeTruncated: boolean;
  warnings: string[];
}

export interface AnalysisEvidence {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  url: string;
}

export interface RecommendedDevelopmentTask {
  id: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  implementationSteps: string[];
  acceptanceCriteria: string[];
  evidence: AnalysisEvidence[];
}

export interface MetaAnalysis {
  model: string;
  summary: string;
  recommendations: RecommendedDevelopmentTask[];
}

export interface RepositoryAnalysisResult extends MetaAnalysis {
  analysisId: string;
  repository: RepositorySnapshot['repository'];
  generatedAt: string;
  context: {
    filesRead: Array<{
      path: string;
      bytes: number;
      truncated: boolean;
      lineCount: number;
    }>;
    totalFiles: number;
    skippedFiles: number;
    treeTruncated: boolean;
    warnings: string[];
  };
}
