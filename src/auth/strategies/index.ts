import { accessTokenStrategy, refreshTokenStrategy } from './jwt.strategy';
import passport from 'passport';
import createGoogleStrategy from './google.strategy';
import createGithubStrategy from './github.strategy';

passport.use('access-token', accessTokenStrategy);
passport.use('refresh-token', refreshTokenStrategy);

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use('google', createGoogleStrategy());
}

// Configuration is checked when login starts, so missing credentials return 503.
passport.use('github', createGithubStrategy());

export default passport;
