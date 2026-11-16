const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const SEARCH_MODEL = process.env.SEARCH_MODEL || 'nvidia/nemotron-3.5-lightning-free';
const TTS_QUERIES = ['TTS','text-to-speech','speech synthesis'];

function isTtsRequest(input) {
  return /配音|语音合成|文字转语音|文本转语音|text.?to.?speech|\btts\b/i.test(input);
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

async function askModel(req,messages,maxTokens = 900) {
  const token = aiToken(req);
  if (!token) throw new Error('ai_unavailable');
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(GATEWAY_API,{
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:SEARCH_MODEL,
        reasoning:{effort:'none'},
        temperature:0.1,
        max_tokens:maxTokens,
        messages
      }),
      signal:AbortSignal.timeout(15000)
    });
    if (response.status !== 429 || attempt > 0) break;
    const retryAfter = Math.min(2500,Math.max(800,Number(response.headers.get('retry-after') || 1) * 1000));
    await new Promise(resolve=>setTimeout(resolve,retryAfter));
  }
  if (!response.ok) throw new Error('ai_gateway_' + response.status);
  const data = await response.json();
  const parsed = jsonFrom(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('invalid_ai_response');
  return parsed;
}

const rules = [
  [/配音|语音合成|文字转语音|文本转语音|text.?to.?speech|\btts\b/i,'text-to-speech'],
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
  if (isTtsRequest(input)) {
    return {
      intent:/中文/.test(input) ? '把中文文本转换成自然、接近真人表达的配音' : '把文本转换成自然、接近真人表达的配音',
      queries:[...TTS_QUERIES,'multi-speaker TTS','voice cloning'],
      mode:'rules'
    };
  }
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
      {role:'system',content:'你把中文或英文自然语言需求转换成 GitHub 仓库检索方案。只输出 JSON：{"intent":"一句中文意图概括","queries":["英文 GitHub 搜索词"]}。先判断用户最终想得到的输出和核心能力，不要机械逐字翻译。queries 给出 3-5 个互补召回，每条只保留 1-3 个核心概念或常见项目术语；用同义词和不同使用场景拆成不同查询，不要把所有条件 AND 在同一条查询里。主观质量词（如自然、去 AI 感、好用）不要直接作为搜索词，应转成 README 可核验的能力，例如 prosody、pause control、emotion instruction、multi-speaker、voice cloning、demo。已知品牌名不能作为首轮搜索词。可以包含 language:、topic:、stars:，但不要包含 sort:、order:、fork:、archived:。例如“中文配音，去 AI 感”应分别召回 Mandarin text-to-speech、expressive TTS prosody、multi-speaker dialogue TTS、podcast dubbing，而不是 translation audio。'},
      {role:'user',content:JSON.stringify({request:input})}
    ]);
    let queries = (Array.isArray(plan.queries) ? plan.queries : []).map(cleanQuery).filter(Boolean);
    if (isTtsRequest(input)) queries = [...TTS_QUERIES,...queries];
    queries = [...new Set(queries)].slice(0,5);
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
  const {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,html_url,license,archived,fork,default_branch} = item;
  return {full_name,name,description,stargazers_count,forks_count,topics,homepage,created_at,updated_at,html_url,license,archived,fork,default_branch};
}

async function githubSearch(query,token) {
  const cleaned = cleanQuery(query);
  const scope = /\bin:/.test(cleaned) ? '' : ' in:name,description,topics';
  const q = `${cleaned}${scope} archived:false fork:false`;
  const params = new URLSearchParams({q,sort:'stars',order:'desc',per_page:'40'});
  const response = await fetch(`${GITHUB_API}/search/repositories?${params}`,{
    headers:githubHeaders(token),signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('github_' + response.status);
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function readmeExcerpt(item) {
  const branch = encodeURIComponent(item.default_branch || 'main');
  const path = String(item.full_name || '').split('/').map(encodeURIComponent).join('/');
  if (!path.includes('/')) return '';
  try {
    const response = await fetch(`https://raw.githubusercontent.com/${path}/${branch}/README.md`,{signal:AbortSignal.timeout(5000)});
    if (!response.ok) return '';
    return String(await response.text()).replace(/<[^>]+>/g,' ').replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
  } catch { return ''; }
}

async function withReadmes(items) {
  const excerpts = await Promise.all(items.map(readmeExcerpt));
  return items.map((item,index)=>({...item,readme_excerpt:excerpts[index]}));
}

function fallbackRank(input,items) {
  const wantsTts = isTtsRequest(input);
  return items.flatMap(item=>{
    const text = `${item.full_name} ${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`.toLowerCase();
    const primary = `${item.name || ''} ${(item.topics || []).join(' ')}`.toLowerCase();
    let relevance = 58;
    if (wantsTts) {
      const matches = /text[- ]to[- ]speech|speech synthesis|\btts\b|voice clon|dubbing|audio generation|fish.?speech|indextts|qwen.*tts|moss.?tts/.test(text);
      const primaryMatch = /tts|text.?to.?speech|speech|voice|dubb|audio.?book/.test(primary);
      const wrongDirection = /speech[- ]to[- ]text|transcrib|automatic speech recognition|\basr\b/.test(text) && !matches;
      const supportsChinese = /chinese|mandarin|中文|multilingual/.test(text);
      if (!matches || !primaryMatch || wrongDirection || (/中文/.test(input) && !supportsChinese)) return [];
      relevance = 76 + (supportsChinese ? 8 : 0) + (/expressive|emotion|prosody|pause|natural|multi.?speaker|voice clon|demo/.test(text) ? 7 : 0);
    }
    const evidence = wantsTts ? (/chinese|mandarin|中文/.test(text) ? 5 : 0) + (/expressive|emotion|prosody|pause|duration control|instruction/.test(text) ? 7 : 0) + (/multi.?speaker|dialogue|podcast/.test(text) ? 5 : 0) + (/demo|audio sample|试听/.test(text) ? 3 : 0) : 0;
    const rank = relevance + evidence + Math.min(18,Math.log10(Math.max(1,Number(item.stargazers_count || 0))) * 3.6);
    const {readme_excerpt,...repo} = item;
    const ai_title = wantsTts ? `${item.name}：${/multi.?speaker|dialogue|podcast/.test(text) ? '多角色配音' : '自然语音合成'}` : undefined;
    const ai_summary = wantsTts ? `可将文本生成语音${/chinese|mandarin|中文/.test(text) ? '，支持中文' : ''}${/expressive|emotion|prosody|pause|instruction/.test(text) ? '，并提供语气、情感或韵律控制' : ''}${/voice clon/.test(text) ? '，支持声音克隆' : ''}。` : undefined;
    return [{...repo,relevance_score:relevance,rank_score:rank,ai_title,ai_summary}];
  }).sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,16);
}

async function rankAndDescribe(req,input,items) {
  if (!items.length) return items;
  const candidates = items.map(item=>({
    full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count,readme_excerpt:item.readme_excerpt
  }));
  let result;
  try { result = await askModel(req,[
    {role:'system',content:'你负责把 GitHub 候选项目按用户真实任务重新筛选和排序。只输出 JSON：{"items":[{"full_name":"owner/repo","relevant":true,"relevance_score":0,"title":"一句中文标题","summary":"一句中文说明","bullets":["能力一","能力二"]}]}。必须为输入中的每个项目返回一项，full_name 不得改。relevance_score 为 0-100，表示项目的核心输入、输出和能力与需求的匹配程度。只共享相邻关键词但不能完成目标任务的项目必须 relevant=false；例如用户要文字转配音时，纯语音转文字、聊天机器人、通用视频生成均不相关。不要因为 Star 高就放宽相关性。把用户的主观目标转成 README 证据：自然配音重点看 prosody/pause control、emotion/instruction、multi-speaker、voice cloning、中文支持与 demo；没有资料证据就不要声称具备。title 直接说明能做什么；summary 说明为何适合该需求；bullets 最多 2 个且只能来自资料。客观、不虚构、不写营销话术。'},
    {role:'user',content:JSON.stringify({request:input,candidates})}
  ],5000); } catch { return fallbackRank(input,items); }
  const copy = new Map();
  for (const item of Array.isArray(result.items) ? result.items : []) {
    copy.set(String(item.full_name || '').toLowerCase(),item);
  }
  const assessed = items.flatMap(item=>{
    const text = copy.get(String(item.full_name).toLowerCase());
    const relevance = Math.max(0,Math.min(100,Number(text?.relevance_score || 0)));
    if (!text || text.relevant === false || relevance < 62) return [];
    const source = `${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`.toLowerCase();
    const ttsEvidence = isTtsRequest(input) ? (/chinese|mandarin|中文/.test(source) ? 5 : 0) + (/expressive|emotion|prosody|pause|duration control|instruction/.test(source) ? 7 : 0) + (/multi.?speaker|dialogue|podcast/.test(source) ? 5 : 0) + (/demo|audio sample|试听/.test(source) ? 3 : 0) : 0;
    const rank = relevance + ttsEvidence + Math.min(18,Math.log10(Math.max(1,Number(item.stargazers_count || 0))) * 3.6);
    const {readme_excerpt,...repo} = item;
    return [{...repo,relevance_score:relevance,rank_score:rank,ai_title:cleanQuery(text.title).slice(0,44),ai_summary:cleanQuery(text.summary).slice(0,160),ai_bullets:(Array.isArray(text.bullets) ? text.bullets : []).map(cleanQuery).filter(Boolean).slice(0,3)}];
  });
  if (!isTtsRequest(input)) return assessed.sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,16);
  const merged = new Map(fallbackRank(input,items).map(item=>[item.full_name.toLowerCase(),item]));
  for (const item of assessed) merged.set(item.full_name.toLowerCase(),item);
  return [...merged.values()].sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,16);
}

async function describeItems(req,items) {
  if (!items.length) return [];
  const candidates = items.map(item=>({
    full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count
  }));
  const result = await askModel(req,[
    {role:'system',content:'你为 GitHub 项目信息流写准确、易懂的中文介绍。只输出 JSON：{"items":[{"full_name":"owner/repo","title":"一句中文标题","summary":"一句中文说明"}]}。必须为输入中的每个项目返回一项并保持顺序与 full_name。title 直接说明这个项目能帮用户做什么，不复述仓库名；summary 用一句话介绍用途、核心能力或适合谁。不要写 Star 数，不要写“点击查看 GitHub”，不要虚构，不用营销话术。'},
    {role:'user',content:JSON.stringify({candidates})}
  ],3500);
  const copy = new Map();
  for (const item of Array.isArray(result.items) ? result.items : []) {
    copy.set(String(item.full_name || '').toLowerCase(),item);
  }
  return items.map(item=>{
    const text = copy.get(String(item.full_name).toLowerCase());
    return text ? {...item,ai_title:cleanQuery(text.title).slice(0,44),ai_summary:cleanQuery(text.summary).slice(0,160),ai_bullets:(Array.isArray(text.bullets) ? text.bullets : []).map(cleanQuery).filter(Boolean).slice(0,3)} : item;
  });
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'POST') return res.status(405).json({error:'method_not_allowed'});
  if (req.body?.mode === 'describe') {
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).filter(item=>item && typeof item.full_name === 'string').slice(0,32).map(shape);
    if (!items.length) return res.status(400).json({error:'items_required'});
    try {
      return res.status(200).json({items:await describeItems(req,items)});
    } catch {
      return res.status(502).json({error:'description_unavailable'});
    }
  }
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
    const diversified = new Map();
    for (const batch of batches) if (batch.status === 'fulfilled') {
      for (const item of batch.value) if (item?.full_name && !item.archived && !item.fork) merged.set(item.full_name.toLowerCase(),shape(item));
      for (const item of batch.value.slice(0,12)) if (item?.full_name && !item.archived && !item.fork) diversified.set(item.full_name.toLowerCase(),shape(item));
    }
    const remainder = [...merged.values()].sort((a,b)=>Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0));
    for (const item of remainder) if (diversified.size < 48) diversified.set(item.full_name.toLowerCase(),item);
    let items = [...diversified.values()].slice(0,48);
    if (!items.length && batches.every(batch=>batch.status === 'rejected')) return res.status(502).json({error:'github_unavailable'});
    items = await rankAndDescribe(req,input,await withReadmes(items));
    return res.status(200).json({mode:plan.mode,intent:plan.intent,queries:plan.queries,diagnostic:plan.aiFallbackReason || null,items});
  } catch {
    return res.status(502).json({error:'search_unavailable'});
  }
};
