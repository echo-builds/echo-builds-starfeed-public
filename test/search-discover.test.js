const test = require('node:test');
const assert = require('node:assert/strict');

const search = require('../api/search')._test;
const discover = require('../api/discover')._test;

const requests = [
  '把英文访谈变成自然的中文配音，支持多人对话',
  '找一个能自动整理用户访谈并提取需求证据的工具',
  '适合产品经理画可交互原型的开源项目',
  '本地运行的个人知识库，能检索 PDF 并回答问题',
  '把会议录音整理成行动项，最好能自托管',
  '评测 AI Agent 是否可靠并追踪每一步调用',
  '让模型在手机端离线运行的推理框架',
  '检测大模型提示词注入和敏感信息泄露',
  '把网页操作录制成可重复执行的自动化流程',
  '开源的 AI 搜索产品，要能引用信息来源'
];

test('通用降级计划可处理十类需求且不注入固定领域查询',()=>{
  for (const request of requests) {
    const plan = search.fallbackPlan(request);
    assert.equal(plan.mode,'fallback');
    assert.ok(plan.queries.length >= 1 && plan.queries.length <= 5);
    assert.ok(plan.queries.every(query=>typeof query === 'string' && query.length > 1));
  }
  const neutral = search.fallbackPlan('找一个简单的开源日程规划项目');
  assert.ok(neutral.queries.every(query=>!/^TTS$|text-to-speech|speech synthesis/i.test(query)));
});

test('兼容模型把检索词返回成对象数组',()=>{
  assert.deepEqual(search.unique([{query:'agent evaluation'},{terms:['tool','tracing']},{value:'self hosted'}],5),['agent evaluation','tool tracing','self hosted']);
  assert.deepEqual(search.unique({primary:{search_query:'agent evaluation'},secondary:{keywords:['tool','tracing']}},5),['agent evaluation','tool tracing']);
  assert.equal(search.listText({purpose:'missing query'}),'');
});

test('入选能力必须能回查到仓库资料中的逐字证据',()=>{
  const item = {description:'Open-source agent observability and evaluation platform',topics:['tracing'],readme_excerpt:'Trace every model call with OpenTelemetry.'};
  assert.equal(search.evidenceSupported(item,['agent observability and evaluation','Trace every model call']),true);
  assert.equal(search.evidenceSupported(item,['supports voice cloning']),false);
  assert.equal(search.evidenceSupported(item,[]),false);
});

test('候选必须逐项命中核心能力的可核验术语',()=>{
  const checks = search.capabilityChecks([
    {name:'Agent 评测',evidence_terms:['agent evaluation','agent evals']},
    {name:'工具调用追踪',evidence_terms:['tool call tracing','trace tool calls']}
  ]);
  const complete = {description:'Agent evaluation platform',topics:['tool-call-tracing'],readme_excerpt:'Trace tool calls and compare agent runs.'};
  const incomplete = {description:'Reliable web data for AI agents',topics:['benchmark'],readme_excerpt:'Clean data for better decisions.'};
  assert.equal(search.capabilityEvidenceSupported(complete,checks),true);
  assert.equal(search.capabilityEvidenceSupported(incomplete,checks),false);
});

test('检索计划只使用模型生成的英文查询，不把中文或拼接能力名直接送进 GitHub',()=>{
  const plan = {
    goal:'评测 Agent 是否可靠并追踪每一步调用',
    queries:['LLM agent reliability benchmark'],
    capability_checks:[
      {name:'Agent Evaluation',evidence_terms:['evaluation','benchmark']},
      {name:'Agent Tracing',evidence_terms:['tracing','observability']}
    ]
  };
  const queries = search.complementaryQueries(plan);
  assert.deepEqual(queries,['LLM agent reliability benchmark']);
});

test('完整产品、用户语言和组件检索分层执行，完整产品始终优先',()=>{
  const plan = search.normalizeAIPlan({
    intent:'把英文访谈转成自然中文多人音频',
    goal:'输出可收听的中文多人对话',
    core_capabilities:[{name:'音频转写',evidence_terms:['audio transcription','音频转写']}],
    constraints:['自然度待试听'],
    workflow_queries:['interview dubbing','speech dubbing transcription'],
    localized_queries:['访谈 翻译 配音'],
    component_queries:['speaker diarization','multi speaker TTS','voice cloning']
  },'英文访谈转中文多人音频');
  assert.deepEqual(plan.queries,[
    'interview dubbing','audio transcription dubbing','访谈 翻译 配音',
    'speaker diarization','multi speaker TTS'
  ]);
  assert.deepEqual(plan.query_specs.map(spec=>spec.kind),['workflow','workflow','localized','component','component']);
});

test('第二条产品检索由输入能力和整体动作组成，不依赖模型逐字猜中',()=>{
  assert.equal(search.deriveCapabilitySignature('podcast dubbing',[
    {name:'音频转写',evidence_terms:['speech transcription','语音转文字']},
    {name:'说话人识别',evidence_terms:['speaker diarization']}
  ]),'speech transcription dubbing');
});

test('返回给前端的检索词与 GitHub 实际执行词一致',()=>{
  const plan=search.normalizeAIPlan({
    intent:'播客翻译',goal:'播客配音',
    core_capabilities:[{name:'转写',evidence_terms:['speech transcription','语音转写']}],
    workflow_queries:['audio dubbing','speech translation'],
    localized_queries:['播客 自动配音'],component_queries:['speaker diarization']
  },'播客翻译');
  assert.ok(plan.queries.includes('播客 配音'));
  assert.ok(!plan.queries.some(query=>query.includes('自动')));
});

test('中文仓库说明可以作为能力证据，不要求作者必须写英文术语',()=>{
  const source='开箱即用的访谈翻译工具，可将英文录音转写、翻译、配音并合成为中文多人音频。';
  assert.equal(search.capabilityEvidenceSupportedInText(source,[
    {name:'录音转写',evidence_terms:['audio transcription','录音转写']},
    {name:'中文配音',evidence_terms:['Chinese dubbing','中文多人音频']}
  ]),true);
  assert.equal(search.capabilityEvidenceSupportedInText('支持播客翻译和中文配音',[{
    name:'翻译',evidence_terms:['machine translation','text translation','翻译']
  }]),true);
});

test('候选采样保留每条检索的长尾产品，不按 Star 全局挤掉',()=>{
  const make=(query,rank,stars=1)=>({
    full_name:`demo/q${query}-r${rank}`,name:`q${query}-r${rank}`,description:'',topics:[],
    stargazers_count:stars,forks_count:0,archived:false,fork:false,default_branch:'main'
  });
  const results=Array.from({length:5},(_,query)=>Array.from({length:50},(_,rank)=>make(query,rank,rank === 0 ? 100000 : 1)));
  const candidates=search.collectDiversifiedCandidates(results);
  assert.equal(candidates.length,42);
  assert.ok(candidates.some(item=>item.full_name === 'demo/q0-r49'));
  assert.ok(candidates.some(item=>item.full_name === 'demo/q4-r49'));
});

test('产品检索连续保留前八名，不会漏掉第四名的长尾产品',()=>{
  const make=(query,rank)=>({
    full_name:`demo/q${query}-r${rank}`,name:`q${query}-r${rank}`,description:'',topics:[],
    stargazers_count:1,forks_count:0,archived:false,fork:false,default_branch:'main'
  });
  const results=Array.from({length:5},(_,query)=>Array.from({length:50},(_,rank)=>make(query,rank)));
  const candidates=search.collectDiversifiedCandidates(results,42,3);
  for (let query=0;query<3;query++) {
    for (let rank=0;rank<8;rank++) assert.ok(candidates.some(item=>item.full_name === `demo/q${query}-r${rank}`));
  }
});

test('完整产品与本地语言检索各有复核席位，不被高分组件挤掉',()=>{
  const entry=(name,query,rank,matched,direct)=>({
    item:{full_name:name,_search_query_index:query,_search_rank:rank,stargazers_count:1},matched,direct
  });
  const scored=[
    entry('demo/popular-a',3,0,4,4),entry('demo/popular-b',4,0,4,4),
    entry('demo/workflow-a',0,0,2,1),entry('demo/workflow-b',0,1,2,1),
    entry('demo/signature-a',1,0,2,1),entry('demo/signature-b',1,1,2,1),
    entry('demo/localized-a',2,0,1,1),entry('demo/localized-b',2,1,1,1),
    entry('demo/extra',3,1,3,3)
  ];
  const pool=search.buildRankingPool(scored,3,8).map(entry=>entry.item.full_name);
  assert.deepEqual(pool,[
    'demo/workflow-a','demo/workflow-b','demo/signature-a','demo/signature-b',
    'demo/localized-a','demo/localized-b','demo/popular-a','demo/popular-b'
  ]);
});

test('语义相似度优先选择真正符合整句需求的产品',async()=>{
  assert.equal(search.cosineSimilarity([1,0],[1,0]),1);
  assert.equal(search.cosineSimilarity([1,0],[0,1]),0);
  const freeAI=require('../api/_lib/free-ai');
  const original=freeAI.embedTexts;
  try {
    freeAI.embedTexts=async()=>[[1,0],[0.95,0.05],[0.1,0.9]];
    const result=await search.withSemanticScores('中文播客配音',[
      {full_name:'demo/product',description:'complete product',topics:[],readme_excerpt:''},
      {full_name:'demo/component',description:'generic component',topics:[],readme_excerpt:''}
    ]);
    assert.equal(result.enabled,true);
    assert.ok(result.items[0]._semantic_score > result.items[1]._semantic_score);
  } finally { freeAI.embedTexts=original; }
});

test('GitHub 召回去掉会把查询锁死的描述词，保留核心产品类别',()=>{
  assert.equal(search.normalizeGithubQuery('end-to-end podcast dubbing'),'podcast dubbing');
  assert.equal(search.normalizeGithubQuery('natural expressive TTS Chinese'),'TTS Chinese');
  assert.equal(search.normalizeGithubQuery('automated podcast dubbing system'),'podcast dubbing');
  assert.equal(search.normalizeGithubQuery('speech translation with voice cloning and natural TTS'),'speech translation voice cloning TTS');
  assert.equal(search.normalizeGithubQuery('播客 自动配音'),'播客 配音');
  assert.equal(search.normalizeGithubQuery('menu translation'),'menu translation');
});

test('完整产品查主元数据，组件才查 README 全文',()=>{
  assert.equal(search.githubSearchScope('workflow'),'in:name,description,topics');
  assert.equal(search.githubSearchScope('localized'),'in:name,description,topics');
  assert.equal(search.githubSearchScope('component'),'in:name,description,readme,topics');
});

test('未登录只查完整产品，登录后才补充组件检索',()=>{
  const plan={query_specs:[
    {query:'product action',kind:'workflow'},
    {query:'capability signature',kind:'workflow'},
    {query:'本地 产品 动作',kind:'localized'},
    {query:'input component',kind:'component'},
    {query:'output component',kind:'component'}
  ]};
  assert.deepEqual(search.activeQuerySpecs(plan,false).map(spec=>spec.query),['product action','capability signature','本地 产品 动作']);
  assert.equal(search.activeQuerySpecs(plan,true).length,5);
});

test('资源链接合集不会作为可运行产品进入推荐',()=>{
  assert.equal(search.isCollectionCandidate({name:'voiceai',description:'Set of notes and links to help people build Voice AI agents'}),true);
  assert.equal(search.isCollectionCandidate({name:'voice-pro',description:'Gradio WebUI for transcription, translation and voice cloning'}),false);
});

test('证据匹配识别 translate translation 与 transcribe transcription 的同根词',()=>{
  assert.equal(search.stemToken('translate'),search.stemToken('translation'));
  assert.equal(search.stemToken('transcribes'),search.stemToken('transcription'));
  assert.equal(search.capabilityEvidenceSupportedInText('Drop an audio file, transcribe it, translate the script and export the dub.',[
    {name:'音频转录',evidence_terms:['audio transcription']},
    {name:'内容翻译',evidence_terms:['script translation']}
  ]),true);
});

test('复杂任务同时保留具体证据短语和可核验的核心动作',()=>{
  const checks = search.expandComplexEvidence([
    {name:'转录',evidence_terms:['audio transcription','ASR']},
    {name:'翻译',evidence_terms:['context-aware translation']},
    {name:'配音',evidence_terms:['expressive speech synthesis','voice cloning']}
  ]);
  assert.ok(checks[0].evidence_terms.includes('transcription'));
  assert.ok(checks[0].evidence_terms.includes('ASR'));
  assert.ok(checks[1].evidence_terms.includes('translation'));
  assert.ok(checks[2].evidence_terms.includes('synthesis'));
});

test('复杂需求至少覆盖四成关键能力，防止只命中边缘步骤就被推荐',()=>{
  assert.equal(search.minimumCapabilityCoverage(1),1);
  assert.equal(search.minimumCapabilityCoverage(2),.5);
  assert.equal(search.minimumCapabilityCoverage(4),.4);
  assert.ok(1 / 4 < search.minimumCapabilityCoverage(4));
  assert.ok(2 / 5 >= search.minimumCapabilityCoverage(5));
});

test('短查询必须命中与原话重合最高的核心能力，派生步骤不能替代用户动作',()=>{
  const checks = [
    {name:'菜单内容识别与 OCR',evidence_terms:['menu OCR']},
    {name:'菜单翻译与语言转换',evidence_terms:['menu translation']},
    {name:'视觉布局保留',evidence_terms:['layout preservation']}
  ];
  assert.deepEqual(search.primaryRequestChecks('菜单翻译的项目',checks).map(check=>check.name),['菜单翻译与语言转换']);
  assert.deepEqual(search.primaryRequestChecks('给我搜索英文播客转成自然中文多人播客对话的端到端项目',checks),[]);
  assert.ok(1 / checks.length < search.minimumCapabilityCoverage(checks.length));
  assert.ok(2 / checks.length >= search.minimumCapabilityCoverage(checks.length));
});

test('README 摘要优先保留能证明核心能力的后置段落',()=>{
  const raw = '# Project\nA polished platform for AI teams.\n\n## Install\nRun npm install.\n\n## Evaluation\nCompare agent evaluations across datasets and trace every tool call.';
  const excerpt = search.selectReadmeExcerpt(raw,[
    {name:'Agent Evaluation',evidence_terms:['agent evaluation']},
    {name:'Tool Tracing',evidence_terms:['trace tool call']}
  ]);
  assert.match(excerpt,/Compare agent evaluations/);
  assert.match(excerpt,/trace every tool call/);
});

test('证据词归一化兼容连字符、复数和 tracing 等词形',()=>{
  assert.deepEqual([...search.tokenSet('tool-call_tracing')],['call','tracing']);
  assert.equal(search.stemToken('tracing'),'trace');
  assert.equal(search.stemToken('evaluations'),'evaluation');
  assert.equal(search.stemToken('logging'),'log');
});

test('排序结果必须为每项核心能力提供可回查证据',()=>{
  const item = {description:'Agent evaluation platform with tool call tracing',topics:['observability'],readme_excerpt:'Trace every tool call and compare agent evaluations.'};
  const claims = [
    {capability:'Agent 可靠性评测',evidence_quote:'compare agent evaluations'},
    {capability:'工具调用追踪',evidence_quote:'Trace every tool call'}
  ];
  assert.equal(search.capabilityClaimsSupported(item,['Agent 可靠性评测','工具调用追踪'],claims),true);
  assert.equal(search.capabilityClaimsSupported(item,['Agent 可靠性评测','工具调用追踪'],claims.slice(0,1)),false);
});

test('能力证据名称轻微变化时按内容匹配而不是整批误杀',()=>{
  const item = {description:'Mobile inference runtime with offline execution',topics:['on-device-ai'],readme_excerpt:'Run models locally on Android and iOS.'};
  const claims = [
    {capability:'移动端模型推理',evidence_quote:'Mobile inference runtime'},
    {capability:'本地离线执行',evidence_quote:'Run models locally'}
  ];
  assert.equal(search.capabilityClaimsSupported(item,['移动端推理','离线运行'],claims),true);
  assert.equal(search.capabilityClaimsSupported(item,[
    {name:'移动端推理',evidence_terms:['mobile inference','on-device']},
    {name:'离线运行',evidence_terms:['offline execution','run models locally']}
  ],claims),true);
});

test('AI 只证明了部分能力时，标签只展示有逐字证据的能力',()=>{
  const item = {description:'Expressive multilingual TTS with true-to-life voice cloning',topics:['tts'],readme_excerpt:''};
  const checks = [
    {name:'音频转录',evidence_terms:['audio transcription','speech to text']},
    {name:'高质量语音合成',evidence_terms:['expressive TTS','voice cloning']}
  ];
  const claims = [{capability:'高质量语音合成',evidence_quote:'Expressive multilingual TTS with true-to-life voice cloning'}];
  assert.deepEqual(search.supportedCapabilityClaims(item,checks,claims).map(check=>check.name),['高质量语音合成']);
  assert.equal(search.capabilityClaimsSupported(item,checks,claims),false);
});

test('能力证据不能用相邻能力冒充用户要求的录制回放',()=>{
  const item = {description:'Browser automation server using Playwright',topics:['mcp'],readme_excerpt:'Provides code generation in TypeScript and Python.'};
  const claims = [
    {capability:'网页操作录制',evidence_quote:'Browser automation server using Playwright'},
    {capability:'生成脚本',evidence_quote:'Provides code generation in TypeScript and Python.'}
  ];
  assert.equal(search.capabilityClaimsSupported(item,[
    {name:'网页操作录制',evidence_terms:['record user actions','record and replay','interaction capture']},
    {name:'生成脚本',evidence_terms:['code generation','export script']}
  ],claims),false);
});

test('用户未要求资源列表时识别并排除合集候选',()=>{
  const collection = {name:'awesome-mlsecops',description:'A curated list of machine learning security tools',readme_excerpt:'Collection of tools and resources.'};
  assert.equal(search.isCollectionCandidate(collection),true);
  assert.equal(search.wantsCollection({intent:'检测提示词注入',goal:'找到检测工具'}),false);
  assert.equal(search.wantsCollection({intent:'整理安全工具合集',goal:'找到资源列表'}),true);
});

test('用户未要求教程时排除课程和教学仓库',()=>{
  const course = {name:'automation-testing-course',description:'A complete Selenium tutorial and learning resource'};
  assert.equal(search.isInstructionalCandidate(course),true);
  assert.equal(search.wantsInstructional({intent:'找网页录制工具',goal:'录制并回放网页操作'}),false);
  assert.equal(search.wantsInstructional({intent:'找 Selenium 教程',goal:'学习网页自动化课程'}),true);
});

test('本地降级要求核心能力出现在仓库主元数据而非 README 偶然提及',()=>{
  const checks = [
    {name:'移动端推理',evidence_terms:['mobile inference','on-device']},
    {name:'离线运行',evidence_terms:['offline','local inference']}
  ];
  const direct = {full_name:'demo/mobile-runtime',description:'On-device mobile inference with offline execution',topics:['mobile-ai'],readme_excerpt:''};
  const incidental = {full_name:'demo/course',description:'AI learning course',topics:['education'],readme_excerpt:'A chapter mentions mobile inference and offline execution.'};
  assert.equal(search.primaryCapabilityEvidenceSupported(direct,checks),true);
  assert.equal(search.primaryCapabilityEvidenceSupported(incidental,checks),false);
});

test('AI 已确认 README 能力证据后不会在确定性排序中把全部候选丢掉',()=>{
  const plan = {
    goal:'把播客音频转成文字',
    intent:'寻找开源播客转文字工具',
    core_capabilities:['speech to text'],
    constraints:[],
    queries:['podcast transcription tool','speech to text transcription'],
    capability_checks:[{name:'音频转文字',evidence_terms:['speech to text','transcription']}]
  };
  const item = {
    full_name:'demo/audio-tool',name:'audio-tool',description:'Audio toolkit',topics:['audio'],
    readme_excerpt:'Transcribe podcast recordings with speech to text.',
    stargazers_count:8000,forks_count:200,pushed_at:new Date().toISOString(),license:{spdx_id:'MIT'}
  };
  assert.equal(search.fallbackRank(plan,[item]).length,0);
  assert.equal(search.fallbackRank(plan,[item],{allowReadmeEvidence:true})[0].full_name,'demo/audio-tool');
});

test('多词能力必须在同一语义窗口出现，不能把散落的 menu 和 translation 拼成菜单翻译',()=>{
  const checks = [{name:'菜单内容翻译',evidence_terms:['menu translation','menu localization']}];
  assert.equal(search.capabilityEvidenceSupportedInText('This plugin implements multilingual translation of resident menu bar items.',checks),true);
  assert.equal(search.capabilityEvidenceSupportedInText('Translation plugin for documents. The package also contains many unrelated sections and configuration examples before a context menu is mentioned.',checks),false);
});

test('存在完整组合词时忽略 i18n 和 localization 这类宽泛单词',()=>{
  const checks = [{name:'菜单内容翻译',evidence_terms:['menu translation','i18n','localization','translate menu']}];
  assert.equal(search.capabilityEvidenceSupportedInText('Developer friendly web localization platform with i18n workflows.',checks),false);
  assert.equal(search.capabilityEvidenceSupportedInText('Translate resident menu items and context menu labels.',checks),true);
});

test('多条件需求允许统计部分能力覆盖，用于完整方案优先、组件方案补充',()=>{
  const checks = [
    {name:'播客转写',evidence_terms:['podcast transcription','speech to text']},
    {name:'中文配音',evidence_terms:['Chinese dubbing','Mandarin speech synthesis']},
    {name:'多人说话人',evidence_terms:['speaker diarization','multiple speakers']}
  ];
  const complete = {description:'Podcast transcription with Chinese dubbing and multiple speakers.',topics:[],readme_excerpt:''};
  const partial = {description:'Natural Mandarin speech synthesis for multiple speakers.',topics:[],readme_excerpt:''};
  assert.equal(search.capabilityMatchCount(complete,checks),3);
  assert.equal(search.capabilityMatchCount(partial,checks),2);
});

test('复杂中文需求的降级计划不能被当作已经完成的 AI 理解结果',()=>{
  const plan = search.fallbackPlan('英文播客转成自然的中文多人对话');
  assert.equal(plan.mode,'fallback');
  assert.equal(plan.mode === 'ai',false);
});


test('前端智能搜索失败时不再降级展示未经验证的 GitHub 关键词结果',()=>{
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
  const searchBlock = html.slice(html.indexOf('async function searchGitHub'),html.indexOf('function card('));
  assert.match(searchBlock,/为避免给出不相关项目/);
  assert.doesNotMatch(searchBlock,/API \+ '\/search\/repositories\?'/);
});

test('AI 规划降级时证据必须覆盖原始需求而非只命中相邻能力',()=>{
  assert.equal(search.requestEvidenceSupported('把网页操作录制成可重复执行的自动化流程',['Android 录制回放和桌面控制']),false);
  assert.equal(search.requestEvidenceSupported('本地知识库检索 PDF 并回答问题',['本地部署的个人知识库，支持 PDF 文档检索并回答问题']),true);
});

test('通用排序把匹配证据放在纯 Star 之前',()=>{
  const plan = {goal:'agent evaluation tracing',intent:'评测 Agent 并追踪调用',core_capabilities:['evaluation','tracing'],constraints:[],queries:['agent evaluation tracing']};
  const items = [
    {full_name:'demo/relevant',name:'relevant',description:'Agent evaluation and tracing',topics:['agent','evaluation'],readme_excerpt:'Trace every tool call and evaluate agent runs.',stargazers_count:1200,forks_count:30,pushed_at:new Date().toISOString(),license:{spdx_id:'MIT'}},
    {full_name:'demo/popular',name:'popular',description:'Popular image collection',topics:['images'],readme_excerpt:'A large collection of images.',stargazers_count:100000,forks_count:500,pushed_at:new Date().toISOString(),license:{spdx_id:'MIT'}}
  ];
  const ranked = search.fallbackRank(plan,items);
  assert.equal(ranked[0].full_name,'demo/relevant');
});

test('降级排序不会因超长资源列表偶然出现关键词就优先推荐',()=>{
  const plan = {goal:'整理用户访谈并提取需求证据',intent:'用户访谈分析工具',core_capabilities:['interview analysis','evidence extraction'],constraints:[],queries:['interview analysis evidence extraction']};
  const items = [
    {full_name:'demo/interview-tool',name:'interview-tool',description:'User interview analysis and evidence extraction',topics:['interview-analysis'],readme_excerpt:'Organize interview transcripts into themes.',stargazers_count:900,forks_count:20,pushed_at:new Date().toISOString(),license:{spdx_id:'MIT'}},
    {full_name:'demo/awesome-tools',name:'awesome-tools',description:'A curated list of developer tools',topics:['awesome-list'],readme_excerpt:'Thousands of entries including interview analysis and evidence extraction.',stargazers_count:100000,forks_count:2000,pushed_at:new Date().toISOString(),license:{spdx_id:'MIT'}}
  ];
  const ranked = search.fallbackRank(plan,items);
  assert.equal(ranked[0].full_name,'demo/interview-tool');
  assert.ok(!ranked.some(item=>item.full_name === 'demo/awesome-tools'));
});

test('推荐价值信号包含技术基础设施而非只认终端产品',()=>{
  assert.ok(discover.attentionSignal({name:'runtime',description:'LLM inference runtime with evaluation and observability',topics:['model-serving']}) >= 2);
  assert.equal(discover.attentionSignal({name:'recipes',description:'A personal cooking recipe collection',topics:['food']}),0);
});

test('推荐降级不会仅因 audio、video、design 等宽泛词收入普通工具',()=>{
  assert.equal(discover.directAttentionSignal({name:'converter',description:'Offline file converter for PDF, video and audio',topics:['productivity']}),0);
  assert.equal(discover.directAttentionSignal({name:'editor',description:'Video editor with automation workflows and a fast runtime',topics:['design']}),0);
  assert.ok(discover.directAttentionSignal({name:'runtime',description:'On-device LLM inference runtime',topics:['edge-ai']}) > 0);
  const unrelated = discover.fallbackCopy({name:'converter',description:'Offline file converter for PDF, video and audio',topics:[],stargazers_count:5000,forks_count:20,license:{spdx_id:'MIT'}},'new',null,'',null);
  assert.equal(unrelated.relevant,false);
  assert.equal(discover.isResourceCollection({name:'awesome-agent-tools',description:'A curated list of AI agent tools'}),true);
  assert.equal(discover.fallbackCopy({name:'awesome-agent-tools',description:'A curated list of AI agent tools',topics:['ai'],stargazers_count:5000,forks_count:20,license:{spdx_id:'MIT'}},'new',null,'',null).relevant,false);
});

test('推荐降级允许收录对 AI 产品经理有明确价值的非 AI 项目',()=>{
  const analytics = {name:'product-insights',description:'Open source product analytics with session replay and feature flags',topics:['product-analytics'],stargazers_count:8000,forks_count:300,license:{spdx_id:'MIT'}};
  const prototype = {name:'prototype-kit',description:'Collaborative prototyping and design system for product teams',topics:['prototyping'],stargazers_count:5000,forks_count:120,license:{spdx_id:'MIT'}};
  const analyticsCopy = discover.fallbackCopy(analytics,'new',null,'x'.repeat(1200),null);
  const prototypeCopy = discover.fallbackCopy(prototype,'new',null,'x'.repeat(1200),null);
  assert.equal(analyticsCopy.relevant,true);
  assert.equal(analyticsCopy.attention_category,'product_operations');
  assert.equal(prototypeCopy.relevant,true);
  assert.equal(prototypeCopy.attention_category,'product_building');
});

test('AI 相关性判断缺少合格逐字证据时只保留主元数据明确相关的项目',()=>{
  const decision = {relevant:true,attention_score:80,quality_score:75};
  assert.equal(discover.conservativeDecisionSupported({name:'filee',description:'Offline file converter for PDF, video and audio',topics:[]},decision),false);
  assert.equal(discover.conservativeDecisionSupported({name:'n8n',description:'Workflow automation platform with native AI capabilities',topics:['ai']},decision),true);
  assert.equal(discover.conservativeDecisionSupported({name:'awesome-agents',description:'A curated list of AI agent tools',topics:['ai']},decision),false);
});

test('推荐文案必须带有能在仓库资料中逐字回查的证据',()=>{
  const candidate = {
    repo:{description:'Open-source LLM observability platform',topics:['evaluation']},
    release:{name:'v2',body:'Adds agent tracing'},
    readme:'Evaluate prompts and trace agent tool calls.'
  };
  assert.equal(discover.recommendationEvidenceSupported(candidate,['LLM observability platform','trace agent tool calls']),true);
  assert.equal(discover.recommendationEvidenceSupported(candidate,['supports offline voice cloning']),false);
  assert.equal(discover.recommendationEvidenceSupported(candidate,[]),false);
});

test('中文兜底不编造仓库没有提供的能力',()=>{
  const copy = discover.fallbackCopy({name:'sample',description:'A compact runtime',topics:[],stargazers_count:2000,forks_count:30,license:{spdx_id:'MIT'}},'new',null,'',null);
  assert.match(copy.summary,/仓库原始说明：A compact runtime/);
  assert.doesNotMatch(copy.summary,/支持|能够|自动/);
});

test('README 图片优先选取产品截图并过滤徽章',()=>{
  const repo = {full_name:'demo/repo',default_branch:'main'};
  const images = discover.readmeImages('![build](https://img.shields.io/build.svg)\n![UI](./docs/screenshot.png)',repo);
  assert.equal(images.length,1);
  assert.match(images[0],/screenshot\.png$/);
});


test('推荐证据校验与发送给模型的 Markdown 去标记文本一致',()=>{
  const item = {
    repo:{description:'',topics:[]},
    release:null,
    readme:'## Features\nBuild **AI agents** for **workflow automation** with templates.'
  };
  assert.equal(discover.recommendationEvidenceSupported(item,['Build AI agents for workflow automation with templates.']),true);
  assert.equal(discover.recommendationEvidenceSupported(item,['Includes offline video generation']),false);
});

test('产品封面可以从图片 alt 识别，忽略徽章和图标',()=>{
  const repo = {full_name:'demo/repo',default_branch:'main'};
  const readme = [
    '![logo](./assets/app-icon.png)',
    '![GitHub stars](https://img.shields.io/github/stars/demo/repo)',
    '![cover-v5-optimized](./images/GitHub_README_if.png)',
    '<img src="./docs/product_showcase.jpg" alt="Product showcase" />'
  ].join('\n');
  const images = discover.readmeImages(readme,repo);
  assert.equal(images.length,2);
  assert.ok(images.some(url=>url.endsWith('/GitHub_README_if.png')));
  assert.ok(images.some(url=>url.endsWith('/product_showcase.jpg')));
  assert.ok(!images.some(url=>url.includes('app-icon') || url.includes('shields.io')));
});

test('零付费默认配置不会启用任何模型请求',async()=>{
  const freeAI = require('../api/_lib/free-ai');
  assert.equal(freeAI.enabled(),false);
  await assert.rejects(()=>freeAI.generateJSON([{role:'user',content:'hello'}]),/free_ai_disabled/);
});

test('首页预先核对的中文介绍只在原始证据仍存在时启用',()=>{
  const repo = {
    full_name:'langgenius/dify',
    description:'Build Agentic workflows, RAG pipelines, with rich AI model and tool support on one collaborative workspace.'
  };
  const valid=discover.verifiedCachedCopy(repo);
  assert.ok(valid?.title?.includes('工作流'));
  assert.ok(valid?.summary?.length > 15);
  assert.equal(discover.verifiedCachedCopy({...repo,description:'Unrelated new project'}),null);
});

test('离线中文介绍的准入校验要求原始 Description 可回查',()=>{
  const refresh=require('../scripts/refresh-featured-copy.cjs');
  const repo={full_name:'owner/new-tool',description:'Open-source AI agent for turning meeting notes into action items'};
  assert.equal(refresh.validCopy({
    title:'把会议笔记整理为行动项',
    summary:'将会议内容整理成行动项目，便于进一步跟踪任务和工作进度。',
    evidence:'AI agent for turning meeting notes into action items'
  },repo),true);
  assert.equal(refresh.validCopy({
    title:'自动跨平台管理所有会议',
    summary:'支持所有平台和完整的语音视频录制、跨团队协作与永久免费。',
    evidence:'record audio and video from any platform'
  },repo),false);
  assert.equal(refresh.validCopy({
    title:'A meeting tool',summary:'Turns meeting notes into action items.',evidence:'meeting notes'
  },repo),false);
});

test('千问使用 Cloudflare Workers AI 免费路径，且不会自动调用付费网关',async()=>{
  const freeAI = require('../api/_lib/free-ai');
  const before = {
    FREE_AI_PROVIDER:process.env.FREE_AI_PROVIDER,
    CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN,
    ENABLE_FREE_GEMINI:process.env.ENABLE_FREE_GEMINI
  };
  try {
    process.env.FREE_AI_PROVIDER='cloudflare-qwen';
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    assert.equal(freeAI.provider(),null);
    await assert.rejects(
      ()=>freeAI.generateJSON([{role:'user',content:'找开源工具'}]),
      /free_ai_disabled/
    );
    process.env.CLOUDFLARE_ACCOUNT_ID='0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN='test-secret-not-real';
    assert.equal(freeAI.provider(),'cloudflare-free');
    assert.equal(freeAI.enabled(),true);
  } finally {
    for (const [key,value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});

test('Cloudflare Qwen 请求使用正确端点并解析自然语言搜索的 JSON',async()=>{
  const freeAI = require('../api/_lib/free-ai');
  const original = {
    provider:process.env.FREE_AI_PROVIDER,
    account:process.env.CLOUDFLARE_ACCOUNT_ID,
    token:process.env.CLOUDFLARE_API_TOKEN
  };
  const originalFetch=global.fetch;
  let requested;
  try {
    process.env.FREE_AI_PROVIDER='cloudflare-qwen';
    process.env.CLOUDFLARE_ACCOUNT_ID='0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN='test-secret-not-real';
    global.fetch=async (url,options)=>{
      requested={url,options};
      return {
        ok:true,
        json:async()=>({choices:[{message:{content:'{"intent":"寻找开源工具","queries":["workflow automation","agent tools"]}'}}]})
      };
    };
    const result=await freeAI.generateJSON([{role:'user',content:'找能自动完成任务的开源工具'}]);
    assert.equal(requested.url,'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1/chat/completions');
    assert.equal(JSON.parse(requested.options.body).model,'@cf/google/gemma-4-26b-a4b-it');
    assert.deepEqual(JSON.parse(requested.options.body).response_format,{type:'json_object'});
    assert.deepEqual(JSON.parse(requested.options.body).chat_template_kwargs,{enable_thinking:false});
    assert.deepEqual(result.queries,['workflow automation','agent tools']);
  } finally {
    global.fetch=originalFetch;
    for (const [key,value] of Object.entries({
      FREE_AI_PROVIDER:original.provider,
      CLOUDFLARE_ACCOUNT_ID:original.account,
      CLOUDFLARE_API_TOKEN:original.token
    })) {
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});

test('Cloudflare 多语言向量模型批量计算候选语义',async()=>{
  const freeAI = require('../api/_lib/free-ai');
  const original = {
    provider:process.env.FREE_AI_PROVIDER,
    account:process.env.CLOUDFLARE_ACCOUNT_ID,
    token:process.env.CLOUDFLARE_API_TOKEN
  };
  const originalFetch=global.fetch;
  let requested;
  try {
    process.env.FREE_AI_PROVIDER='cloudflare-qwen';
    process.env.CLOUDFLARE_ACCOUNT_ID='0123456789abcdef0123456789abcdef';
    process.env.CLOUDFLARE_API_TOKEN='test-secret-not-real';
    global.fetch=async (url,options)=>{
      requested={url,options};
      return {ok:true,json:async()=>({result:{data:[[1,0],[0.8,0.2]]}})};
    };
    const vectors=await freeAI.embedTexts(['中文需求','English repository']);
    assert.match(requested.url,/\/ai\/run\/@cf\/baai\/bge-m3$/);
    assert.deepEqual(JSON.parse(requested.options.body),{text:['中文需求','English repository']});
    assert.deepEqual(vectors,[[1,0],[0.8,0.2]]);
  } finally {
    global.fetch=originalFetch;
    for (const [key,value] of Object.entries({
      FREE_AI_PROVIDER:original.provider,
      CLOUDFLARE_ACCOUNT_ID:original.account,
      CLOUDFLARE_API_TOKEN:original.token
    })) {
      if (value===undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});

