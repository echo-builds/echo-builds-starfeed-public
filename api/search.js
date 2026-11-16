const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'nvidia/nemotron-3.5-lightning-free';

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

async function askModel(req,messages,maxTokens = 900) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  const response = await fetch(GATEWAY_API,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      model:SEARCH_MODEL,
      reasoning:{effort:'none'},
      temperature:0.1,
      max_tokens:maxTokens,
      messages
    }),
    signal:AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('ai_gateway_' + response.status);
  const data = await response.json();
  const parsed = jsonFrom(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('invalid_ai_response');
  return parsed;
}

const rules = [
  [/播客|podcast/i,'podcast transcription'], [/翻译|translate|translation/i,'translation localization'],
  [/字幕|subtitle|caption/i,'subtitle caption'], [/语音|音频|录音|voice|audio/i,'audio speech'],
  [/视频|剪辑|video/i,'video editing'], [/图片|照片|image|photo/i,'image photo'],
  [/截图|screenshot/i,'screenshot'], [/原型|低代码|无代码|prototype|low.?code|no.?code/i,'prototype low-code'],
  [/设计系统|组件库|design system/i,'design-system ui-components'],
  [/工作流|自动化|workflow|automation/i,'workflow automation'], [/智能体|助手|agent/i,'ai-agent assistant'],
  [/知识库|文档问答|rag/i,'rag knowledge-base'], [/学习|教学|老师|教育|tutor|education/i,'education ai-tutor'],
  [/会议|笔记|meeting|notes/i,'meeting notes'], [/爬虫|抓取|crawler|scraper/i,'crawler scraper'],
  [/本地|离线|local|offline/i,'self-hosted offline'], [/手机|安卓|android|mobile/i,'android mobile'],
  [/苹果|ios|iphone/i,'ios iphone']
];

function fallbackPlan(input) {
  const terms = [];
  for (const [pattern,value] of rules) if (pattern.test(input)) terms.push(value);
  const english = input.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  terms.push(...english.filter(word=>!['github','project','projects','find','want','open','source'].includes(word)));
  const query = [...new Set(terms)].slice(0,4).join(' ') || input;
  return {intent:input,queries:[query],mode:'rules'};
}

function cleanQuery(value) {
  return String(value || '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
}

async function planSearch(req,input) {
  try {
    const plan = await askModel(req,[
      {role:'system',content:'你把中文或英文自然语言需求转换成 GitHub 仓库搜索方案。只输出 JSON：{"intent":"一句中文意图概括","queries":["英文 GitHub 搜索词"]}。queries 为 1-3 个互补的英文查询，可以包含 language:、topic:、stars: 等 GitHub qualifier，但不要包含 sort:、order:、fork:、archived:。不要机械逐字翻译；提取用户真正需要的能力、输入与输出。查询不要过严，每条尽量 2-5 个关键词。'},
      {role:'user',content:JSON.stringify({request:input})}
    ]);
    const queries = (Array.isArray(plan.queries) ? plan.queries : []).map(cleanQuery).filter(Boolean).slice(0,3);
    if (!queries.length) throw new Error('empty_queries');
    return {intent:cleanQuery(plan.intent) || input,queries,mode:'ai'};
  } catch (error) {
    return {...fallbackPlan(input),aiFallbackReason:String(error?.message || 'ai_unavailable').slice(0,80)};
  }
}

function githubHeaders(token) {
  return {
    Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'RepoScroll',
    ...(token ? {Authorization:`Bearer ${token}`} : {})
  };
}

function shape(item) {
  const {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,html_url,license,archived,fork} = item;
  return {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,html_url,license,archived,fork};
}

async function githubSearch(query,token) {
  const q = `${cleanQuery(query)} in:name,description,readme archived:false fork:false`;
  const params = new URLSearchParams({q,sort:'stars',order:'desc',per_page:'30'});
  const response = await fetch(`${GITHUB_API}/search/repositories?${params}`,{
    headers:githubHeaders(token),signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('github_' + response.status);
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function addChineseCopy(req,input,items) {
  if (!items.length) return items;
  try {
    const candidates = items.slice(0,24).map(item=>({
      full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count
    }));
    const result = await askModel(req,[
      {role:'system',content:'你为 GitHub 项目搜索结果写中文卡片。只输出 JSON：{"items":[{"full_name":"owner/repo","title":"一句中文标题","summary":"一句中文说明"}]}。保持输入顺序和 full_name，不增加项目。title 说明用户用它做什么，不要复述仓库名；summary 结合用户需求说明核心能力，必须客观，不虚构。每项都只写一句，避免营销话术。'},
      {role:'user',content:JSON.stringify({request:input,candidates})}
    ],2400);
    const copy = new Map((Array.isArray(result.items) ? result.items : []).map(item=>[String(item.full_name || '').toLowerCase(),item]));
    return items.map(item=>{
      const text = copy.get(String(item.full_name).toLowerCase());
      return text ? {...item,ai_title:cleanQuery(text.title).slice(0,44),ai_summary:cleanQuery(text.summary).slice(0,120)} : item;
    });
  } catch {
    return items;
  }
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'POST') return res.status(405).json({error:'method_not_allowed'});
  const input = String(req.body?.query || '').trim().slice(0,240);
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
    const merged = new Map();
    for (const batch of batches) if (batch.status === 'fulfilled') {
      for (const item of batch.value) if (item?.full_name && !item.archived && !item.fork) merged.set(item.full_name.toLowerCase(),shape(item));
    }
    let items = [...merged.values()].sort((a,b)=>Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,24);
    if (!items.length && batches.every(batch=>batch.status === 'rejected')) return res.status(502).json({error:'github_unavailable'});
    if (plan.mode === 'ai') items = await addChineseCopy(req,input,items);
    return res.status(200).json({mode:plan.mode,intent:plan.intent,queries:plan.queries,diagnostic:plan.aiFallbackReason || null,items});
  } catch {
    return res.status(502).json({error:'search_unavailable'});
  }
};
