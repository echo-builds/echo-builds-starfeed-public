const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';

const freeAI = require('./_lib/free-ai');

function githubHeaders(token,accept = 'application/vnd.github+json') {
  return {Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll',...(token ? {Authorization:`Bearer ${token}`} : {})};
}

async function github(path,token,accept) {
  const response = await fetch(GITHUB_API + path,{headers:githubHeaders(token,accept),signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('github_' + response.status);
  return accept === 'application/vnd.github.raw+json' ? response.text() : response.json();
}

async function translate(req,markdown) {
  return freeAI.generate([
    {role:'user',content:'请将以下 GitHub README 逐段忠实翻译成自然简体中文。严格保留 Markdown 标题、列表、图片、链接、命令和代码，不得总结、扩写或编造。\n\n'+markdown}
  ],{json:false,temperature:0,maxTokens:5000});
}

function isMostlyChinese(text) {
  const sample = String(text || '')
    .replace(/<[^>]+>/g,' ')
    .replace(/https?:\/\/\S+/gi,' ')
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/[`#>*_\-\[\]()!\d\s]/g,'')
    .slice(0,3000);
  if (!sample) return false;
  const chinese = (sample.match(/[㐀-鿿]/g) || []).length;
  return chinese / sample.length > .32;
}

function sections(markdown) {
  const lines = String(markdown || '').replace(/\r/g,'').split('\n');
  const result = [];
  let current = {heading:'',body:[]};
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      if (current.body.some(value=>value.trim())) result.push(current);
      current = {heading:match[2].trim(),level:match[1].length,body:[line]};
    } else current.body.push(line);
  }
  if (current.body.some(value=>value.trim())) result.push(current);
  return result;
}

function selectProductMarkdown(markdown) {
  const include = /(about|overview|introduction|what is|why|feature|capabilit|how it works|workflow|use cases?|usage|demo|screenshots?|preview|product|介绍|关于|概览|功能|能力|工作原理|使用场景|怎么用|演示|截图)/i;
  const exclude = /(install|setup|deploy|development|build from source|contribut|license|api reference|configuration|troubleshoot|安装|部署|开发|贡献|许可证|配置)/i;
  const all = sections(markdown);
  const chosen = [];
  for (let index = 0; index < all.length; index++) {
    const section = all[index];
    if (!section.heading && index === 0) chosen.push(section);
    else if (include.test(section.heading) && !exclude.test(section.heading)) chosen.push(section);
  }
  if (chosen.length < 2) {
    for (const section of all) {
      if (chosen.includes(section) || exclude.test(section.heading)) continue;
      chosen.push(section);
      if (chosen.length >= 4) break;
    }
  }
  let text = chosen.map(section=>section.body.join('\n').trim()).filter(Boolean).join('\n\n');
  text = text.replace(/(?:\n\s*){3,}/g,'\n\n').trim();
  return text.slice(0,15000);
}

function resolveImages(markdown,repo) {
  const branch = repo.default_branch || 'main';
  const base = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/`;
  return markdown
    .replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g,(all,start,url,end)=>start + (/^https?:\/\//i.test(url) ? url : base + url.replace(/^\.\//,'')) + end)
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,(all,start,url,end)=>start + (/^https?:\/\//i.test(url) ? url : base + url.replace(/^\.\//,'')) + end);
}

function publicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function productExperience(repo,release) {
  const homepage = publicUrl(repo.homepage);
  const releaseUrl = publicUrl(release?.html_url);
  const hasAssets = Array.isArray(release?.assets) && release.assets.some(asset=>publicUrl(asset?.browser_download_url));
  const homepageUrl = homepage ? new URL(homepage) : null;
  const isGitHub = homepageUrl && /(^|\.)github\.com$/i.test(homepageUrl.hostname);
  const looksLikeDocs = homepage && /(^docs\.|readthedocs|\/docs(?:\/|$))/i.test(homepage);
  const looksLikeLiveApp = homepageUrl && (/^(app|demo|try|play)\./i.test(homepageUrl.hostname) || /(vercel\.app|netlify\.app|github\.io|hf\.space)$/i.test(homepageUrl.hostname) || /huggingface\.co\/spaces\//i.test(homepageUrl.hostname + homepageUrl.pathname));
  if (homepage && !isGitHub && looksLikeLiveApp) return {url:homepage,mode:'online'};
  if (releaseUrl && hasAssets) return {url:releaseUrl,mode:'download'};
  if (homepage && !isGitHub && !looksLikeDocs) return {url:homepage,mode:'online'};
  return null;
}

module.exports = async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','public, s-maxage=86400, stale-while-revalidate=604800');
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  const fullName = String(req.query?.repo || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return res.status(400).json({error:'invalid_repo'});
  let token = '';
  const stored = getSession(req);
  if (stored) {
    const auth = await refreshSession(stored).catch(()=>({}));
    if (auth.session) {
      token = auth.session.accessToken;
      if (auth.refreshed) setSession(res,auth.session);
    }
  }
  try {
    const repo = await github(`/repos/${fullName}`,token);
    if (repo.private || (repo.visibility && repo.visibility !== 'public')) return res.status(403).json({error:'public_repositories_only'});
    const [readme,release] = await Promise.all([
      github(`/repos/${fullName}/readme`,token,'application/vnd.github.raw+json'),
      github(`/repos/${fullName}/releases/latest`,token).catch(()=>null)
    ]);
    const experience = productExperience(repo,release);
    const selected = resolveImages(selectProductMarkdown(readme),repo);
    if (!selected) return res.status(200).json({repo,experience,readme_markdown:'',readme_url:`https://github.com/${fullName}#readme`});
    const chinese = isMostlyChinese(selected);
    let content = selected;
    let translated = false;
    if (!chinese) {
      try {
        content = await translate(req,selected);
        translated = true;
      } catch {
        content = selected;
      }
    }
    return res.status(200).json({repo,experience,readme_markdown:content,readme_url:`https://github.com/${fullName}#readme`,translated});
  } catch (error) {
    return res.status(502).json({error:'project_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};
