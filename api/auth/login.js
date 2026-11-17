const crypto = require('crypto');
const {originOf,safeReturnTo,setOAuthState} = require('../_lib/session');

module.exports = function handler(req,res) {
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  if (!process.env.GITHUB_CLIENT_ID || !process.env.SESSION_SECRET) return res.status(503).json({error:'auth_not_configured'});
  const state = crypto.randomBytes(24).toString('base64url');
  const returnTo = safeReturnTo(req.query.returnTo);
  const redirectUri = `${originOf(req)}/api/auth/callback`;
  setOAuthState(res,{state,returnTo});
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id',process.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri',redirectUri);
  authorize.searchParams.set('state',state);
  authorize.searchParams.set('scope','public_repo');
  res.redirect(302,authorize.toString());
};
