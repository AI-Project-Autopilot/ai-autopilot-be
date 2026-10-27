import express from 'express';
import AuthController from './auth.controller';
import passport from './strategies/index';
const authController = new AuthController();
const authRouter = express.Router();
const requireGoogleOAuth: express.RequestHandler = (_req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ message: 'Google OAuth is not configured.' });
    return;
  }
  next();
};

authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
// jwt 전략 테스트용 api 추후 삭제 예정
authRouter.get(
  '/test',
  passport.authenticate('access-token', { session: false }),
  authController.test
);
authRouter.get(
  '/google',
  requireGoogleOAuth,
  passport.authenticate('google', { scope: ['email', 'profile'] })
);
authRouter.get(
  '/google/callback',
  requireGoogleOAuth,
  passport.authenticate('google', { session: false }),
  authController.googleCallback
);
export default authRouter;
