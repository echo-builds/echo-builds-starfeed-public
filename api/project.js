const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODEL = process.env.SEARCH_MODEL || 'nvidia/nemotron-3.5-lightning-free';

function aiToken(req) {
  return process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN || '';
}

function githubHeaders(token,accept = 'application/vnd.github+json') {
  return {Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll',...(token ? {Authorization:`Bearer ${token}`} : {})};
}

async function github(path,token,accept) {
  const response = await fetch(GITHUB_API + path,{headers:githubHeaders(token,accept),signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('github_' + response.status);
  return accept === 'application/vnd.github.raw+json' ? response.text() : response.json();
}

async function translate(req,markdown) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(GATEWAY_API,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,reasoning:{effort:'none'},temperature:0,max_tokens:5000,messages:[
        {role:'system',content:'把下面 GitHub README 片段逐段忠实翻译成自然、地道的简体中文。严格保留 Markdown 的标题层级、段落数量、句子信息、列表、链接、图片和代码；不得总结、删减、合并、扩写、润色改写或补充括号解释；原文没有的信息一个字也不要增加。项目名、命令、代码、URL、版本号和专有名词保持原样。只输出翻译后的 Markdown，不加前言，不使用代码围栏包裹全文。'},
        {role:'user',content:markdown}
      ]}),signal:AbortSignal.timeout(25000)
    });
    if (response.status !== 429 || attempt) break;
    await new Promise(resolve=>setTimeout(resolve,1400));
  }
  if (!response.ok) throw new Error('ai_gateway_' + response.status);
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || '').trim().replace(/^```(?:markdown)?\s*/i,'').replace(/\s*```$/,'');
}

function isMostlyChinese(text) {
  const sample = String(text || '').replace(/[`#>*_\-\[\]()!\d\s]/g,'').slice(0,3000);
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

function projectLinks(repo,release) {
  const links = [];
  const homepage = publicUrl(repo.homepage);
  if (homepage && !/github\.com$/i.test(new URL(homepage).hostname)) links.push({url:homepage,label:'产品主页'});
  const releaseUrl = publicUrl(release?.html_url);
  if (releaseUrl) links.push({url:releaseUrl,label:'下载最新版本'});
  return links;
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
    const links = projectLinks(repo,release);
    const selected = resolveImages(selectProductMarkdown(readme),repo);
    if (!selected) return res.status(200).json({repo,links,readme_markdown:'',readme_url:`https://github.com/${fullName}#readme`});
    const translated = isMostlyChinese(selected) ? selected : await translate(req,selected);
    return res.status(200).json({repo,links,readme_markdown:translated,readme_url:`https://github.com/${fullName}#readme`,translated:!isMostlyChinese(selected)});
  } catch (error) {
    return res.status(502).json({error:'project_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};
