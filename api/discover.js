const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODEL = process.env.SEARCH_MODEL || 'nvidia/nemotron-3.5-lightning-free';
const DAY = 86400000;

function dateKey(date) {
  return date.toISOString().slice(0,10);
}

function clean(value,limit = 240) {
  return String(value || '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
}

function jsonFrom(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(source); } catch {
    const match = source.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function aiToken(req) {
  return process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN || '';
}

async function askModel(req,messages,maxTokens = 3200) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(GATEWAY_API,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,reasoning:{effort:'none'},temperature:0.1,max_tokens:maxTokens,messages}),
      signal:AbortSignal.timeout(18000)
    });
    if (response.status !== 429 || attempt) break;
    await new Promise(resolve=>setTimeout(resolve,1200));
  }
  if (!response.ok) throw new Error('ai_gateway_' + response.status);
  const data = await response.json();
  const parsed = jsonFrom(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('invalid_ai_response');
  return parsed;
}

function githubHeaders(token,accept = 'application/vnd.github+json') {
  return {Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll',...(token ? {Authorization:`Bearer ${token}`} : {})};
}

async function githubJson(path,token) {
  const response = await fetch(GITHUB_API + path,{headers:githubHeaders(token),signal:AbortSignal.timeout(12000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('github_' + response.status);
  return response.json();
}

async function githubText(path,token) {
  const response = await fetch(GITHUB_API + path,{headers:githubHeaders(token,'application/vnd.github.raw+json'),signal:AbortSignal.timeout(12000)});
  if (!response.ok) return '';
  return (await response.text()).slice(0,60000);
}

function shape(item) {
  const {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,pushed_at,html_url,license,default_branch,archived,fork} = item;
  return {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,pushed_at,html_url,license,default_branch,archived,fork};
}

async function search(query,token,page) {
  const params = new URLSearchParams({q:query,sort:'stars',order:'desc',per_page:'40',page:String(page)});
  const data = await githubJson('/search/repositories?' + params,token);
  return Array.isArray(data?.items) ? data.items : [];
}

function resolveAsset(value,repo) {
  const raw = String(value || '').trim().replace(/^<|>$/g,'');
  if (!raw || /^(data:|javascript:)/i.test(raw)) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    const path = raw.replace(/^\.\//,'');
    return `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || 'main'}/${path}`;
  } catch { return null; }
}

function readmeImages(markdown,repo) {
  const found = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) found.push(match[1]);
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) found.push(match[1]);
  const filtered = [...new Set(found.map(value=>resolveAsset(value,repo)).filter(Boolean))].filter(url=>
    !/shields\.io|badge|badgen|license|coverage|actions\/workflows|social|logo(?:\.|\/)|icon(?:\.|\/)|star-history|trendshift|avatars\.githubusercontent|github\.com\/.+\.svg/i.test(url) &&
    !/\.svg(?:\?|$)/i.test(url) &&
    /(screenshot|screen[-_.\/]|preview|demo|showcase|interface|ui[-_.\/]|app[-_.\/]|chat[-_.\/]|dashboard|workflow|hero|usage|example|product|cover|\.gif(?:\?|$))/i.test(url));
  return filtered.sort((a,b)=>Number(/screenshot|preview|demo|showcase|interface|ui[-_.\/]/i.test(b))-Number(/screenshot|preview|demo|showcase|interface|ui[-_.\/]/i.test(a)));
}

function fallbackRelevant(repo,readme) {
  const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const relevant = /(artificial intelligence|\bai\b|llm|agent|mcp|rag|prompt|model|copilot|workflow|automation|productivity|design|prototype|research|meeting|note|transcri|voice|audio|video|education|analytics|search|knowledge|developer tool)/i.test(text);
  const excluded = /(rom hack|jailbreak|cheat|trainer|keygen|skin swapper|mario kart|nintendo switch|game recomp|systemhelper|mobilegestalt)/i.test(text) && !/(\bai\b|agent|llm|model)/i.test(text);
  return relevant && !excluded;
}

function likelyRelevant(repo) {
  const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const strong = /(artificial intelligence|\bai\b|llm|agent|mcp|rag|prompt|deepseek|claude|openai|gemini|copilot|workflow automation|speech|transcri|voice cloning|video generation|research assistant|design tool|prototype|meeting note)/i.test(text);
  const excluded = /(rom hack|jailbreak|cheat|trainer|keygen|skin swapper|mario kart|nintendo switch|game recomp|systemhelper|mobilegestalt)/i.test(text) && !/(\bai\b|agent|llm|model)/i.test(text);
  return strong && !excluded;
}

function fallbackCopy(repo,kind,release) {
  const summary = clean(repo.description,160) || `${repo.name} 的开源项目介绍暂缺。`;
  return {
    relevant:true,
    quality_score:55 + Math.min(25,Math.round(Math.log10(Math.max(10,repo.stargazers_count || 0)) * 5)),
    title:repo.name,
    summary,
    selection_reason:kind === 'new' ? '近期新项目' : `近期发布 ${release?.tag_name || '重要版本'}`
  };
}

async function classify(req,candidates) {
  const payload = candidates.map(({repo,kind,release,readme,cover})=>({
    full_name:repo.full_name,description:repo.description,topics:repo.topics,stars:repo.stargazers_count,forks:repo.forks_count,
    created_at:repo.created_at,latest_release:release ? {tag:release.tag_name,published_at:release.published_at,name:release.name} : null,
    has_product_image:Boolean(cover),homepage:repo.homepage,readme_excerpt:readme.slice(0,750)
  }));
  try {
    const result = await askModel(req,[
      {role:'system',content:'你为面向 AI 产品经理的 GitHub 项目信息流做准入判断。只输出 JSON：{"items":[{"full_name":"owner/repo","relevant":true,"quality_score":0,"title":"中文标题","summary":"中文一句话","selection_reason":"入选原因"}]}。relevant 仅在项目与 AI 产品、Agent、AI 工作流、研究/设计/效率工具或可借鉴的产品形态直接相关时为 true；游戏反编译、越狱、系统修改、普通代码练习应为 false。quality_score 综合 README 完整度、可体验性、社区参与、产品完成度，0-100。title 和 summary 只用于首页卡片，可准确概括但不得虚构。selection_reason 只能写“近期新项目”或“近期发布 <版本>”。必须为每个输入项目返回一项。'},
      {role:'user',content:JSON.stringify({candidates:payload})}
    ],3600);
    return new Map((Array.isArray(result.items) ? result.items : []).map(item=>[String(item.full_name || '').toLowerCase(),item]));
  } catch { return new Map(); }
}

module.exports = async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','public, s-maxage=300, stale-while-revalidate=3600');
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  const page = Math.min(5,Math.max(1,Number(req.query?.page || 1)));
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
    const now = Date.now();
    const newSince = dateKey(new Date(now - 90 * DAY));
    const activeSince = dateKey(new Date(now - 35 * DAY));
    const releaseSince = now - 45 * DAY;
    const [newRaw,activeRaw] = await Promise.all([
      search(`is:public archived:false fork:false stars:>=1000 created:>=${newSince}`,token,page),
      search(`is:public archived:false fork:false stars:>=5000 pushed:>=${activeSince}`,token,page)
    ]);

    const newRepos = newRaw.filter(item=>!item.archived && !item.fork && likelyRelevant(item)).slice(0,14).map(item=>({repo:shape(item),kind:'new',release:null}));
    const oldPool = activeRaw.filter(item=>Date.parse(item.created_at) < now - 90 * DAY && !item.archived && !item.fork && likelyRelevant(item)).slice(0,12);
    const oldWithRelease = (await Promise.all(oldPool.map(async item=>({
      repo:shape(item),kind:'release',release:await githubJson(`/repos/${item.full_name}/releases/latest`,token).catch(()=>null)
    })))).filter(item=>item.release?.published_at && Date.parse(item.release.published_at) >= releaseSince);

    const merged = new Map();
    for (const item of [...newRepos,...oldWithRelease]) merged.set(item.repo.full_name.toLowerCase(),item);
    const base = [...merged.values()].slice(0,18);
    const enriched = await Promise.all(base.map(async item=>{
      const readme = await githubText(`/repos/${item.repo.full_name}/readme`,token).catch(()=>'');
      return {...item,readme,cover:readmeImages(readme,item.repo)[0] || null};
    }));
    const decisions = await classify(req,enriched);
    const scored = enriched.flatMap(item=>{
      const key = item.repo.full_name.toLowerCase();
      const hasDecision = decisions.has(key);
      const decision = decisions.get(key) || fallbackCopy(item.repo,item.kind,item.release);
      const relevant = hasDecision ? decision.relevant !== false && Number(decision.quality_score || 0) >= 62 : fallbackRelevant(item.repo,item.readme) && /[㐀-鿿]/.test(String(item.repo.description || ''));
      if (!relevant) return [];
      const freshnessDate = item.kind === 'new' ? item.repo.created_at : item.release?.published_at;
      const freshness = Math.max(0,90 - Math.max(0,(now - Date.parse(freshnessDate || 0)) / DAY));
      const heat = Math.log10(Math.max(10,item.repo.stargazers_count || 0)) * 20 + freshness + Number(decision.quality_score || 0) * .35;
      return [{...item.repo,cover:item.cover,ai_title:clean(decision.title,60) || item.repo.name,ai_summary:clean(decision.summary,180) || clean(item.repo.description,180),selection_reason:item.kind === 'new' ? '近期新项目' : `近期发布 ${item.release?.tag_name || '重要版本'}`,release:item.release ? {tag_name:item.release.tag_name,published_at:item.release.published_at,name:item.release.name,html_url:item.release.html_url} : null,quality_score:Number(decision.quality_score || 0),heat_score:heat,candidate_kind:item.kind}];
    });
    const newItems = scored.filter(item=>item.candidate_kind === 'new').sort((a,b)=>b.heat_score-a.heat_score);
    const releaseItems = scored.filter(item=>item.candidate_kind === 'release').sort((a,b)=>b.heat_score-a.heat_score);
    const items = [];
    while (items.length < 24 && (newItems.length || releaseItems.length)) {
      for (let index = 0; index < 2 && newItems.length && items.length < 24; index++) items.push(newItems.shift());
      if (releaseItems.length && items.length < 24) items.push(releaseItems.shift());
    }
    for (const item of items) delete item.candidate_kind;

    return res.status(200).json({items,page,next_page:page + 1,has_more:page < 5,method:'new_or_recent_release',classifier:decisions.size ? 'ai' : 'fallback'});
  } catch (error) {
    return res.status(502).json({error:'discover_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};
