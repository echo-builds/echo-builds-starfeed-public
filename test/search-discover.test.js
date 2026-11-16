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

test('多项必须能力会自动补充交叉召回词而不是依赖领域特判',()=>{
  const plan = {
    goal:'评测 Agent 是否可靠并追踪每一步调用',
    queries:['LLM agent reliability benchmark'],
    capability_checks:[
      {name:'Agent Evaluation',evidence_terms:['evaluation','benchmark']},
      {name:'Agent Tracing',evidence_terms:['tracing','observability']}
    ]
  };
  const queries = search.complementaryQueries(plan);
  assert.ok(queries.some(query=>/agent evaluation (?:tracing|observability)/i.test(query)));
  assert.ok(queries.includes('LLM agent reliability benchmark'));
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
  assert.ok(valid?.summary?.includes('工作流'));
  assert.equal(discover.verifiedCachedCopy({...repo,description:'Unrelated new project'}),null);
});
