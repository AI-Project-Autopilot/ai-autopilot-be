import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Router } from 'express';
import { readGitHubCookie, sessionCookieName } from '../auth/github-cookies';
import {
  repositoryAnalysisService,
  RepositoryAnalysisService,
} from './repository-analysis.service';

export function createRepositoryAnalysisRouter(
  service: RepositoryAnalysisService = repositoryAnalysisService
) {
  const router = Router();
  router.get('/github/analyses', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const page = req.query.page ?? '1';
      if (typeof page !== 'string' || !/^[1-9][0-9]{0,5}$/.test(page))
        throw new BadRequestException('page must be a positive integer up to 999999.');
      const repositoryId = req.query.repositoryId;
      if (
        repositoryId !== undefined &&
        (typeof repositoryId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(repositoryId))
      )
        throw new BadRequestException('repositoryId must be a positive GitHub repository ID.');
      res.json(
        await service.list(readGitHubCookie(req, sessionCookieName), Number(page), repositoryId)
      );
    } catch (error) {
      next(
        error instanceof HttpException
          ? error
          : new InternalServerErrorException('Could not load repository analyses.')
      );
    }
  });
  router.get('/github/analyses/:analysisId', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const analysisId = req.params.analysisId;
      if (typeof analysisId !== 'string' || !/^c[a-z0-9]{24}$/.test(analysisId))
        throw new BadRequestException('analysisId must be a valid analysis ID.');
      res.json(await service.get(readGitHubCookie(req, sessionCookieName), analysisId));
    } catch (error) {
      next(
        error instanceof HttpException
          ? error
          : new InternalServerErrorException('Could not load repository analysis.')
      );
    }
  });
  router.post('/github/repositories/:repositoryId/analysis', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const cancellation = new AbortController();
    const onAbort = () => cancellation.abort();
    const onClose = () => {
      if (!res.writableEnded) cancellation.abort();
    };
    req.once('aborted', onAbort);
    res.once('close', onClose);
    try {
      if (req.headers.origin !== new URL(service.frontendUrl()).origin)
        throw new ForbiddenException('Invalid request origin.');
      const id = req.params.repositoryId;
      if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id))
        throw new BadRequestException('repositoryId must be a positive GitHub repository ID.');
      const body: unknown = req.body;
      if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)))
        throw new BadRequestException('The analysis request must be a JSON object.');
      const goal: unknown = (body as { goal?: unknown } | undefined)?.goal;
      if (goal !== undefined && (typeof goal !== 'string' || goal.length > 2000))
        throw new BadRequestException('goal must be a string of at most 2000 characters.');
      const result = await service.analyze(
        readGitHubCookie(req, sessionCookieName),
        id,
        typeof goal === 'string' ? goal.trim() : '',
        cancellation.signal
      );
      if (!cancellation.signal.aborted) res.json(result);
    } catch (error) {
      if (!cancellation.signal.aborted)
        next(
          error instanceof HttpException
            ? error
            : new InternalServerErrorException('Repository analysis failed. Please try again.')
        );
    } finally {
      req.off('aborted', onAbort);
      res.off('close', onClose);
    }
  });
  return router;
}

export default createRepositoryAnalysisRouter();
