const {getSession,refreshSession,setSession} = require('./_lib/session');

const GITHUB_API = 'https://api.github.com';
// Keep the first results and the long tail from every complementary search.
// This prevents popular infrastructure from crowding out focused products.
const MAX_CANDIDATES = 42;
const DIVERSIFIED_RANKS = [0,1,2,5,12,24,49];
const MAX_QUERY_COUNT = 5;
const RANKING_POOL_SIZE = 8;

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

const freeAI = require('./_lib/free-ai');
async function askModel(req,messages,maxTokens=1200) {
  return freeAI.generateJSON(messages,{maxTokens});
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

function expandComplexEvidence(checks) {
  if (!Array.isArray(checks) || checks.length < 3) return checks;
  return checks.map(check=>{
    const broad = [];
    for (const term of check.evidence_terms || []) {
      const words = String(term || '').match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
      for (const word of words) if (/^[A-Z]{2,6}$/.test(word) || /(?:tion|sion|ing|sis|ment)$/i.test(word)) broad.push(word);
    }
    return {...check,evidence_terms:unique([...(check.evidence_terms || []),...broad],8)};
  });
}

function focusedTerm(value) {
  const tokens = [...tokenSet(value)].filter(token=>token.length > 2);
  return tokens.slice(-2).join(' ');
}

function planQuerySpecs(plan) {
  const workflow = unique(
    plan?.workflow_queries ?? plan?.workflowQueries ?? plan?.product_queries ?? plan?.productQueries,
    2
  );
  const localized = unique(
    plan?.localized_queries ?? plan?.localizedQueries ?? plan?.native_queries ?? plan?.nativeQueries,
    1
  );
  const components = unique(
    plan?.component_queries ?? plan?.componentQueries ?? plan?.queries ?? plan?.search_queries ?? plan?.searchQueries ?? plan?.github_queries ?? plan?.githubQueries,
    2
  );
  const source = workflow.length || localized.length
    ? [
        ...workflow.map(query=>({query,kind:'workflow'})),
        ...localized.map(query=>({query,kind:'localized'})),
        ...components.map(query=>({query,kind:'component'}))
      ]
    : components.map(query=>({query,kind:'general'}));
  const seen = new Set();
  return source.filter(spec=>{
    const key = spec.query.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0,MAX_QUERY_COUNT);
}

function complementaryQueries(plan) {
  return planQuerySpecs(plan).map(spec=>spec.query);
}

function deriveCapabilitySignature(query,checks) {
  const actionTokens = normalizeGithubQuery(query).split(/\s+/).filter(token=>/^[a-z0-9+#.-]+$/i.test(token));
  const action = actionTokens.at(-1);
  const phrases = (Array.isArray(checks) ? checks : []).flatMap(check=>check.evidence_terms || []);
  const evidence = phrases.find(term=>{
    const tokens = normalizeGithubQuery(term).split(/\s+/).filter(token=>/^[a-z0-9+#.-]+$/i.test(token));
    return tokens.length >= 2 && tokens.length <= 3;
  });
  if (!action || !evidence) return '';
  const evidenceTokens = normalizeGithubQuery(evidence).split(/\s+/).filter(token=>/^[a-z0-9+#.-]+$/i.test(token));
  return unique([...evidenceTokens.slice(0,2),action],3).join(' ');
}

function normalizeAIPlan(plan,input) {
  let query_specs = planQuerySpecs(plan);
  if (!query_specs.length) throw new Error('empty_queries');
  const checks = expandComplexEvidence(capabilityChecks(plan.core_capabilities ?? plan.capabilities ?? plan.must_haves));
  const workflowIndexes = query_specs.map((spec,index)=>spec.kind === 'workflow' ? index : -1).filter(index=>index >= 0);
  if (workflowIndexes.length) {
    const derived = deriveCapabilitySignature(query_specs[workflowIndexes[0]].query,checks);
    if (derived) {
      const target = workflowIndexes[1] ?? workflowIndexes[0] + 1;
      const next = [...query_specs];
      const existing = next.findIndex(spec=>spec.query.toLowerCase() === derived.toLowerCase());
      if (existing < 0) {
        if (workflowIndexes[1] != null) next[target] = {query:derived,kind:'workflow'};
        else next.splice(target,0,{query:derived,kind:'workflow'});
        query_specs = next.slice(0,MAX_QUERY_COUNT);
      }
    }
  }
  const seenQueries = new Set();
  query_specs = query_specs.map(spec=>({...spec,query:normalizeGithubQuery(spec.query)})).filter(spec=>{
    const key = spec.query.toLowerCase();
    if (!key || seenQueries.has(key)) return false;
    seenQueries.add(key);
    return true;
  });
  return {
    intent:clean(plan.intent) || input,
    goal:clean(plan.goal) || clean(plan.intent) || input,
    core_capabilities:checks.map(item=>item.name),
    capability_checks:checks,
    constraints:unique(plan.constraints ?? plan.requirements ?? plan.limitations,8),
    queries:query_specs.map(spec=>spec.query),
    query_specs,
    mode:'ai'
  };
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
      {role:'system',content:'把用户需求转换成 GitHub 仓库检索计划，只输出一个 JSON 对象，字段必须完全如下：{"intent":"中文意图","goal":"最终任务","core_capabilities":[{"name":"必须能力","evidence_terms":["2-6个可在仓库原文中核验的中英文短语"]}],"constraints":["明确限制或主观质量要求"],"workflow_queries":["2条完整产品检索词"],"localized_queries":["1条用户语言检索词"],"component_queries":["2条补充组件检索词"]}。GitHub 用空格表示 AND，检索词越多越容易零结果；以下格式是硬性要求：每条查询只能有2-3个用空格分隔的词或短语，不得写完整句、介词、连词、源语言到目标语言的完整方向，也不得把中文概念连成一个长词。规则：1. 用户原话中的输入、整体转换、输出形态和必须条件不能遗漏；媒介必须从输入贯穿到输出，不能把音频输出降成文本。复杂任务的每个关键能力单列，不得把多个步骤合并成一项“端到端转换”。2. workflow_queries 优先召回完整产品：第一条只保留用户对象与整体动作这两个产品类别词；第二条使用完整产品通常共同具备的2-3项高辨识度能力。查询必须使用仓库作者会写的产品类别和实现词，不做字面直译：音视频跨语言转换使用 dubbing、speech translation、transcription 等类别，不使用 translator、converter；多人音频按需求使用 speaker diarization、voice cloning、multi-speaker TTS。其他领域同样改写成真实仓库术语。不得加入 AI、system、tool、platform、pipeline 等泛词。3. localized_queries 使用用户主要语言，写成2-3个以空格分隔的最短产品概念；使用可实现的动作词，不用“自然”“对话”等主观结果词替代“翻译”“配音”“合成”等实现动作。用户用英文时可为空数组。4. component_queries 一条覆盖输入处理，一条覆盖目标输出生成，只用于补充组件，不能全是底层模型。5. 每项 evidence_terms 同时覆盖真实仓库常见的英文术语；当用户不是英文提问时，再加入1-2个用户语言中的仓库常用短语。对象与动作不可分时必须同时保留，不能用宽泛 i18n 冒充菜单翻译。6. 主观要求放 constraints；自然、音质、非 AI 腔只能作为待试听验证项，不得当成已经实测。7. 只加入用户需求确实涉及的术语，不得套用固定领域关键词。输出前自检：音视频翻译若仍出现 translator 或 converter，或中文查询没有空格，必须重写。'},
      {role:'user',content:JSON.stringify({request:input})}
    ],1200);
    return normalizeAIPlan(plan,input);
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

function normalizeGithubQuery(query) {
  const source = clean(query,220)
    .replace(/\bsite:github\.com\b/ig,' ')
    .replace(/\bgithub\b/ig,' ')
    .replace(/(?:自动|自然|智能|一键|完整|高级|开源)/gu,' ');
  const simplified = source.replace(/\b(?:end[- ]to[- ]end|automated|automatic|natural|expressive|advanced|complete|full|tool|platform|pipeline|system|solution|application|with|and|for|from|into|using|to)\b/ig,' ').replace(/\s+/g,' ').trim();
  return simplified.split(/\s+/).filter(Boolean).length >= 2 ? simplified : source.replace(/\s+/g,' ').trim();
}

function githubSearchScope(kind) {
  return kind === 'workflow' || kind === 'localized'
    ? 'in:name,description,topics'
    : 'in:name,description,readme,topics';
}

async function githubSearch(query,token,kind = 'general') {
  const cleaned = normalizeGithubQuery(query);
  const scope = /\bin:/.test(cleaned) ? '' : ` ${githubSearchScope(kind)}`;
  const q = `${cleaned}${scope} archived:false fork:false`;
  const params = new URLSearchParams({q,per_page:'50'});
  const response = await fetch(`${GITHUB_API}/search/repositories?${params}`,{headers:githubHeaders(token),signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('github_' + response.status);
  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

function collectDiversifiedCandidates(results,maxCandidates = MAX_CANDIDATES,priorityQueryCount = 0) {
  const diversified = new Map();
  const fulfilled = Array.isArray(results) ? results : [];
  for (let queryIndex = 0; queryIndex < Math.min(priorityQueryCount,fulfilled.length); queryIndex++) {
    const items = fulfilled[queryIndex];
    for (let rank = 0; rank < 8; rank++) {
      const item = Array.isArray(items) ? items[rank] : null;
      if (!item?.full_name || item.archived || item.fork) continue;
      const key = item.full_name.toLowerCase();
      const previous = diversified.get(key);
      diversified.set(key,{
        ...shape(item),
        _search_query_index:Math.min(queryIndex,previous?._search_query_index ?? queryIndex),
        _search_rank:Math.min(rank,previous?._search_rank ?? rank)
      });
      if (diversified.size >= maxCandidates) return [...diversified.values()];
    }
  }
  for (const rank of DIVERSIFIED_RANKS) {
    for (const [queryIndex,items] of fulfilled.entries()) {
      const item = Array.isArray(items) ? items[rank] : null;
      if (item?.full_name && !item.archived && !item.fork) {
        const key = item.full_name.toLowerCase();
        const previous = diversified.get(key);
        diversified.set(key,{
          ...shape(item),
          _search_query_index:Math.min(queryIndex,previous?._search_query_index ?? queryIndex),
          _search_rank:Math.min(rank,previous?._search_rank ?? rank)
        });
      }
      if (diversified.size >= maxCandidates) return [...diversified.values()];
    }
  }
  // If a search returned fewer than the sampled ranks, fill remaining slots in
  // query order instead of globally by stars.
  for (let rank = 0; diversified.size < maxCandidates; rank++) {
    let found = false;
    for (const [queryIndex,items] of fulfilled.entries()) {
      const item = Array.isArray(items) ? items[rank] : null;
      if (!item) continue;
      found = true;
      if (!item.full_name || item.archived || item.fork) continue;
      const key = item.full_name.toLowerCase();
      if (!diversified.has(key)) diversified.set(key,{...shape(item),_search_query_index:queryIndex,_search_rank:rank});
      if (diversified.size >= maxCandidates) break;
    }
    if (!found) break;
  }
  return [...diversified.values()];
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
  const words = (text.match(/[a-z0-9][a-z0-9.+#]{1,}|[㐀-鿿]{2,8}/gu) || []).map(word=>word.replace(/\.+$/,''));
  const ignored = new Set(['github','repo','repository','project','projects','open','source','tool','tools','一个','项目','工具','可以','支持','需要','希望']);
  return new Set(words.filter(word=>!ignored.has(word)));
}

function stemToken(value) {
  const token = String(value || '').toLowerCase();
  if (/^translat/.test(token)) return 'translat';
  if (/^transcri/.test(token)) return 'transcript';
  if (/^synthesi|^synthesiz/.test(token)) return 'synth';
  if (/^convers/.test(token)) return 'convers';
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
  return capabilityEvidenceSupportedInText(`${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`,required);
}

function capabilityMatchCount(item,checks,primaryOnly = false) {
  const required = (Array.isArray(checks) ? checks : []).filter(check=>Array.isArray(check?.evidence_terms) && check.evidence_terms.length);
  if (!required.length) return 0;
  const source = primaryOnly
    ? `${item.full_name || ''} ${item.description || ''} ${(item.topics || []).join(' ')}`
    : `${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`;
  return required.filter(check=>capabilityEvidenceSupportedInText(source,[check])).length;
}

function minimumCapabilityCoverage(requiredCount) {
  if (requiredCount <= 1) return 1;
  if (requiredCount === 2) return .5;
  return .4;
}

function primaryRequestChecks(input,checks) {
  if (clean(input,220).length > 24) return [];
  const request = meaningUnits(input);
  const scored = (Array.isArray(checks) ? checks : []).map(check=>({check,score:[...meaningUnits(check?.name || '')].filter(unit=>request.has(unit)).length}));
  const best = Math.max(0,...scored.map(entry=>entry.score));
  return best >= 2 ? scored.filter(entry=>entry.score === best).map(entry=>entry.check) : [];
}

function capabilityEvidenceSupportedInText(sourceText,checks) {
  const required = (Array.isArray(checks) ? checks : []).filter(check=>Array.isArray(check?.evidence_terms) && check.evidence_terms.length);
  if (!required.length) return true;
  const sourceTokens = [...String(sourceText || '').toLowerCase().replace(/[-_/]+/g,' ').matchAll(/[a-z0-9][a-z0-9.+#]{1,}|[㐀-鿿]{2,8}/gu)]
    .map(match=>stemToken(match[0].replace(/\.+$/,'')));
  return required.every(check=>{
    const terms = check.evidence_terms;
    const specific = terms.filter(term=>tokenSet(term).size >= 2);
    const evidenceTerms = specific.length >= 2 ? specific : terms;
    return evidenceTerms.some(term=>{
    const compactTerm = String(term || '').replace(/[^\p{L}\p{N}]+/gu,'').toLowerCase();
    if (/[㐀-鿿]/u.test(compactTerm)) {
      const compactSource = String(sourceText || '').replace(/[^\p{L}\p{N}]+/gu,'').toLowerCase();
      if (compactTerm.length >= 2 && compactSource.includes(compactTerm)) return true;
    }
    const tokens = [...tokenSet(term)].map(stemToken);
    if (!tokens.length) return false;
    if (tokens.length === 1) return sourceTokens.includes(tokens[0]);
    const positions = tokens.map(token=>sourceTokens.flatMap((value,index)=>value === token ? [index] : []));
    if (positions.some(values=>!values.length)) return false;
    const maxWindow = Math.max(8,tokens.length * 4);
    return positions[0].some(anchor=>positions.every(values=>values.some(index=>Math.abs(index - anchor) <= maxWindow)));
    });
  });
}

function primaryCapabilityEvidenceSupported(item,checks) {
  return capabilityEvidenceSupportedInText(`${item.full_name || ''} ${item.description || ''} ${(item.topics || []).join(' ')}`,checks);
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

function cosineSimilarity(left,right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

async function withSemanticScores(input,items) {
  if (!items.length || typeof freeAI.embedTexts !== 'function') return {items,enabled:false};
  const documents = items.map(item=>clean([
    item.full_name,item.description,(item.topics || []).join(' '),item.readme_excerpt
  ].filter(Boolean).join(' '),1400));
  try {
    const vectors = await freeAI.embedTexts([input,...documents]);
    if (vectors.length !== items.length + 1) return {items,enabled:false};
    const queryVector = vectors[0];
    return {
      enabled:true,
      items:items.map((item,index)=>({...item,_semantic_score:cosineSimilarity(queryVector,vectors[index + 1])}))
    };
  } catch {
    return {items,enabled:false};
  }
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

function meaningUnits(value) {
  const text = String(value || '').toLowerCase();
  const units = new Set([...tokenSet(text)]);
  const ignored = new Set(['一个','项目','工具','支持','可以','需要','希望','开源','使用','找到','能够','最好']);
  for (const sequence of text.match(/[㐀-鿿]{2,}/gu) || []) {
    for (let index = 0; index < sequence.length - 1; index++) {
      const pair = sequence.slice(index,index + 2);
      if (!ignored.has(pair)) units.add(pair);
    }
  }
  return units;
}

function requestEvidenceSupported(input,quotes) {
  const request = meaningUnits(input);
  const evidence = meaningUnits((Array.isArray(quotes) ? quotes : []).join(' '));
  if (!request.size || !evidence.size) return false;
  const matched = [...request].filter(unit=>evidence.has(unit)).length;
  return matched >= 2 && matched / request.size >= .16;
}

function quoteMatchesCheck(quote,check) {
  const terms = Array.isArray(check?.evidence_terms) ? check.evidence_terms : [];
  if (!terms.length) return true;
  const source = new Set([...tokenSet(quote)].map(stemToken));
  return terms.some(term=>{
    const tokens = [...tokenSet(term)].map(stemToken);
    if (!tokens.length) return false;
    const matched = tokens.filter(token=>source.has(token)).length;
    return matched >= Math.max(1,Math.ceil(tokens.length * .66));
  });
}

function supportedCapabilityClaims(item,requiredValues,claims) {
  const required = (Array.isArray(requiredValues) ? requiredValues : []).map(value=>typeof value === 'string' ? {name:value,evidence_terms:[]} : value).filter(value=>value?.name).slice(0,8);
  if (!required.length) return [];
  const entries = (Array.isArray(claims) ? claims : []).map(claim=>({
    capability:clean(claim?.capability,100).toLowerCase(),
    quote:clean(claim?.evidence_quote ?? claim?.quote,220)
  })).filter(claim=>claim.capability && claim.quote);
  return required.filter((check,index)=>{
    const name = clean(check.name,100).toLowerCase();
    const nameTokens = tokenSet(name);
    const claim = entries.find(entry=>entry.capability === name) || entries.find(entry=>{
      const claimTokens = tokenSet(entry.capability);
      return [...nameTokens].some(token=>claimTokens.has(token));
    }) || (entries.length === required.length ? entries[index] : null);
    return Boolean(claim && evidenceSupported(item,[claim.quote]) && quoteMatchesCheck(claim.quote,check));
  });
}

function capabilityClaimsSupported(item,requiredValues,claims) {
  const required = (Array.isArray(requiredValues) ? requiredValues : []).map(value=>typeof value === 'string' ? {name:value,evidence_terms:[]} : value).filter(value=>value?.name).slice(0,8);
  if (!required.length) return true;
  return supportedCapabilityClaims(item,required,claims).length === required.length;
}

function wantsCollection(plan,input = '') {
  return /合集|列表|目录|资源|collection|curated list|awesome list|directory/i.test(`${input} ${plan?.intent || ''} ${plan?.goal || ''}`);
}

function isCollectionCandidate(item) {
  return /^awesome[-_]/i.test(item.name || '') || /^set of\b/i.test(item.description || '') || /curated (?:list|collection)|awesome list|collection of (?:tools|projects|resources)|resources? list/i.test(`${item.description || ''} ${String(item.readme_excerpt || '').slice(0,500)}`);
}

function wantsInstructional(plan,input = '') {
  return /教程|课程|学习资料|示例项目|教学|tutorial|course|learn|guide|example project/i.test(`${input} ${plan?.intent || ''} ${plan?.goal || ''}`);
}

function isInstructionalCandidate(item) {
  return /(?:^|[-_])(course|tutorial|workshop|learning|learn|examples?|starter[-_]?kit)(?:$|[-_])/i.test(item.name || '') || /\b(?:course|tutorial|workshop|learning resource|educational content|step-by-step guide)\b/i.test(item.description || '');
}

function buildRankingPool(scored,priorityQueryCount,size = RANKING_POOL_SIZE) {
  const selected = new Map();
  const add = entry=>{
    const key = String(entry?.item?.full_name || '').toLowerCase();
    if (key && !selected.has(key) && selected.size < size) selected.set(key,entry);
  };
  for (let queryIndex = 0; queryIndex < priorityQueryCount; queryIndex++) {
    scored.filter(entry=>Number(entry.item._search_query_index) === queryIndex)
      .sort((a,b)=>Number(b.item._semantic_score || 0)-Number(a.item._semantic_score || 0) || Number(a.item._search_rank ?? 99)-Number(b.item._search_rank ?? 99) || b.matched-a.matched)
      .slice(0,2).forEach(add);
  }
  scored.filter(entry=>entry.matched > 0).forEach(add);
  scored.filter(entry=>entry.matched === 0).forEach(add);
  return [...selected.values()];
}

function fallbackRank(plan,items,options = {}) {
  const needTokens = tokenSet([plan.goal,plan.intent,...plan.core_capabilities,...plan.constraints,...plan.queries].join(' '));
  const queryTokenSets = plan.queries.map(tokenSet).filter(tokens=>tokens.size);
  return items.filter(item=>
    (options.allowReadmeEvidence ? capabilityEvidenceSupported(item,plan.capability_checks) : primaryCapabilityEvidenceSupported(item,plan.capability_checks)) &&
    (wantsCollection(plan) || !isCollectionCandidate(item)) &&
    (wantsInstructional(plan) || !isInstructionalCandidate(item))
  ).map(item=>{
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
    const collectionPenalty = isCollectionCandidate(item) && !wantsCollection(plan) ? 25 : 0;
    const relevance = Math.max(0,Math.min(92,32 + bestPrimaryCoverage * 40 + bestQueryCoverage * 20 + primaryCoverage * 15 + overallCoverage * 8 - collectionPenalty));
    const quality = metadataQuality(item);
    const rank = relevance * .72 + quality * .12 + activityScore(item) * .08 + popularityScore(item) * .08;
    const {readme_excerpt,_search_query_index,_search_rank,...repo} = item;
    const original = clean(item.description,150);
    const chinese = /[㐀-鿿]/.test(original);
    return {...repo,relevance_score:relevance,quality_score:quality,rank_score:rank,assessment_mode:'fallback',ai_title:item.name,ai_summary:chinese ? original : (original ? `仓库原始说明：${original}` : '该候选项目缺少可核验的仓库简介，请进入 README 确认具体能力。'),ai_bullets:[]};
  }).filter(item=>item.relevance_score >= 52).sort((a,b)=>b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,10);
}

async function rankAndDescribe(req,input,plan,items) {
  const required = (Array.isArray(plan.capability_checks) ? plan.capability_checks : []).filter(check=>Array.isArray(check?.evidence_terms) && check.evidence_terms.length);
  const primaryChecks = primaryRequestChecks(input,required);
  const eligible = items.filter(item=>
    (wantsCollection(plan,input) || !isCollectionCandidate(item)) &&
    (wantsInstructional(plan,input) || !isInstructionalCandidate(item))
  );
  if (!eligible.length) return [];
  const scored = eligible.map(item=>({
    item,
    matched:required.length ? capabilityMatchCount(item,required) : 1,
    direct:required.length ? capabilityMatchCount(item,required,true) : 1
  })).sort((a,b)=>Number(b.item._semantic_score || 0)-Number(a.item._semantic_score || 0) || b.direct-a.direct || b.matched-a.matched || Number(a.item._search_query_index ?? 99)-Number(b.item._search_query_index ?? 99) || Number(a.item._search_rank ?? 99)-Number(b.item._search_rank ?? 99) || Number(b.item.stargazers_count || 0)-Number(a.item.stargazers_count || 0));
  const priorityQueryCount = Math.max(1,(plan.query_specs || []).filter(spec=>spec.kind === 'workflow' || spec.kind === 'localized').length);
  const pool = buildRankingPool(scored,priorityQueryCount);
  if (!pool.some(entry=>Number(entry.item._semantic_score || 0) > 0)) try {
    const result = await askModel(req,[
      {role:'system',content:'你是严格的 GitHub 项目研究员，只输出 JSON：{"items":[{"full_name":"owner/repo","fit_score":0,"title":"中文标题","summary":"适合原因","capability_evidence":[{"capability":"必须能力原名","evidence_quote":"候选资料逐字原文"}],"strengths":["已证明优势"],"limitations":["缺口或未验证项"]}]}。只返回最多6个值得推荐的项目，省略不相关候选，不要输出 keep=false。逐项核对输入、输出、必须能力和限制；完整方案优先，部分组件可保留但必须写清缺口。逐字证据不得改写。关键词偶然出现、相邻能力、教程或资源列表不推荐。主观体验没有试听或实测时必须写“尚未试听/实测，不能保证”。'},
      {role:'user',content:JSON.stringify({request:input,goal:plan.goal,required_capabilities:required.map(check=>check.name),constraints:plan.constraints,candidates:pool.map(({item})=>({full_name:item.full_name,description:item.description,topics:item.topics,stars:item.stargazers_count,readme_excerpt:clean(item.readme_excerpt,700)}))})}
    ],1600);
    const resultItems = result?.items ?? result?.projects ?? result?.results ?? result?.recommendations ?? result?.candidates;
    const decisions = new Map((Array.isArray(resultItems) ? resultItems : []).map(item=>[String((item?.full_name ?? item?.repository ?? item?.repo ?? item?.project) || '').toLowerCase(),item]));
    const evaluated = [];
    for (const {item,matched} of pool) {
      const decision = decisions.get(String(item.full_name || '').toLowerCase());
      if (!decision || decision.keep === false) continue;
      const claims = Array.isArray(decision.capability_evidence) ? decision.capability_evidence : Array.isArray(decision.evidence) ? decision.evidence : [];
      const supported = supportedCapabilityClaims(item,required,claims);
      if (required.length && !supported.length) continue;
      const validClaims = claims.filter(claim=>claim?.evidence_quote && evidenceSupported(item,[claim.evidence_quote]));
      const strengths = unique(decision.strengths,3);
      const limitations = unique(decision.limitations,3);
      const rawFit = Number(decision.fit_score) || 0;
      const fit = Math.max(0,Math.min(100,rawFit > 0 && rawFit <= 1 ? rawFit * 100 : rawFit));
      const coverage = required.length ? supported.length / required.length : 1;
      const primarySatisfied = !primaryChecks.length || primaryChecks.some(check=>supported.includes(check));
      if (!primarySatisfied || coverage < minimumCapabilityCoverage(required.length)) continue;
      const {readme_excerpt,_search_query_index,_search_rank,_semantic_score,...repo} = item;
      const summary = clean(decision.summary,170) || clean(item.description,150);
      const gap = limitations[0] ? `不足：${limitations[0]}` : '';
      evaluated.push({...repo,fit_score:fit,capability_coverage:coverage,semantic_score:Number(_semantic_score || 0),relevance_score:Math.round((fit * .55 + coverage * 25 + Number(_semantic_score || 0) * 20) * 10) / 10,rank_score:fit * .5 + coverage * 22 + Number(_semantic_score || 0) * 20 + popularityScore(item) * .08,assessment_mode:'ai_evaluated',ai_title:clean(decision.title,60) || item.name,ai_summary:clean([summary,gap].filter(Boolean).join('；'),220),ai_bullets:strengths,ai_limitations:limitations,ai_evidence:validClaims.map(claim=>clean(claim.evidence_quote,220)).slice(0,4),matched_capabilities:supported.map(check=>check.name),matched_evidence_count:matched});
    }
    if (evaluated.length) return evaluated.sort((a,b)=>b.capability_coverage-a.capability_coverage || b.rank_score-a.rank_score || Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0,8);
  } catch {}
  const partial = pool.filter(entry=>entry.matched > 0).map(({item,matched})=>{
    const supported = required.filter(check=>capabilityEvidenceSupportedInText(`${item.description || ''} ${(item.topics || []).join(' ')} ${item.readme_excerpt || ''}`,[check]));
    const missing = required.filter(check=>!supported.includes(check)).map(check=>check.name);
    const coverage = required.length ? supported.length / required.length : 1;
    const primarySatisfied = !primaryChecks.length || primaryChecks.some(check=>supported.includes(check));
    if (!primarySatisfied || coverage < minimumCapabilityCoverage(required.length)) return null;
    const {readme_excerpt,_search_query_index,_search_rank,_semantic_score,...repo} = item;
    const queryPriority = Math.max(0,100 - Number(item._search_query_index ?? 6) * 15 - Number(item._search_rank ?? 20) * 2);
    const evidenceLimits = [
      ...(missing.length ? [`尚未核验：${missing.join('、')}`] : []),
      '当前仅依据仓库资料核对相关能力，尚未验证这些能力已组成可直接使用的完整工作流',
      '自然度、音质和实际使用体验尚未试听或实测，不能保证'
    ];
    return {...repo,fit_score:Math.round(coverage * 100),capability_coverage:coverage,semantic_score:Number(_semantic_score || 0),relevance_score:Math.round((coverage * 80 + Number(_semantic_score || 0) * 20) * 10) / 10,rank_score:coverage * 70 + Number(_semantic_score || 0) * 24 + queryPriority * .06,assessment_mode:'evidence_fallback',ai_title:item.name,ai_summary:clean([`仓库资料命中：${supported.map(check=>check.name).join('、') || '与需求相关的能力'}`,missing.length ? `未核验：${missing.join('、')}` : '',item.description || ''].filter(Boolean).join('；'),220),ai_bullets:supported.map(check=>`README 或仓库简介包含与“${check.name}”相关的证据`).slice(0,3),ai_limitations:evidenceLimits,ai_evidence:item.description ? [clean(item.description,220)] : [],matched_capabilities:supported.map(check=>check.name),matched_evidence_count:matched};
  }).filter(Boolean).sort((a,b)=>b.capability_coverage-a.capability_coverage || b.semantic_score-a.semantic_score || b.rank_score-a.rank_score).slice(0,6);
  if (partial.length) return partial;
  const direct = eligible.filter(item=>primaryCapabilityEvidenceSupported(item,required));
  return fallbackRank(plan,direct.length ? direct : eligible,{allowReadmeEvidence:!direct.length});
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
    if (plan.mode !== 'ai') return res.status(503).json({error:'ai_planning_unavailable',detail:plan.aiFallbackReason || 'planning_failed'});
    const batches = await Promise.allSettled(plan.queries.map((query,index)=>githubSearch(query,token,plan.query_specs?.[index]?.kind)));
    const searchResults = batches.map(batch=>batch.status === 'fulfilled' ? batch.value : []);
    const priorityQueryCount = (plan.query_specs || []).filter(spec=>spec.kind === 'workflow' || spec.kind === 'localized').length;
    const candidates = collectDiversifiedCandidates(searchResults,MAX_CANDIDATES,priorityQueryCount);
    if (!candidates.length && batches.every(batch=>batch.status === 'rejected')) return res.status(502).json({error:'github_unavailable'});
    const hydrated = await withReadmes(candidates,plan.capability_checks);
    const semantic = await withSemanticScores(input,hydrated);
    const rankedCandidates = semantic.items;
    const eligibleCount = rankedCandidates.filter(item=>
      (!plan.capability_checks.length || capabilityMatchCount(item,plan.capability_checks) > 0) &&
      (wantsCollection(plan,input) || !isCollectionCandidate(item)) &&
      (wantsInstructional(plan,input) || !isInstructionalCandidate(item))
    ).length;
    const items = await rankAndDescribe(req,input,plan,rankedCandidates);
    return res.status(200).json({mode:plan.mode,intent:plan.intent,interpretation:{goal:plan.goal,core_capabilities:plan.core_capabilities,capability_checks:plan.capability_checks,constraints:plan.constraints},queries:plan.queries,diagnostic:plan.aiFallbackReason || null,diagnostic_counts:{candidates:candidates.length,eligible:eligibleCount,semantic_rerank:semantic.enabled,returned:items.length},items});
  } catch (error) {
    return res.status(502).json({error:'search_unavailable',detail:String(error?.message || '').slice(0,80)});
  }
};

module.exports._test = {activityScore,buildRankingPool,capabilityChecks,capabilityClaimsSupported,capabilityEvidenceSupported,capabilityEvidenceSupportedInText,capabilityMatchCount,collectDiversifiedCandidates,complementaryQueries,cosineSimilarity,deriveCapabilitySignature,evidenceCoverage,evidenceSupported,expandComplexEvidence,fallbackPlan,fallbackRank,githubSearchScope,isCollectionCandidate,isInstructionalCandidate,listText,meaningUnits,metadataQuality,minimumCapabilityCoverage,normalizeAIPlan,normalizeGithubQuery,planQuerySpecs,popularityScore,primaryCapabilityEvidenceSupported,primaryRequestChecks,quoteMatchesCheck,requestEvidenceSupported,selectReadmeExcerpt,stemToken,supportedCapabilityClaims,tokenSet,unique,wantsCollection,wantsInstructional,withSemanticScores};

