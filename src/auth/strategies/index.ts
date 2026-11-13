import passport from 'passport';
import createGithubStrategy from './github.strategy';

// Configuration is checked when login starts, so missing credentials return 503.
passport.use('github', createGithubStrategy());

export default passport;
