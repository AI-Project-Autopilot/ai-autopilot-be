import { Router } from 'express';
import memberRouter from '../members/member.route';
import invitationRouter from '../invitations/invitation.route';
import authRouter from '../auth/auth.route';
import userRouter from '../users/user.route';
import projectRouter from '../projects/project.route';
import taskRouter from '../tasks/task.route';
import subtaskRouter from '../subtasks/subtask.route';
import commentRouter from '../comments/comment.route';
import fileRouter from '../files/file.route';

const router = Router();

router.use('/', memberRouter);
router.use('/', invitationRouter);
router.use('/auth', authRouter);
router.use('/users', userRouter);
router.use('/projects', projectRouter);
router.use('/tasks', taskRouter);
router.use('/subtasks', subtaskRouter);
router.use('/comments', commentRouter);
router.use('/files', fileRouter);

export default router;
