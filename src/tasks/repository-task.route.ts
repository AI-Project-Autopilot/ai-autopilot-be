import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request, RequestHandler, Router } from 'express';
import { readGitHubCookie, sessionCookieName } from '../auth/github-cookies';
import { RepositoryTaskService, repositoryTaskService } from './repository-task.service';
import { repositoryId, requestObject, taskId, taskUpdate } from './task.validation';

export function createRepositoryTaskRouter(service: RepositoryTaskService = repositoryTaskService) {
  const router = Router();
  const token = (req: Request) => readGitHubCookie(req, sessionCookieName);
  const endpoint =
    (handler: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        await handler(req, res, next);
      } catch (error) {
        next(
          error instanceof HttpException
            ? error
            : new InternalServerErrorException(
                'Could not update or load the task. Please try again.'
              )
        );
      }
    };
  const mutation = (req: Request) => {
    if (req.headers.origin !== new URL(service.frontendUrl()).origin)
      throw new ForbiddenException('Invalid request origin.');
    if (req.body !== undefined && !req.is('application/json'))
      throw new BadRequestException('The task request must use application/json.');
  };
  const emptyMutation = (req: Request) => {
    mutation(req);
    if (req.body !== undefined) requestObject(req.body, []);
  };

  router.post(
    '/github/analyses/:analysisId/tasks',
    endpoint(async (req, res) => {
      mutation(req);
      const analysisId = taskId(req.params.analysisId);
      const input = requestObject(req.body, ['recommendationId']);
      if (
        typeof input.recommendationId !== 'string' ||
        !/^task-[1-6]$/.test(input.recommendationId)
      )
        throw new BadRequestException('recommendationId must identify a saved recommendation.');
      res.json(await service.select(token(req), analysisId, input.recommendationId));
    })
  );

  router.get(
    '/github/tasks',
    endpoint(async (req, res) => {
      const page = req.query.page ?? '1';
      if (typeof page !== 'string' || !/^[1-9][0-9]{0,5}$/.test(page))
        throw new BadRequestException('page must be a positive integer up to 999999.');
      const repo =
        req.query.repositoryId === undefined ? undefined : repositoryId(req.query.repositoryId);
      const analysis =
        req.query.analysisId === undefined ? undefined : taskId(req.query.analysisId);
      res.json(await service.list(token(req), Number(page), repo, analysis));
    })
  );

  router.get(
    '/github/tasks/:id',
    endpoint(async (req, res) => {
      res.json(await service.get(token(req), taskId(req.params.id)));
    })
  );

  router.patch(
    '/github/tasks/:id',
    endpoint(async (req, res) => {
      mutation(req);
      const id = taskId(req.params.id);
      const patch = taskUpdate(req.body);
      res.json(await service.update(token(req), id, patch));
    })
  );

  router.post(
    '/github/tasks/:id/issue',
    endpoint(async (req, res) => {
      emptyMutation(req);
      res.json(await service.createIssue(token(req), taskId(req.params.id)));
    })
  );

  router.post(
    '/github/tasks/:id/issue/sync',
    endpoint(async (req, res) => {
      emptyMutation(req);
      res.json(await service.syncIssue(token(req), taskId(req.params.id)));
    })
  );

  router.post(
    '/github/tasks/:id/issue/link',
    endpoint(async (req, res) => {
      mutation(req);
      const id = taskId(req.params.id);
      const input = requestObject(req.body, ['issueNumber']);
      if (
        typeof input.issueNumber !== 'number' ||
        !Number.isSafeInteger(input.issueNumber) ||
        input.issueNumber < 1 ||
        input.issueNumber > 2147483647
      )
        throw new BadRequestException('issueNumber must be a positive integer up to 2147483647.');
      res.json(await service.linkIssue(token(req), id, input.issueNumber));
    })
  );

  return router;
}

export default createRepositoryTaskRouter();
