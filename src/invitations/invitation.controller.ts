import { NextFunction, Response } from 'express';
import { AuthenticateRequest, InviteMember } from '../common/dto/member.dto';
import { errorMsg, handleError, statusCode } from '../common/filters/error-handler';
import { memberService } from '../members/member.service';

export const inviteMember = async (req: AuthenticateRequest, res: Response, next: NextFunction) => {
  try {
    const projectId = parseInt(req.params.projectId, 10);
    const { email }: InviteMember = req.body;

    if (!req.user?.id) {
      return handleError(next, null, errorMsg.loginRequired, statusCode.unauthorized);
    }

    if (!email || isNaN(projectId)) {
      return handleError(next, null, errorMsg.wrongRequestFormat, statusCode.badRequest);
    }

    const { invitationId } = await memberService.inviteMember(req.user.id, projectId, { email });
    return res.status(201).json({ invitationId });
  } catch (error) {
    next(error);
  }
};

export const acceptInvitation = async (
  req: AuthenticateRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const invitationId = Number(req.params.invitationId);

    if (!req.user?.id) {
      return handleError(next, null, errorMsg.loginRequired, statusCode.unauthorized);
    }

    if (isNaN(invitationId)) {
      return handleError(next, null, errorMsg.dataNotFound, statusCode.notFound);
    }

    const result = await memberService.acceptInvitation({ invitationId, userId: req.user.id });
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const deleteInvitation = async (
  req: AuthenticateRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const invitationId = Number(req.params.invitationId);

    if (!req.user?.id) {
      return handleError(next, null, errorMsg.loginRequired, statusCode.unauthorized);
    }

    if (isNaN(invitationId)) {
      return handleError(next, null, errorMsg.wrongRequestFormat, statusCode.badRequest);
    }

    await memberService.deleteInvitation({ invitationId, userId: req.user.id });
    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const getMyInvitations = async (
  req: AuthenticateRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user?.id) {
      return handleError(next, null, errorMsg.loginRequired, statusCode.unauthorized);
    }

    const status = (req.query.status as string) || 'pending';
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const allowed = ['pending', 'accepted', 'rejected', 'all'];

    if (!allowed.includes(status) || page < 1 || limit < 1) {
      return handleError(next, null, errorMsg.wrongRequestFormat, statusCode.badRequest);
    }

    const result = await memberService.getMyInvitations({
      userId: req.user.id,
      status: status as 'pending' | 'accepted' | 'rejected' | 'all',
      page,
      limit,
    });
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const rejectInvitation = async (
  req: AuthenticateRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const invitationId = Number(req.params.invitationId);

    if (!req.user?.id) {
      return handleError(next, null, errorMsg.loginRequired, statusCode.unauthorized);
    }

    if (isNaN(invitationId)) {
      return handleError(next, null, errorMsg.wrongRequestFormat, statusCode.badRequest);
    }

    const result = await memberService.rejectInvitation({ invitationId, userId: req.user.id });
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
