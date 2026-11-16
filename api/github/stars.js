const {clearSession,getSession,refreshSession,setSession} = require('../_lib/session');

const headers = token => ({
  Accept:'application/vnd.github+json',
  Authorization:`Bearer ${token}`,
  'X-GitHub-Api-Version':'2022-11-28',
  'User-Agent':'Echo-GitHub-Picks'
});

function hasStarScope(response) {
  const scopes = String(response.headers.get('x-oauth-scopes') || '').split(',').map(value=>value.trim());
  return scopes.includes('public_repo') || scopes.includes('repo');
}

function shaped(item) {
  const {full_name,name,description,stargazers_count,topics,homepage,created_at,updated_at,html_url} = item;
  return {full_name,name,description,stargazers_count,topics,homepage,created_at,updated_at,html_url};
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  const result = await refreshSession(getSession(req));
  if (!result.session) {
    clearSession(res);
    return res.status(401).json({error:'authentication_required'});
  }
  if (result.refreshed) setSession(res,result.session);
  const auth = headers(result.session.accessToken);
  try {
    if (req.method === 'GET') {
      const page = Math.min(10,Math.max(1,Number(req.query.page) || 1));
      const response = await fetch(`https://api.github.com/user/starred?per_page=100&page=${page}&sort=created&direction=desc`,{headers:auth});
      if (!hasStarScope(response)) return res.status(403).json({error:'missing_public_repo_scope'});
      if (!response.ok) return res.status(response.status).json({error:'github_request_failed'});
      const items = await response.json();
      return res.status(200).json({items:items.map(shaped),hasMore:items.length === 100});
    }
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const repo = String(req.query.repo || '');
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return res.status(400).json({error:'invalid_repository'});
      const [owner,name] = repo.split('/');
      const response = await fetch(`https://api.github.com/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,{method:req.method,headers:auth});
      if (!hasStarScope(response)) return res.status(403).json({error:'missing_public_repo_scope'});
      if (!response.ok && response.status !== 204) return res.status(response.status).json({error:'github_request_failed'});
      return res.status(204).end();
    }
    res.status(405).json({error:'method_not_allowed'});
  } catch {
    res.status(502).json({error:'github_unavailable'});
  }
};
