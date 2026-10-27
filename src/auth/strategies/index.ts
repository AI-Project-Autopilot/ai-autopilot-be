import { accessTokenStrategy, refreshTokenStrategy } from './jwt.strategy';
import passport from 'passport';
import createGoogleStrategy from './google.strategy';

passport.use('access-token', accessTokenStrategy);
passport.use('refresh-token', refreshTokenStrategy);

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use('google', createGoogleStrategy());
}

export default passport;
