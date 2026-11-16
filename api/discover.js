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

async function askModel(req,messages,maxTokens = 5200) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(GATEWAY_API,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:MODEL,reasoning:{effort:'none'},temperature:0.1,max_tokens:maxTokens,messages}),
      signal:AbortSignal.timeout(22000)
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
  const params = new URLSearchParams({q:query,sort:'stars',order:'desc',per_page:'50',page:String(page)});
  const data = await githubJson('/search/repositories?' + params,token);
  return Array.isArray(data?.items) ? data.items : [];
}

function resolveAsset(value,repo) {
  const raw = String(value || '').trim().replace(/^<|>$/g,'');
  if (!raw || /^(data:|javascript:)/i.test(raw)) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    return `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || 'main'}/${raw.replace(/^\.\//,'')}`;
  } catch { return null; }
}

function readmeImages(markdown,repo) {
  const found = [];
  for (const match of String(markdown || '').matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) found.push(match[1]);
  for (const match of String(markdown || '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) found.push(match[1]);
  const filtered = [...new Set(found.map(value=>resolveAsset(value,repo)).filter(Boolean))].filter(url=>
    !/shields\.io|badge|badgen|license|coverage|actions\/workflows|social|logo(?:\.|\/)|icon(?:\.|\/)|star-history|trendshift|avatars\.githubusercontent|github\.com\/.+\.svg/i.test(url) &&
    !/\.svg(?:\?|$)/i.test(url) &&
    /(screenshot|screen[-_.\/]|preview|demo|showcase|interface|ui[-_.\/]|app[-_.\/]|chat[-_.\/]|dashboard|workflow|hero|usage|example|product|cover|\.gif(?:\?|$))/i.test(url));
  return filtered.sort((a,b)=>Number(/screenshot|preview|demo|showcase|interface|ui[-_.\/]/i.test(b))-Number(/screenshot|preview|demo|showcase|interface|ui[-_.\/]/i.test(a)));
}

function attentionSignal(repo,readme = '') {
  const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')} ${String(readme).slice(0,4000)}`.toLowerCase();
  const groups = [
    /artificial intelligence|\bai\b|llm|multimodal|foundation model|generative/,
    /agent|mcp|skill|tool calling|workflow|automation|orchestrat/,
    /inference|embedding|vector|rag|model serving|gpu|runtime|evaluation|observability|guardrail/,
    /copilot|assistant|productivity|research|meeting|note|transcri|voice|audio|video|design|prototype|search|knowledge/
  ];
  return groups.reduce((score,pattern)=>score + Number(pattern.test(text)),0);
}

function directAttentionSignal(repo,readme = '') {
  const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const groups = [
    /artificial intelligence|\bai\b|llm|multimodal|foundation model|generative/,
    /\bagent(?:ic|s)?\b|\bmcp\b|claude|codex|tool calling|agent skill/,
    /model inference|llm inference|on-device llm|embedding model|\brag\b|model serving|llm evaluation|ai observability|llm observability|guardrail/
  ];
  return groups.reduce((score,pattern)=>score + Number(pattern.test(text)),0);
}

function isResourceCollection(repo) {
  return /^awesome[-_]/i.test(repo.name || '') || /curated (?:list|collection)|awesome list|collection of (?:tools|projects|resources)|resources? list/i.test(repo.description || '');
}

function conservativeDecisionSupported(repo,decision) {
  return Boolean(decision && decision.relevant !== false && directAttentionSignal(repo) > 0 && !isResourceCollection(repo));
}

function metadataQuality(repo,readme,cover) {
  let score = 24;
  if (repo.description) score += 14;
  if (String(readme || '').length > 1000) score += 20;
  if (repo.homepage) score += 10;
  if (cover) score += 10;
  if (repo.license?.spdx_id && !['NOASSERTION','OTHER'].includes(repo.license.spdx_id)) score += 10;
  if (Number(repo.forks_count || 0) >= 20) score += 7;
  if (Array.isArray(repo.topics) && repo.topics.length >= 2) score += 5;
  return Math.min(100,score);
}

function fallbackSummary(repo) {
  const original = clean(repo.description,170);
  if (/[㐀-鿿]/.test(original)) return original;
  if (original) return `仓库原始说明：${original}`;
  return '该项目缺少足够的仓库说明，具体能力需要进入 README 进一步确认。';
}

function fallbackCopy(repo,kind,release,readme,cover) {
  const signal = attentionSignal(repo,readme);
  const directSignal = directAttentionSignal(repo,readme);
  return {
    relevant:directSignal > 0 && !isResourceCollection(repo),
    attention_category:directSignal > 0 && !isResourceCollection(repo) ? 'ai_related' : 'irrelevant',
    attention_score:Math.min(80,42 + signal * 10),
    quality_score:metadataQuality(repo,readme,cover),
    title:repo.name,
    summary:fallbackSummary(repo),
    selection_reason:kind === 'new' ? '近期高星新项目' : `近期发布 ${release?.tag_name || '重要版本'}`
  };
}

function uniqueText(values,limit = 3) {
  return [...new Set((Array.isArray(values) ? values : []).map(value=>clean(value,260)).filter(value=>value.length >= 6))].slice(0,limit);
}

function recommendationEvidenceSupported(candidate,quotes) {
  const source = clean(`${candidate.repo.description || ''} ${(candidate.repo.topics || []).join(' ')} ${candidate.release?.name || ''} ${candidate.release?.body || ''} ${candidate.readme || ''}`,100000).toLowerCase();
  const evidence = uniqueText(quotes);
  return evidence.length > 0 && evidence.every(quote=>source.includes(quote.toLowerCase()));
}

async function classify(req,candidates) {
  const payload = candidates.map(({repo,kind,release,readme,cover})=>({
    full_name:repo.full_name,
    description:repo.description,
    topics:repo.topics,
    stars:repo.stargazers_count,
    forks:repo.forks_count,
    created_at:repo.created_at,
    pushed_at:repo.pushed_at,
    latest_release:release ? {tag:release.tag_name,published_at:release.published_at,name:release.name,body:clean(release.body,500)} : null,
    homepage:repo.homepage,
    has_product_image:Boolean(cover),
    readme_excerpt:clean(readme.replace(/```[\s\S]*?```/g,' ').replace(/<[^>]+>/g,' ').replace(/[#>*_`|~-]/g,' '),1300)
  }));
  try {
    const result = await askModel(req,[
      {role:'system',content:'你为 AI 产品经理的 GitHub 推荐流做准入、价值判断和中文介绍。只输出 JSON：{"items":[{"full_name":"owner/repo","relevant":true,"attention_category":"ai_product_interaction|agent_workflow|model_capability|ai_productivity|enabling_infrastructure|irrelevant","attention_score":0,"quality_score":0,"title":"中文标题","summary":"中文一句话","selection_reason":"入选原因","evidence_quotes":["资料中的逐字原文"]}]}。必须为每个候选返回一项并保持 full_name。关注价值包括：新的 AI 产品或交互方式；Agent、Skill 与 AI 工作流；值得了解的模型能力或技术创新；实用的 AI 效率工具；对 AI 产品落地有重要意义的基础设施。不要机械排除技术项目：如果它带来新的模型能力、运行方式、评测、安全、数据、部署或开发方法，并会影响产品能力与落地决策，可以进入推荐。反过来，只有热度但与 AI 产品无直接关系、没有新能力或工作方法的项目应排除。每个 relevant 项目必须提供 1-3 条 evidence_quotes，逐字复制 Description、Topics、Release 或 README 原文并直接支撑 title、summary 和关注价值；证据不足就标记 relevant=false。attention_score 表示对 AI 产品经理的了解价值；quality_score 综合 README 完整度、维护状态、可体验性、社区参与和产品完成度。title 直接说明解决的问题或提供的能力。summary 必须先写资料可核验的事实：解决什么实际问题、提供什么方案、有什么新意；不要堆砌术语，不写空泛的“值得关注”。不得编造功能。技术项目的产品价值如果属于推测，必须使用“可用于”“可能帮助”等措辞。selection_reason 只能写“近期高星新项目”或“近期发布 <版本>”。'},
      {role:'user',content:JSON.stringify({candidates:payload})}
    ],6200);
    return new Map((Array.isArray(result.items) ? result.items : []).map(item=>[String(item.full_name || '').toLowerCase(),item]));
  } catch { return new Map(); }
}

function freshnessScore(date,windowDays) {
  const age = Math.max(0,(Date.now() - Date.parse(date || 0)) / DAY);
  return Math.max(0,100 - age / Math.max(1,windowDays) * 100);
}

function popularityScore(stars) {
  return Math.max(0,Math.min(100,Math.log10(Math.max(1,Number(stars || 0))) * 22));
}

function momentumScore(repo) {
  const ageDays = Math.max(1,(Date.now() - Date.parse(repo.created_at || 0)) / DAY);
  const starsPerDay = Number(repo.stargazers_count || 0) / ageDays;
  return Math.max(0,Math.min(100,Math.log10(starsPerDay + 1) * 42));
}

module.exports = async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Cache-Control','public, s-maxage=60, stale-while-revalidate=120');
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

    const newRepos = newRaw.filter(item=>!item.archived && !item.fork).sort((a,b)=>{
      const aValue = momentumScore(a) + attentionSignal(a) * 12;
      const bValue = momentumScore(b) + attentionSignal(b) * 12;
      return bValue-aValue;
    }).slice(0,20).map(item=>({repo:shape(item),kind:'new',release:null}));

    const oldPool = activeRaw.filter(item=>Date.parse(item.created_at) < now - 90 * DAY && !item.archived && !item.fork).sort((a,b)=>{
      const aValue = popularityScore(a.stargazers_count) + attentionSignal(a) * 12;
      const bValue = popularityScore(b.stargazers_count) + attentionSignal(b) * 12;
      return bValue-aValue;
    }).slice(0,16);
    const oldWithRelease = (await Promise.all(oldPool.map(async item=>({repo:shape(item),kind:'release',release:await githubJson(`/repos/${item.full_name}/releases/latest`,token).catch(()=>null)}))))
      .filter(item=>item.release?.published_at && Date.parse(item.release.published_at) >= releaseSince);

    const merged = new Map();
    for (const item of [...newRepos,...oldWithRelease]) merged.set(item.repo.full_name.toLowerCase(),item);
    const base = [...merged.values()].slice(0,30);
    const enriched = await Promise.all(base.map(async item=>{
      const readme = await githubText(`/repos/${item.repo.full_name}/readme`,token).catch(()=>'');
      return {...item,readme,cover:readmeImages(readme,item.repo)[0] || null};
    }));
    const decisions = await classify(req,enriched);
    const aiClassified = decisions.size > 0;
    let scored = enriched.flatMap(item=>{
      const key = item.repo.full_name.toLowerCase();
      const fallback = fallbackCopy(item.repo,item.kind,item.release,item.readme,item.cover);
      const decision = aiClassified ? decisions.get(key) : fallback;
      if (!decision) return [];
      const decisionEvidence = aiClassified ? recommendationEvidenceSupported(item,decision.evidence_quotes) : true;
      const conservativeDecision = aiClassified && !decisionEvidence && conservativeDecisionSupported(item.repo,decision);
      const attention = Math.max(0,Math.min(100,Number(decision.attention_score || 0)));
      const quality = Math.max(0,Math.min(100,Number(decision.quality_score || fallback.quality_score)));
      const accepted = aiClassified ? decision.relevant !== false && (decisionEvidence || conservativeDecision) && attention >= 62 && quality >= 55 : fallback.relevant && quality >= 55;
      if (!accepted) return [];
      const freshnessDate = item.kind === 'new' ? item.repo.created_at : item.release?.published_at;
      const freshness = freshnessScore(freshnessDate,item.kind === 'new' ? 90 : 45);
      const momentum = item.kind === 'new' ? momentumScore(item.repo) : 0;
      const heat = attention * .42 + quality * .2 + freshness * .16 + popularityScore(item.repo.stargazers_count) * .12 + momentum * .1;
      return [{
        ...item.repo,
        cover:item.cover,
        ai_title:decisionEvidence ? (clean(decision.title,60) || item.repo.name) : item.repo.name,
        ai_summary:decisionEvidence ? (clean(decision.summary,180) || fallback.summary) : fallback.summary,
        selection_reason:item.kind === 'new' ? '近期高星新项目' : `近期发布 ${item.release?.tag_name || '重要版本'}`,
        release:item.release ? {tag_name:item.release.tag_name,published_at:item.release.published_at,name:item.release.name,html_url:item.release.html_url,has_assets:Array.isArray(item.release.assets) && item.release.assets.length > 0} : null,
        attention_category:clean(decision.attention_category,40),
        attention_score:attention,
        quality_score:quality,
        evidence_quotes:aiClassified && decisionEvidence ? uniqueText(decision.evidence_quotes) : [],
        heat_score:heat,
        candidate_kind:item.kind
      }];
    });

    let classifierMode = aiClassified ? 'ai' : 'fallback';
    if (!scored.length && aiClassified) {
      classifierMode = 'strict_fallback_after_ai';
      scored = enriched.flatMap(item=>{
        const fallback = fallbackCopy(item.repo,item.kind,item.release,item.readme,item.cover);
        if (!fallback.relevant || fallback.quality_score < 55) return [];
        const freshnessDate = item.kind === 'new' ? item.repo.created_at : item.release?.published_at;
        const freshness = freshnessScore(freshnessDate,item.kind === 'new' ? 90 : 45);
        const momentum = item.kind === 'new' ? momentumScore(item.repo) : 0;
        const heat = fallback.attention_score * .42 + fallback.quality_score * .2 + freshness * .16 + popularityScore(item.repo.stargazers_count) * .12 + momentum * .1;
        return [{
          ...item.repo,
          cover:item.cover,
          ai_title:item.repo.name,
          ai_summary:fallback.summary,
          selection_reason:item.kind === 'new' ? '近期高星新项目' : `近期发布 ${item.release?.tag_name || '重要版本'}`,
          release:item.release ? {tag_name:item.release.tag_name,published_at:item.release.published_at,name:item.release.name,html_url:item.release.html_url,has_assets:Array.isArray(item.release.assets) && item.release.assets.length > 0} : null,
          attention_category:fallback.attention_category,
          attention_score:fallback.attention_score,
          quality_score:fallback.quality_score,
          evidence_quotes:[],
          heat_score:heat,
          candidate_kind:item.kind
        }];
      });
    }

    const newItems = scored.filter(item=>item.candidate_kind === 'new').sort((a,b)=>b.heat_score-a.heat_score);
    const releaseItems = scored.filter(item=>item.candidate_kind === 'release').sort((a,b)=>b.heat_score-a.heat_score);
    const items = [];
    while (items.length < 24 && (newItems.length || releaseItems.length)) {
      for (let index = 0; index < 2 && newItems.length && items.length < 24; index++) items.push(newItems.shift());
      if (releaseItems.length && items.length < 24) items.push(releaseItems.shift());
    }
    for (const item of items) delete item.candidate_kind;

    return res.status(200).json({items,page,next_page:page + 1,has_more:page < 5,method:'recent_high_star_or_release_with_pm_value',classifier:classifierMode});
  } catch (error) {
    return res.status(502).json({error:'discover_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};

module.exports._test = {attentionSignal,conservativeDecisionSupported,directAttentionSignal,fallbackCopy,fallbackSummary,isResourceCollection,metadataQuality,momentumScore,popularityScore,readmeImages,recommendationEvidenceSupported,uniqueText};
