const {clearOAuthState,getOAuthState,originOf,safeReturnTo,setSession} = require('../_lib/session');

function withConnected(path,status) {
  const url = new URL(safeReturnTo(path),'https://starfeed.invalid');
  url.searchParams.set(status === 'success' ? 'connected' : 'auth_error','1');
  return url.pathname + url.search + url.hash;
}

module.exports = async function handler(req,res) {
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  const pending = getOAuthState(req);
  clearOAuthState(res);
  if (!pending || !req.query.code || req.query.state !== pending.state) return res.redirect(302,withConnected(pending?.returnTo,'error'));
  try {
    const redirectUri = `${originOf(req)}/api/auth/callback`;
    const response = await fetch('https://github.com/login/oauth/access_token',{
      method:'POST',
      headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:process.env.GITHUB_CLIENT_ID,
        client_secret:process.env.GITHUB_CLIENT_SECRET,
        code:String(req.query.code),
        redirect_uri:redirectUri
      })
    });
    const token = await response.json();
    if (!response.ok || !token.access_token) throw new Error(token.error || 'token_exchange_failed');
    const userResponse = await fetch('https://api.github.com/user',{headers:{
      Accept:'application/vnd.github+json',
      Authorization:`Bearer ${token.access_token}`,
      'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'Echo-GitHub-Picks'
    }});
    if (!userResponse.ok) throw new Error('user_lookup_failed');
    const user = await userResponse.json();
    setSession(res,{
      accessToken:token.access_token,
      expiresAt:Date.now() + Number(token.expires_in || 28800) * 1000,
      refreshToken:token.refresh_token || null,
      refreshTokenExpiresAt:Date.now() + Number(token.refresh_token_expires_in || 15552000) * 1000,
      user:{id:user.id,login:user.login,avatar_url:user.avatar_url}
    });
    res.redirect(302,withConnected(pending.returnTo,'success'));
  } catch {
    res.redirect(302,withConnected(pending.returnTo,'error'));
  }
};
