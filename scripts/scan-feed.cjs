const {configured,sql} = require('../api/_lib/db');
const freeAI = require('../api/_lib/free-ai');
const {prepareProjectContent,sourceFingerprint} = require('../api/_lib/project-content');
const verified = require('../data/featured-copy.json').entries || {};

const GITHUB = 'https://api.github.com';
const DAY = 86400000;
const backfillTarget = Math.min(500,Math.max(0,Number((process.argv.find(arg=>arg.startsWith('--backfill=')) || '').split('=')[1]) || 0));
const refreshTarget = Math.min(200,Math.max(0,Number((process.argv.find(arg=>arg.startsWith('--refresh=')) || '').split('=')[1]) || 0));
const token = process.env.GITHUB_API_TOKEN || '';
const lanes = [
  {key:'ai_capability',queries:['topic:llm','topic:multimodal','topic:ai-agents','topic:mcp']},
  {key:'ai_product',queries:['topic:ai-assistant','topic:generative-ai','topic:voice-ai','topic:browser-automation']},
  {key:'product_building',queries:['topic:prototyping','topic:design-system','topic:workflow-automation','topic:low-code']},
  {key:'product_operations',queries:['topic:product-analytics','topic:observability','topic:feature-flags','topic:session-replay']},
  {key:'product_inspiration',queries:['topic:local-first','topic:productivity','topic:collaboration','topic:data-visualization']}
];

function headers(accept='application/vnd.github+json') {
  return {Accept:accept,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'RepoScroll-Feed',...(token ? {Authorization:`Bearer ${token}`} : {})};
}
function clean(value,limit=240) {
  return String(value || '').replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
}
function keyOf(repo) { return String(repo.full_name || '').toLowerCase(); }
function dateKey(date) { return date.toISOString().slice(0,10); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function hasChinese(value) { return /[㐀-鿿]/.test(String(value || '')); }
function isCollection(repo,readme='') {
  const text=`${repo.name || ''} ${repo.description || ''} ${readme.slice(0,3000)}`;
  return /^awesome[-_]/i.test(repo.name || '') || /curated (?:list|collection)|awesome list|resources? list|collection of (?:tools|projects|resources)/i.test(text);
}
function suspicious(repo) {
  const text=`${repo.name || ''} ${repo.description || ''}`;
  return /pre[- ]?activated|full working installer|trainer tool|skin swapper|password recovery|unlocker|keygen|serial key|all features (?:enabled|preconfigured)|ready to run in 2026|ai--manus|gemini-config-checker/i.test(text);
}
function laneFor(repo) {
  const text=`${repo.name || ''} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const rules=[
    ['ai_capability',/\b(llm|multimodal|inference|embedding|rag|agent|mcp|model serving|speech model|vision model)\b/],
    ['ai_product',/assistant|copilot|meeting|research|voice|video|browser automation|ai app|generative/],
    ['product_building',/prototype|design system|workflow|low-code|no-code|ui|ux|whiteboard|diagram/],
    ['product_operations',/analytics|observability|feature flag|session replay|experiment|monitoring|feedback/],
    ['product_inspiration',/local-first|productivity|collaboration|visualization|note|calendar|task/]
  ];
  return rules.find(([,pattern])=>pattern.test(text))?.[0] || null;
}
function initialScore(repo) {
  const age=Math.max(1,(Date.now()-Date.parse(repo.created_at || 0))/DAY);
  const stars=Number(repo.stargazers_count || 0);
  const velocity=stars/age;
  const freshness=Math.max(0,30-Math.min(30,age/3));
  return Math.log10(stars+1)*14 + Math.log10(velocity+1)*24 + Math.log10(Number(repo.forks_count || 0)+1)*5 + freshness;
}
const laneWeights={ai_capability:5,ai_product:5,product_building:4,product_operations:3,product_inspiration:3};
function balancedEntries(entries,limit) {
  const order=Object.keys(laneWeights);
  const groups=new Map(order.map(key=>[key,[]]));
  for (const entry of entries) {
    const suggested=entry.lane || laneFor(entry.repo);
    const lane=order.includes(suggested)?suggested:(laneFor(entry.repo)||'product_inspiration');
    groups.get(lane).push({...entry,lane});
  }
  for (const group of groups.values()) group.sort((a,b)=>initialScore(b.repo)-initialScore(a.repo));
  const result=[];
  while (result.length<limit) {
    let added=false;
    for (const lane of order) {
      const group=groups.get(lane);
      for (let count=0;count<laneWeights[lane]&&group.length&&result.length<limit;count++) {
        result.push(group.shift());
        added=true;
      }
    }
    if (!added) break;
  }
  return result;
}
async function github(path,accept) {
  const response=await fetch(GITHUB+path,{headers:headers(accept),signal:AbortSignal.timeout(15000)});
  if (response.status===404) return null;
  if (!response.ok) throw new Error(`github_${response.status}`);
  return accept?.includes('raw') ? response.text() : response.json();
}
async function search(query,page=1) {
  const params=new URLSearchParams({q:query,sort:'stars',order:'desc',per_page:'50',page:String(page)});
  const result=await github('/search/repositories?'+params);
  return Array.isArray(result?.items) ? result.items : [];
}
async function trendingRepos() {
  const result=new Set();
  for (const since of ['daily','weekly']) {
    try {
      const response=await fetch(`https://github.com/trending?since=${since}`,{headers:{'User-Agent':'RepoScroll-Feed'},signal:AbortSignal.timeout(15000)});
      if (!response.ok) continue;
      const html=await response.text();
      for (const match of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="\/([^"?#]+\/[^"?#]+)"/gi)) result.add(match[1].toLowerCase());
    } catch {}
  }
  return result;
}
async function readme(repo) {
  try {
    const branch=encodeURIComponent(repo.default_branch || 'main');
    const response=await fetch(`https://raw.githubusercontent.com/${repo.full_name}/${branch}/README.md`,{headers:{'User-Agent':'RepoScroll-Feed'},signal:AbortSignal.timeout(12000)});
    if (response.ok) return (await response.text()).slice(0,60000);
  } catch {}
  return '';
}
function resolveAsset(value,repo) {
  const raw=String(value || '').trim().replace(/^<|>$/g,'');
  if (!raw || /^(data:|javascript:)/i.test(raw)) return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;
    return `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch || 'main'}/${raw.replace(/^\.\//,'')}`;
  } catch { return null; }
}
function readmeImages(readmeText,repo) {
  const text=String(readmeText || '');
  const found=[];
  const add=(raw,alt='',position=0)=>{
    const url=resolveAsset(raw,repo);
    const context=`${url || ''} ${alt}`;
    if (!url || /shields\.io|badgen|badge|license|coverage|actions\/workflows|social|star-history|trendshift|avatars\.githubusercontent|opencollective\.com\/.*avatar|\b(?:logo|icon|avatar)\b|\.svg(?:[?#]|$)/i.test(context)) return;
    let score=0;
    if (/screenshot|screen[-_.\/ ]|preview|demo|showcase|interface|dashboard|workflow|hero|usage|product|cover|app[-_.\/ ]|readme[_-]?if|界面|截图|演示|预览|效果图|产品展示/i.test(context)) score+=8;
    if (/\.gif(?:[?#]|$)|\.webp(?:[?#]|$)|\.png(?:[?#]|$)|\.jpe?g(?:[?#]|$)/i.test(url)) score+=2;
    if (/banner|header|wordmark/i.test(context)) score-=3;
    if (score>1) found.push({url,score,position});
  };
  for (const match of text.matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) add(match[2]||match[3],match[1],match.index);
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const src=match[0].match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    const alt=match[0].match(/\balt\s*=\s*(["'])(.*?)\1/i);
    if (src) add(src[2],alt?.[2]||'',match.index);
  }
  const deduped=new Map();
  for (const item of found) if (!deduped.has(item.url)||item.score>deduped.get(item.url).score) deduped.set(item.url,item);
  return [...deduped.values()].sort((a,b)=>b.score-a.score||a.position-b.position).map(item=>item.url);
}
function coverFrom(readmeText,repo) { return readmeImages(readmeText,repo)[0] || null; }
function evidenceSupported(source,quote) {
  const normalize=value=>String(value || '').toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g,' ').replace(/\s+/g,' ').trim();
  const haystack=normalize(source);
  const needle=normalize(quote);
  return needle.length>=8 && haystack.includes(needle);
}
async function classify(items) {
  if (!items.length || !freeAI.enabled()) return new Map();
  const decisions=new Map();
  const system='你为“AI 产品经理值得了解的 GitHub 项目”做严格入选判断。入选不是因为项目带 AI、Agent、MCP 等名词，而是它必须能直接帮助通用 AI 产品经理理解至少一项产品判断：真实用户问题、新交互方式、AI 能力边界、产品实现取舍、数据运营或商业化。纯底层工程、安全攻防、代码保护、模型格式、逆向工程和垂直技术组件，如果不能清楚转化为大多数 AI 产品经理可迁移的产品判断，必须 keep=false。排除教程、资源合集、批量克隆、只有热度或技术名词但用途不清的仓库。只输出 JSON：{"items":[{"full_name":"owner/repo","keep":true,"category":"ai_capability|ai_product|product_building|product_operations|product_inspiration","title":"8至24字中文标题","cover_copy":"18至55字中文封面文案","reason":"为什么值得AI产品经理关注","evidence_quote":"候选材料中的逐字原文","release_important":false,"release_reason":""}]}。title 直接说明它为谁解决什么问题或带来什么能力，不堆砌仓库名和术语。cover_copy 用普通产品经理能快速扫读的语言，优先写用户问题和结果，避免以“通过、基于、一套”开头；MCP、RAG、SDK 等术语只有不可替代时才保留。不得把项目方的比较或营销主张写成已验证事实。没有逐字证据不得 keep=true；不要为了数量降低标准。只有当 Release 带来用户可感知的新能力、新交互或工作流，显著改变部署成本、性能、成本或兼容性，或属于重要主版本时，release_important 才能为 true；依赖升级、文档修改、小修复和常规维护均为 false。';
  for (let index=0;index<items.length;index+=5) {
    const batch=items.slice(index,index+5);
    try {
      const result=await freeAI.generateJSON([
        {role:'system',content:system},
        {role:'user',content:JSON.stringify({candidates:batch.map(item=>({full_name:item.repo.full_name,description:item.repo.description,topics:item.repo.topics,stars:item.repo.stargazers_count,created_at:item.repo.created_at,latest_release:item.release ? {tag_name:item.release.tag_name,published_at:item.release.published_at,name:item.release.name,body:clean(item.release.body,1000)} : null,readme_excerpt:clean(item.readme,2200)}))})}
      ],{maxTokens:1600,timeoutMs:25000});
      for (const item of Array.isArray(result?.items)?result.items:[]) decisions.set(String(item.full_name || '').toLowerCase(),item);
    } catch(error) {
      console.warn(`classification_batch_${index / 5 + 1}_failed`,String(error?.message || error).slice(0,120));
    }
  }
  return decisions;
}
async function previousSnapshot(db,fullNameKey) {
  const rows=await db`SELECT stars,observed_at FROM repo_snapshots WHERE project_full_name_key=${fullNameKey} ORDER BY observed_at DESC LIMIT 1`;
  return rows[0] || null;
}
function attentionTag({eventType,isTrending,starVelocity,starDelta,hasPrevious,stars}) {
  if (eventType==='release') return '重要更新';
  if (isTrending) return 'GitHub Trending';
  if (hasPrevious && starDelta>=10 && starVelocity>=40 && stars>=200) return '近期爆发';
  return '';
}
async function main() {
  if (!configured()) throw new Error('DATABASE_URL is required');
  const db=sql();
  const runRows=await db`INSERT INTO scan_runs DEFAULT VALUES RETURNING id`;
  const runId=runRows[0].id;
  let published=0;
  try {
    const trending=await trendingRepos();
    const since=dateKey(new Date(Date.now()-(backfillTarget ? 730 : 90)*DAY));
    const minStars=backfillTarget ? 500 : 50;
    const candidateMap=new Map();
    if (!refreshTarget) {
      for (const lane of lanes) {
        for (const base of lane.queries) {
          const query=`${base} created:>=${since} stars:>=${minStars} archived:false fork:false`;
          for (const repo of await search(query)) {
            const key=keyOf(repo);
            if (!candidateMap.has(key)) candidateMap.set(key,{repo,lane:lane.key});
          }
        }
      }
    }
    const existing=refreshTarget
      ? await db`
          SELECT p.full_name_key,p.payload FROM projects p
          WHERE EXISTS(SELECT 1 FROM feed_events e WHERE e.project_full_name_key=p.full_name_key AND e.status='published')
          ORDER BY CASE WHEN COALESCE(p.payload->>'content_ready','false')='true' THEN 1 ELSE 0 END,
            p.last_scanned_at ASC LIMIT ${refreshTarget}`
      : await db`SELECT full_name_key,payload FROM projects ORDER BY last_scanned_at ASC LIMIT 80`;
    for (const row of existing) {
      const storedPayload=row.payload;
      if (!storedPayload?.full_name) continue;
      const current=candidateMap.get(row.full_name_key);
      candidateMap.set(row.full_name_key,current
        ? {...current,existing:true,storedPayload}
        : {repo:storedPayload,lane:storedPayload.attention_category || laneFor(storedPayload),existing:true,storedPayload});
    }
    const publishedKeys=backfillTarget
      ? new Set((await db`SELECT DISTINCT project_full_name_key FROM feed_events WHERE status='published'`).map(row=>row.project_full_name_key))
      : new Set();
    const candidates=[];
    const candidateLimit=refreshTarget || (backfillTarget ? Math.min(500,Math.max(220,Math.ceil(backfillTarget*1.5))) : 48);
    const candidatePool=[...candidateMap.values()].filter(({repo})=>!repo.archived&&!repo.fork&&!suspicious(repo))
      .filter(({repo})=>!backfillTarget || !publishedKeys.has(keyOf(repo)));
    for (const entry of balancedEntries(candidatePool,candidateLimit)) {
      const repo=entry.existing
        ? await github(`/repos/${entry.repo.full_name}`).catch(()=>entry.repo)
        : entry.repo;
      const fullNameKey=keyOf(repo);
      const previous=await previousSnapshot(db,fullNameKey);
      await db`INSERT INTO repo_snapshots (project_full_name_key,stars,forks,pushed_at) VALUES (${fullNameKey},${Number(repo.stargazers_count || 0)},${Number(repo.forks_count || 0)},${repo.pushed_at || null})`;
      const hours=previous ? Math.max(1,(Date.now()-Date.parse(previous.observed_at))/3600000) : null;
      const starDelta=previous ? Math.max(0,Number(repo.stargazers_count || 0)-Number(previous.stars || 0)) : 0;
      const starVelocity=previous && hours ? starDelta*24/hours : Number(repo.stargazers_count || 0)/Math.max(1,(Date.now()-Date.parse(repo.created_at || 0))/DAY);
      if (!entry.existing && !backfillTarget && !refreshTarget && starVelocity<3 && Number(repo.stargazers_count || 0)<1000) continue;
      const text=await readme(repo);
      if (text.length<400 || isCollection(repo,text)) continue;
      const release=await github(`/repos/${repo.full_name}/releases/latest`).catch(()=>null);
      candidates.push({...entry,repo,readme:text,release,starVelocity,starDelta,previousSnapshot:previous,isTrending:trending.has(fullNameKey)});
      if (candidates.length >= (refreshTarget || backfillTarget || 24)) break;
    }
    const decisions=await classify(candidates).catch(()=>new Map());
    const publishOrder=[...candidates].sort((a,b)=>(initialScore(a.repo)+a.starVelocity)-(initialScore(b.repo)+b.starVelocity));
    for (const item of publishOrder) {
      const repo=item.repo;
      const fullNameKey=keyOf(repo);
      if (item.existing) await db`UPDATE projects SET last_scanned_at=now() WHERE full_name_key=${fullNameKey}`;
      const cached=verified[fullNameKey];
      const decision=decisions.get(fullNameKey);
      const category=decision?.category || item.lane || laneFor(repo);
      const quote=clean(decision?.evidence_quote,320);
      const source=`${repo.description || ''}\n${item.readme}`;
      const keep=decision?.keep===true && category && evidenceSupported(source,quote);
      if (decision && decision.keep===false && item.existing) {
        await db`UPDATE feed_events SET status='removed' WHERE project_full_name_key=${fullNameKey} AND status='published'`;
        continue;
      }
      if (!keep && !cached) continue;
      const previousEvents=await db`SELECT event_type,release_payload,published_at FROM feed_events WHERE project_full_name_key=${fullNameKey} AND status='published' ORDER BY id DESC LIMIT 1`;
      const previousEvent=previousEvents[0];
      let eventType=previousEvent ? null : (backfillTarget ? 'classic' : 'new');
      let eventKey=`${fullNameKey}:${eventType || 'none'}`;
      let occurredAt=repo.created_at || new Date().toISOString();
      let releasePayload=null;
      let reason=clean(decision?.reason,220) || (cached ? '已核验的高质量项目' : '值得 AI 产品经理关注的新项目');
      if (previousEvent && decision?.release_important===true && item.release?.tag_name && item.release?.published_at) {
        const lastPublished=Date.parse(previousEvent.published_at || 0);
        const releasePublished=Date.parse(item.release.published_at || 0);
        const cooldown=Date.now()-lastPublished >= 30*DAY;
        if (releasePublished>lastPublished && (cooldown || /^v?\d+\.0(?:\.0)?$/i.test(item.release.tag_name))) {
          eventType='release';
          eventKey=`${fullNameKey}:release:${item.release.tag_name}`;
          occurredAt=item.release.published_at;
          reason=clean(decision.release_reason,220) || reason;
          releasePayload={tag_name:item.release.tag_name,published_at:item.release.published_at,name:item.release.name,html_url:item.release.html_url,has_assets:Array.isArray(item.release.assets)&&item.release.assets.length>0};
        }
      }
      const title=clean(decision?.title,80) || cached?.title || (hasChinese(repo.description) ? repo.name : '');
      const coverCopy=clean(decision?.cover_copy,120) || cached?.summary || clean(item.storedPayload?.cover_copy || item.storedPayload?.summary,120) || (hasChinese(repo.description) ? clean(repo.description,120) : '');
      if (!title || !coverCopy) continue;
      const fingerprint=sourceFingerprint(item.readme);
      const stored=item.storedPayload || {};
      const prepared=stored.content_ready===true && stored.readme_source_sha===fingerprint
        ? {
            content_ready:true,translation_status:stored.translation_status,readme_markdown:stored.readme_markdown,
            readme_source_sha:stored.readme_source_sha,content_prepared_at:stored.content_prepared_at,experience:stored.experience
          }
        : await prepareProjectContent({readme:item.readme,repo,release:item.release,freeAI});
      const tag=attentionTag({eventType,isTrending:item.isTrending,starVelocity:item.starVelocity,starDelta:item.starDelta,hasPrevious:Boolean(item.previousSnapshot),stars:Number(repo.stargazers_count || 0)});
      const payload={
        full_name:repo.full_name,name:repo.name,description:repo.description,stargazers_count:Number(repo.stargazers_count || 0),forks_count:Number(repo.forks_count || 0),topics:repo.topics || [],homepage:repo.homepage,created_at:repo.created_at,updated_at:repo.updated_at,pushed_at:repo.pushed_at,html_url:repo.html_url,license:repo.license,default_branch:repo.default_branch,
        ai_title:title,ai_summary:coverCopy,title,summary:coverCopy,cover_copy:coverCopy,
        cover:coverFrom(item.readme,repo) || stored.cover || null,
        attention_category:category,evidence_quotes:quote ? [quote] : cached?.evidence ? [cached.evidence] : [],selection_reason:reason,
        release:releasePayload || stored.release || null,star_velocity_24h:Math.round(item.starVelocity*10)/10,attention_tag:tag,
        ...prepared
      };
      await db`
        INSERT INTO projects (full_name_key,full_name,github_id,category,payload,last_scanned_at,updated_at)
        VALUES (${fullNameKey},${repo.full_name},${repo.id || null},${category},${JSON.stringify(payload)}::jsonb,now(),now())
        ON CONFLICT (full_name_key) DO UPDATE SET
          full_name=EXCLUDED.full_name,github_id=COALESCE(EXCLUDED.github_id,projects.github_id),category=EXCLUDED.category,
          payload=EXCLUDED.payload,last_scanned_at=now(),updated_at=now()`;
      if (!eventType || prepared.content_ready!==true) continue;
      const inserted=await db`
        INSERT INTO feed_events (event_key,project_full_name_key,event_type,occurred_at,selection_reason,release_payload,rank_score,status)
        VALUES (${eventKey},${fullNameKey},${eventType},${occurredAt},${reason},${releasePayload ? JSON.stringify(releasePayload) : null}::jsonb,${initialScore(repo)+item.starVelocity},'published')
        ON CONFLICT (event_key) DO NOTHING RETURNING id`;
      if (inserted.length) published++;
    }
    await db`UPDATE scan_runs SET finished_at=now(),status='completed',candidates=${candidates.length},published=${published} WHERE id=${runId}`;
    console.log(JSON.stringify({candidates:candidates.length,published,backfillTarget,refreshTarget,trending:trending.size}));
  } catch(error) {
    await db`UPDATE scan_runs SET finished_at=now(),status='failed',detail=${String(error?.message || error).slice(0,500)} WHERE id=${runId}`.catch(()=>{});
    throw error;
  }
}

if (require.main===module) main().catch(error=>{ console.error(error); process.exitCode=1; });

module.exports._test={balancedEntries,readmeImages,coverFrom,attentionTag,laneFor};
