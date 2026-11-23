const {getSession,refreshSession,setSession} = require('./_lib/session');
const {configured,sql} = require('./_lib/db');
const freeAI = require('./_lib/free-ai');
const {prepareProjectContent,productExperience} = require('./_lib/project-content');

const GITHUB_API='https://api.github.com';

function githubHeaders(token,accept='application/vnd.github+json') {
  return {Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll',...(token?{Authorization:`Bearer ${token}`}:{})};
}
async function github(path,token,accept) {
  const response=await fetch(GITHUB_API+path,{headers:githubHeaders(token,accept),signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('github_'+response.status);
  return accept==='application/vnd.github.raw+json'?response.text():response.json();
}
function localizedChineseReadmePaths(markdown,repo) {
  const paths=[];
  const add=value=>{
    let candidate=String(value || '').trim().replace(/^<|>$/g,'').split(/[?#]/)[0];
    try { candidate=decodeURIComponent(candidate); } catch {}
    const githubPrefix=`https://github.com/${repo.full_name}/blob/${repo.default_branch || 'main'}/`;
    if (candidate.startsWith(githubPrefix)) candidate=candidate.slice(githubPrefix.length);
    if (/^https?:\/\//i.test(candidate) || candidate.startsWith('/')) return;
    candidate=candidate.replace(/^\.\//,'');
    if (!/readme/i.test(candidate) || !/(?:zh[-_.]?(?:cn|hans)|chinese|简体)/i.test(candidate)) return;
    if (!paths.includes(candidate)) paths.push(candidate);
  };
  for (const match of String(markdown || '').matchAll(/(?:href=["']|\]\()([^"'()\s>]+)/gi)) add(match[1]);
  return paths;
}
async function preferredReadme(repo,primary,token) {
  for (const path of localizedChineseReadmePaths(primary,repo)) {
    const encodedPath=path.split('/').map(encodeURIComponent).join('/');
    const localized=await github(`/repos/${repo.full_name}/contents/${encodedPath}?ref=${encodeURIComponent(repo.default_branch || 'main')}`,token,'application/vnd.github.raw+json').catch(()=>null);
    if (localized && localized.length>400 && /[㐀-鿿]/.test(localized)) return localized;
  }
  return primary;
}
function preparedResponse(payload) {
  return {
    repo:payload,
    experience:payload.experience || null,
    readme_markdown:payload.readme_markdown || '',
    readme_url:`https://github.com/${payload.full_name}#readme`,
    translated:payload.translation_status==='translated',
    translation_status:payload.translation_status || 'pending',
    content_ready:payload.content_ready===true
  };
}
async function storedProject(fullName) {
  if (!configured()) return null;
  const db=sql();
  const key=fullName.toLowerCase();
  const rows=await db`
    SELECT p.payload,
      EXISTS(SELECT 1 FROM feed_events e WHERE e.project_full_name_key=p.full_name_key AND e.status='published') AS published
    FROM projects p WHERE p.full_name_key=${key} LIMIT 1`;
  return rows[0] || null;
}

module.exports=async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','public, s-maxage=86400, stale-while-revalidate=604800');
  if (req.method!=='GET') return res.status(405).json({error:'method_not_allowed'});
  const fullName=String(req.query?.repo || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return res.status(400).json({error:'invalid_repo'});

  try {
    const stored=await storedProject(fullName);
    if (stored?.payload?.content_ready===true) return res.status(200).json(preparedResponse(stored.payload));
    // Published recommendations are prepared by the scanner. Never make the
    // reader wait for a live translation or expose a long untranslated README.
    if (stored?.published) return res.status(200).json(preparedResponse(stored.payload));
  } catch {
    // Database outages must not break on-demand project details from search.
  }

  let token='';
  const session=getSession(req);
  if (session) {
    const auth=await refreshSession(session).catch(()=>({}));
    if (auth.session) {
      token=auth.session.accessToken;
      if (auth.refreshed) setSession(res,auth.session);
    }
  }
  try {
    const repo=await github(`/repos/${fullName}`,token);
    if (repo.private || (repo.visibility&&repo.visibility!=='public')) return res.status(403).json({error:'public_repositories_only'});
    const [readme,release]=await Promise.all([
      github(`/repos/${fullName}/readme`,token,'application/vnd.github.raw+json'),
      github(`/repos/${fullName}/releases/latest`,token).catch(()=>null)
    ]);
    const preferred=await preferredReadme(repo,readme,token);
    const prepared=await prepareProjectContent({readme:preferred,repo,release,freeAI});
    return res.status(200).json({
      repo,
      experience:prepared.experience || productExperience(repo,release),
      readme_markdown:prepared.readme_markdown,
      readme_url:`https://github.com/${fullName}#readme`,
      translated:prepared.translation_status==='translated',
      translation_status:prepared.translation_status,
      content_ready:prepared.content_ready
    });
  } catch(error) {
    return res.status(502).json({error:'project_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};

module.exports._test={preparedResponse,localizedChineseReadmePaths};
