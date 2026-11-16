const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'nvidia/nemotron-3.5-lightning-free';
const MAX_CANDIDATES = 24;

function jsonFrom(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try { return JSON.parse(source); } catch {
    const match = source.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

function clean(value,limit = 240) {
  return String(value || '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
}

function aiToken(req) {
  return process.env.AI_GATEWAY_API_KEY || req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN || '';
}

async function askModel(req,messages,maxTokens = 1200) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(GATEWAY_API,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:SEARCH_MODEL,reasoning:{effort:'none'},temperature:0.1,max_tokens:maxTokens,messages}),
      signal:AbortSignal.timeout(25000)
    });
    if (response.ok || ![429,502,503,504].includes(response.status) || attempt === 3) break;
    const retryAfter = Math.min(7000,Math.max(1500,Number(response.headers.get('retry-after') || attempt + 1) * 1000));
    await new Promise(resolve=>setTimeout(resolve,retryAfter));
  }
  if (!response.ok) throw new Error('ai_gateway_' + response.status);
  const data = await response.json();
  const parsed = jsonFrom(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('invalid_ai_response');
  return parsed;
}

function listText(value) {
  if (typeof value === 'string' || typeof value === 'number') return clean(value,220);
  if (!value || typeof value !== 'object') return '';
  const candidate = value.query ?? value.search_query ?? value.github_query ?? value.q ?? value.search ?? value.keywords ?? value.value ?? value.text ?? value.name ?? value.capability ?? value.constraint ?? value.term ?? value.terms ?? value.evidence_quote ?? value.quote;
  if (Array.isArray(candidate)) return clean(candidate.join(' '),220);
  return typeof candidate === 'string' || typeof candidate === 'number' ? clean(candidate,220) : '';
}

function unique(values,limit) {
  const list = Array.isArray(values) ? values : values && typeof values === 'object' ? Object.values(values) : values == null ? [] : [values];
  return [...new Set(list.map(listText).filter(Boolean))].slice(0,limit);
}

function capabilityChecks(values) {
  const list = Array.isArray(values) ? values : values && typeof values === 'object' ? Object.values(values) : values == null ? [] : [values];
  return list.map(value=>{
    if (typeof value === 'string' || typeof value === 'number') return {name:clean(value,100),evidence_terms:[]};
    if (!value || typeof value !== 'object') return null;
    const name = clean(value.name ?? value.capability ?? value.label ?? value.value,100);
    const evidenceTerms = unique(value.evidence_terms ?? value.terms ?? value.keywords ?? value.search_terms,8);
    return name ? {name,evidence_terms:evidenceTerms} : null;
  }).filter(Boolean).slice(0,8);
}

function focusedTerm(value) {
  const tokens = [...tokenSet(value)].filter(token=>token.length > 2);
  return tokens.slice(-2).join(' ');
}

function complementaryQueries(plan) {
  const queries = [...(Array.isArray(plan?.queries) ? plan.queries : [])];
  const checks = (Array.isArray(plan?.capability_checks) ? plan.capability_checks : []).filter(check=>check?.name);
  const frequencies = new Map();
  for (const check of checks) for (const token of tokenSet(check.name)) frequencies.set(token,(frequencies.get(token) || 0) + 1);
  const anchor = [...frequencies.entries()].sort((a,b)=>b[1]-a[1] || b[0].length-a[0].length).find(([,count])=>count > 1)?.[0] || '';
  for (let left = 0; left < checks.length; left++) {
    for (let right = left + 1; right < checks.length; right++) {
      const leftTerms = unique(checks[left].evidence_terms,8).map(focusedTerm).filter(Boolean).sort((a,b)=>a.split(' ').length-b.split(' ').length);
      const rightTerms = unique(checks[right].evidence_terms,8).map(focusedTerm).filter(Boolean).sort((a,b)=>a.split(' ').length-b.split(' ').length);
      if (leftTerms[0] && rightTerms[0]) queries.unshift(clean(`${anchor} ${leftTerms[0]} ${rightTerms[0]}`,120));
      if (leftTerms[0] && rightTerms.at(-1)) queries.unshift(clean(`${anchor} ${leftTerms[0]} ${rightTerms.at(-1)}`,120));
    }
  }
  return unique(queries,7);
}

function fallbackPlan(input) {
  const normalized = clean(input,220);
  const fragments = normalized
    .split(/[，,。；;：:\n]|\b(?:and|with|without|that|which|for)\b|以及|并且|同时|最好|希望|想要|需要/iu)
    .map(value=>value.replace(/^(?:请|帮我|给我|找|找一个|搜索|查找)\s*/u,'').trim())
    .filter(value=>value.length >= 2);
  const english = normalized.toLowerCase().match(/[a-z][a-z0-9.+#-]{1,}/g) || [];
  const ignored = new Set(['github','repo','repository','repositories','project','projects','open','source','find','want','need','tool','tools']);
  const englishTerms = english.filter(term=>!ignored.has(term));
  const queries = [];
  if (englishTerms.length) {
    queries.push(englishTerms.slice(0,5).join(' '));
    if (englishTerms.length > 3) queries.push(englishTerms.slice(0,3).join(' '));
  }
  queries.push(...fragments.slice(0,4));
  if (!queries.length) queries.push(normalized);
  return {intent:normalized,goal:normalized,core_capabilities:[],constraints:[],queries:unique(queries,5),mode:'fallback'};
}

async function planSearch(req,input) {
  try {
    const plan = await askModel(req,[
      {role:'system',content:'你把自然语言需求转换成通用的 GitHub 仓库检索计划。只输出 JSON：{"intent":"一句中文意图","goal":"最终要完成的任务","core_capabilities":[{"name":"必须能力","evidence_terms":["README 中可能出现的英文术语或短语"]}],"constraints":["限制条件"],"queries":["英文 GitHub 搜索词"]}。queries 和 constraints 必须是字符串数组。core_capabilities 必须把每项不可缺少的能力单独列出，并为每项给出 2-6 个可在 Description、Topics 或 README 中核验的英文术语、同义词或短语；不要把只属于偏好或质量判断的词列为必须能力。先识别目标、输入、期望输出、核心能力和限制条件，再生成 3-5 组互补查询。查询应分别覆盖核心能力、常见技术术语、输入输出关系、产品形态或关键限制，不要把所有条件塞进一条查询。不要预设领域，不要使用针对某个具体场景的固定模板，也不要因为用户提到熟悉品牌就只搜索品牌名。主观词要转换成 README 可核验的能力或指标。每条查询保留 1-4 个高辨识度概念，可使用 language:、topic:、stars:，不得使用 sort:、order:、fork:、archived:。'},
      {role:'user',content:JSON.stringify({request:input})}
    ],1800);
    const queries = unique(plan.queries ?? plan.search_queries ?? plan.github_queries ?? plan.search_strategies ?? plan.strategies,5);
    if (!queries.length) throw new Error('empty_queries');
    const checks = capabilityChecks(plan.core_capabilities ?? plan.capabilities ?? plan.must_haves);
    const shaped = {
      intent:clean(plan.intent) || input,
      goal:clean(plan.goal) || clean(plan.intent) || input,
      core_capabilities:checks.map(item=>item.name),
      capability_checks:checks,
      constraints:unique(plan.constraints ?? plan.requirements ?? plan.limitations,8),
      queries,
      mode:'ai'
    };
    shaped.queries = complementaryQueries(shaped);
    return shaped;
  } catch (error) {
    return {...fallbackPlan(input),aiFallbackReason:String(error?.message || 'ai_unavailable').slice(0,80)};
  }
}

function githubHeaders(token) {
  return {Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll',...(token ? {Authorization:`Bearer ${token}`} : {})};
}

function shape(item) {
  const {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,pushed_at,html_url,license,archived,fork,default_branch} = item;
  return {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,pushed_at,html_url,license,archived,fork,default_branch};
}

async function githubSearch(query,token) {
  const cleaned = clean(query,220);
  const scope = /\bin:/.test(cleaned) ? '' : ' in:name,description,readme,topics';
  const q = `${cleaned}${scope} archived:false fork:false`;
  const params = new URLSearchParams({q,per_page:'35'});
  const response = await fetch(`${GITHUB_API}/search/repositories?${params}`,{headers:githubHeaders(token),signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('github_' + response.status);
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

function markdownText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/[#>*_`|~]/g,' ');
}

function evidenceCoverage(value,checks) {
  const source = new Set([...tokenSet(value)].map(stemToken));
  let matchedGroups = 0;
  let matchedTerms = 0;
  for (const check of Array.isArray(checks) ? checks : []) {
    let groupMatched = false;
    for (const term of Array.isArray(check?.evidence_terms) ? check.evidence_terms : []) {
      const terms = [...tokenSet(term)].map(stemToken);
      if (!terms.length) continue;
      const matched = terms.filter(token=>source.has(token)).length;
      if (matched >= Math.max(1,Math.ceil(terms.length * .66))) {
        groupMatched = true;
        matchedTerms += matched;
      }
    }
    if (groupMatched) matchedGroups++;
  }
  return matchedGroups * 10 + matchedTerms;
}

function selectReadmeExcerpt(raw,checks) {
  const paragraphs = markdownText(raw).split(/\n\s*\n|\r?\n(?=\s*[-+•]|\s*\d+[.)]\s)/)
    .map(value=>clean(value,700)).filter(value=>value.length >= 20);
  if (!paragraphs.length) return '';
  const scored = paragraphs.map((value,index)=>({value,index,score:evidenceCoverage(value,checks)}));
  const selected = new Map();
  for (const entry of scored.slice(0,2)) selected.set(entry.index,entry.value);
  for (const entry of scored.sort((a,b)=>b.score-a.score || a.index-b.index).slice(0,8)) if (entry.score > 0) selected.set(entry.index,entry.value);
  return clean([...selected.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value).join(' '),3200);
}

async function readmeExcerpt(item,checks) {
  const branch = encodeURIComponent(item.default_branch || 'main');
  const path = String(item.full_name || '').split('/').map(encodeURIComponent).join('/');
  if (!path.includes('/')) return '';
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${path}/${branch}/README.md`,{signal:AbortSignal.timeout(6000)});
    if (!response.ok) return '';
    return selectReadmeExcerpt(await response.text(),checks);
  } catch { return ''; }
}

async function withReadmes(items,checks) {
  const excerpts = await Promise.all(items.map(item=>readmeExcerpt(item,checks)));
  return items.map((item,index)=>({...item,readme_excerpt:excerpts[index]}));
}

function tokenSet(value) {
  const text = String(value || '').toLowerCase().replace(/[-_/]+/g,' ');
  const words = text.match(/[a-z0-9][a-z0-9.+#]{1,}|[㐀-鿿]{2,8}/gu) || [];
  const ignored = new Set(['github','repo','repository','project','projects','open','source','tool','tools','一个','项目','工具','可以','支持','需要','希望']);
  return new Set(words.filter(word=>!ignored.has(word)));
}

function stemToken(value) {
  const token = String(value || '').toLowerCase();
  if (token.length <= 4) return token;
  if (/cing$/.test(token)) return token.slice(0,-3) + 'e';
  if (/ing$/.test(token)) return token.slice(0,-3).replace(/(.)\1$/,'$1');
  if (/ies$/.test(token)) return token.slice(0,-3) + 'y';
  if (/ed$/.test(token)) return token.slice(0,-2).replace(/(.)\1$/,'$1');
  if (/es$/.test(token)) return token.slice(0,-2);
  if (/s$/.test(token)) return token.slice(0,-1);
  return token;
}

function capabilityEvidenceSupported(item,checks) {
  const required = (Array.isArray(checks) ? checks : []).filter(check=>Array.isArray(check?.evidence_terms) && check.evidence_terms.length);
  if (!required.length) return true;
  const sourceTokens = new Set([...tokenSet(`${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`)].map(stemToken));
  return required.every(check=>check.evidence_terms.some(term=>{
    const tokens = [...tokenSet(term)].map(stemToken);
    if (!tokens.length) return false;
    const matched = tokens.filter(token=>sourceTokens.has(token)).length;
    return matched >= Math.max(1,Math.ceil(tokens.length * .66));
  }));
}

function activityScore(item) {
  const date = Date.parse(item.pushed_at || item.updated_at || item.created_at || 0);
  if (!Number.isFinite(date)) return 0;
  const days = Math.max(0,(Date.now() - date) / 86400000);
  return Math.max(0,100 - Math.log2(days + 1) * 14);
}

function popularityScore(item) {
  return Math.max(0,Math.min(100,Math.log10(Math.max(1,Number(item.stargazers_count || 0))) * 22));
}

function metadataQuality(item) {
  let score = 20;
  if (item.description) score += 18;
  if (item.readme_excerpt?.length > 300) score += 22;
  if (item.homepage) score += 10;
  if (item.license?.spdx_id && !['NOASSERTION','OTHER'].includes(item.license.spdx_id)) score += 10;
  if (Number(item.forks_count || 0) >= 10) score += 10;
  if (Array.isArray(item.topics) && item.topics.length) score += 10;
  return Math.min(100,score);
}

function evidenceSupported(item,quotes) {
  const source = clean(`${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`,100000).toLowerCase();
  const normalized = unique(Array.isArray(quotes) ? quotes : [],3).map(quote=>quote.toLowerCase()).filter(quote=>quote.length >= 6);
  return normalized.length > 0 && normalized.every(quote=>source.includes(quote));
}

function capabilityClaimsSupported(item,requiredNames,claims) {
  const required = unique(Array.isArray(requiredNames) ? requiredNames : [],8).map(name=>name.toLowerCase());
  if (!required.length) return true;
  const entries = (Array.isArray(claims) ? claims : []).map(claim=>({
    capability:clean(claim?.capability,100).toLowerCase(),
    quote:clean(claim?.evidence_quote ?? claim?.quote,220)
  })).filter(claim=>claim.capability && claim.quote);
  return required.every(name=>{
    const claim = entries.find(entry=>entry.capability === name);
    return Boolean(claim && evidenceSupported(item,[claim.quote]));
  });
}

function fallbackRank(plan,items) {
  const needTokens = tokenSet([plan.goal,plan.intent,...plan.core_capabilities,...plan.constraints,...plan.queries].join(' '));
  const queryTokenSets = plan.queries.map(tokenSet).filter(tokens=>tokens.size);
  return items.map(item=>{
    const primary = `${item.full_name} ${item.description || ''} ${(item.topics || []).join(' ')}`;
    const source = `${primary} ${item.readme_excerpt || ''}`;
    const primaryTokens = tokenSet(primary);
    const sourceTokens = tokenSet(source);
    let overlap = 0;
    let primaryOverlap = 0;
    for (const token of needTokens) if (sourceTokens.has(token) || source.toLowerCase().includes(token)) overlap++;
    for (const token of needTokens) if (primaryTokens.has(token) || primary.toLowerCase().includes(token)) primaryOverlap++;
    let bestQueryCoverage = 0;
    let bestPrimaryCoverage = 0;
    for (const queryTokens of queryTokenSets) {
      let matched = 0;
      let primaryMatched = 0;
      for (const token of queryTokens) if (sourceTokens.has(token) || source.toLowerCase().includes(token)) matched++;
      for (const token of queryTokens) if (primaryTokens.has(token) || primary.toLowerCase().includes(token)) primaryMatched++;
      bestQueryCoverage = Math.max(bestQueryCoverage,matched / queryTokens.size);
      bestPrimaryCoverage = Math.max(bestPrimaryCoverage,primaryMatched / queryTokens.size);
    }
    const overallCoverage = needTokens.size ? overlap / needTokens.size : 0;
    const primaryCoverage = needTokens.size ? primaryOverlap / needTokens.size : 0;
    const wantsCollection = /合集|列表|目录|资源|collection|curated list|awesome list|directory/i.test(`${plan.intent} ${plan.goal}`);
    const isCollection = /^awesome[-_]/i.test(item.name || '') || /curated (?:list|collection)|awesome list/i.test(item.description || '');
    const collectionPenalty = isCollection && !wantsCollection ? 25 : 0;
    const relevance = Math.max(0,Math.min(92,32 + bestPrimaryCoverage * 40 + bestQueryCoverage * 20 + primaryCoverage * 15 + overallCoverage * 8 - collectionPenalty));
    const quality = metadataQuality(item);
    const rank = relevance * .72 + quality * .12 + activityScore(item) * .08 + popularityScore(item) * .08;
    const {readme_excerpt,...repo} = item;
    const original = clean(item.description,150);
    const chinese = /[㐀-鿿]/.test(original);
    return {...repo,relevance_score:relevance,quality_score:quality,rank_score:rank,ai_title:item.name,ai_summary:chinese ? original : (original ? `仓库原始说明：${original}` : '该候选项目缺少可核验的仓库简介，请进入 README 确认具体能力。'),ai_bullets:[]};
  }).filter(item=>item.relevance_score >= 52).sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,10);
}

async function rankAndDescribe(req,input,plan,items) {
  const eligible = items.filter(item=>capabilityEvidenceSupported(item,plan.capability_checks));
  if (!eligible.length) return [];
  const candidates = eligible.map(item=>({full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count,forks:item.forks_count,homepage:item.homepage,pushed_at:item.pushed_at,readme_excerpt:clean(item.readme_excerpt,1400)}));
  let result;
  try {
    result = await askModel(req,[
      {role:'system',content:'你负责按用户真实任务筛选和排序 GitHub 仓库。只输出 JSON：{"items":[{"full_name":"owner/repo","relevant":true,"relevance_score":0,"evidence_score":0,"quality_score":0,"title":"中文标题","summary":"中文说明","bullets":["能力证据"],"evidence_quotes":["从 Description、Topics 或 README 原样复制的短句"],"capability_evidence":[{"capability":"与 core_capabilities 完全相同的名称","evidence_quote":"直接证明该项目提供此能力的原文"}]}]}。只返回真正相关且 relevance_score>=60 的项目，不要为不相关候选返回占位项；full_name 必须来自输入且不得修改。每个入选项目必须为每一项 core_capabilities 返回一条 capability_evidence，capability 名称必须与输入完全一致，evidence_quote 必须逐字复制资料原文并直接证明项目本身提供这项能力。教程、课程、资源合集或示例仅仅提到某项能力，不等于项目提供可使用的解决方案；除非用户明确要教程或合集，否则不要入选。每个入选项目还必须给出 1-3 条 evidence_quotes，逐字复制输入资料中的原文、不得翻译或改写，并直接支持 summary 中的全部能力判断。缺少任一关键能力的明确证据就不要返回该项目；相邻能力不能替代用户要求，例如规划、测试或代码审查不能证明具备调用链追踪。第一优先级是核心需求匹配：项目的主要输入、输出和能力必须真正帮助完成用户目标，仅有相邻关键词不算匹配。relevance_score 表示需求匹配程度；evidence_score 表示资料对关键能力的证据充分度；quality_score 表示文档、维护、可体验性和项目完成度。Star 与活跃度只能辅助排序，不能掩盖不相关。title 要直接说明项目解决的问题或提供的能力；summary 用具体自然的中文说明实际问题、解决方案和值得关注的新意，不堆术语。不得声称资料没有明确提供的功能。对技术项目可以解释可能带来的产品价值，但必须使用“可用于”“可能帮助”等措辞区分推测与事实。bullets 最多 2 条，只写资料可核验的能力。'},
      {role:'user',content:JSON.stringify({request:input,interpretation:{goal:plan.goal,core_capabilities:plan.core_capabilities,capability_checks:plan.capability_checks,constraints:plan.constraints},candidates})}
    ],4800);
  } catch {
    return fallbackRank(plan,eligible);
  }
  const assessed = new Map();
  for (const item of Array.isArray(result.items) ? result.items : []) assessed.set(String(item.full_name || '').toLowerCase(),item);
  return eligible.flatMap(item=>{
    const decision = assessed.get(String(item.full_name || '').toLowerCase());
    const relevance = Math.max(0,Math.min(100,Number(decision?.relevance_score || 0)));
    const evidence = Math.max(0,Math.min(100,Number(decision?.evidence_score || 0)));
    const quality = Math.max(0,Math.min(100,Number(decision?.quality_score || metadataQuality(item))));
    const evidenceQuotes = unique(Array.isArray(decision?.evidence_quotes) ? decision.evidence_quotes : [],3);
    const capabilityEvidence = Array.isArray(decision?.capability_evidence) ? decision.capability_evidence : [];
    if (!decision || decision.relevant === false || relevance < 60 || evidence < 35 || !evidenceSupported(item,evidenceQuotes) || !capabilityClaimsSupported(item,plan.core_capabilities,capabilityEvidence)) return [];
    const rank = relevance * .72 + evidence * .12 + quality * .08 + activityScore(item) * .04 + popularityScore(item) * .04;
    const {readme_excerpt,...repo} = item;
    return [{...repo,relevance_score:relevance,evidence_score:evidence,quality_score:quality,rank_score:rank,ai_title:clean(decision.title,60) || item.name,ai_summary:clean(decision.summary,180),ai_bullets:unique(Array.isArray(decision.bullets) ? decision.bullets : [],2),evidence_quotes:evidenceQuotes}];
  }).sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,16);
}

async function describeItems(req,items) {
  if (!items.length) return [];
  const candidates = items.map(item=>({full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count,homepage:item.homepage}));
  const result = await askModel(req,[
    {role:'system',content:'你为 GitHub 项目信息流写准确、具体、易懂的中文介绍。只输出 JSON：{"items":[{"full_name":"owner/repo","title":"中文标题","summary":"中文说明"}]}。必须保持输入顺序和 full_name。title 直接说明项目解决什么问题或提供什么能力；summary 用一句话说明实际问题、解决方案和有证据的新意。不要堆砌术语，不写空泛的“AI 工具”“值得关注”，不得编造资料未提供的功能。技术项目如需解释产品价值，必须使用“可用于”或“可能帮助”区分推测。'},
    {role:'user',content:JSON.stringify({candidates})}
  ],4000);
  const copy = new Map((Array.isArray(result.items) ? result.items : []).map(item=>[String(item.full_name || '').toLowerCase(),item]));
  return items.map(item=>{
    const text = copy.get(String(item.full_name || '').toLowerCase());
    return text ? {...item,ai_title:clean(text.title,60),ai_summary:clean(text.summary,180)} : item;
  });
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'POST') return res.status(405).json({error:'method_not_allowed'});
  if (req.body?.mode === 'describe') {
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).filter(item=>item && typeof item.full_name === 'string').slice(0,32).map(shape);
    if (!items.length) return res.status(400).json({error:'items_required'});
    try { return res.status(200).json({items:await describeItems(req,items)}); }
    catch { return res.status(502).json({error:'description_unavailable'}); }
  }

  const input = clean(req.body?.query,240);
  if (!input) return res.status(400).json({error:'query_required'});
  try {
    let token = '';
    const stored = getSession(req);
    if (stored) {
      const auth = await refreshSession(stored);
      if (auth.session) {
        token = auth.session.accessToken;
        if (auth.refreshed) setSession(res,auth.session);
      }
    }

    const plan = await planSearch(req,input);
    const batches = await Promise.allSettled(plan.queries.map(query=>githubSearch(query,token)));
    const all = new Map();
    const diversified = new Map();
    for (const batch of batches) if (batch.status === 'fulfilled') {
      for (const item of batch.value) if (item?.full_name && !item.archived && !item.fork) all.set(item.full_name.toLowerCase(),shape(item));
      for (const item of batch.value.slice(0,8)) if (item?.full_name && !item.archived && !item.fork) diversified.set(item.full_name.toLowerCase(),shape(item));
    }
    const remainder = [...all.values()].sort((a,b)=>Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0));
    for (const item of remainder) if (diversified.size < MAX_CANDIDATES) diversified.set(item.full_name.toLowerCase(),item);
    const candidates = [...diversified.values()].slice(0,MAX_CANDIDATES);
    if (!candidates.length && batches.every(batch=>batch.status === 'rejected')) return res.status(502).json({error:'github_unavailable'});
    const hydrated = await withReadmes(candidates,plan.capability_checks);
    const eligibleCount = hydrated.filter(item=>capabilityEvidenceSupported(item,plan.capability_checks)).length;
    const items = await rankAndDescribe(req,input,plan,hydrated);
    return res.status(200).json({mode:plan.mode,intent:plan.intent,interpretation:{goal:plan.goal,core_capabilities:plan.core_capabilities,capability_checks:plan.capability_checks,constraints:plan.constraints},queries:plan.queries,diagnostic:plan.aiFallbackReason || null,diagnostic_counts:{candidates:candidates.length,eligible:eligibleCount,returned:items.length},items});
  } catch (error) {
    return res.status(502).json({error:'search_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};

module.exports._test = {activityScore,capabilityChecks,capabilityClaimsSupported,capabilityEvidenceSupported,complementaryQueries,evidenceCoverage,evidenceSupported,fallbackPlan,fallbackRank,listText,metadataQuality,popularityScore,selectReadmeExcerpt,stemToken,tokenSet,unique};
