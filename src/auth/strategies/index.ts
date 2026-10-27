import { accessTokenStrategy, refreshTokenStrategy } from './jwt.strategy';
import passport from 'passport';
import googleStrategy from './google.strategy';

passport.use('access-token', accessTokenStrategy);
passport.use('refresh-token', refreshTokenStrategy);
passport.use('google', googleStrategy);

export default passport;
