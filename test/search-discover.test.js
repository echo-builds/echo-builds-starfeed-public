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

test('排序结果必须为每项核心能力提供可回查证据',()=>{
  const item = {description:'Agent evaluation platform with tool call tracing',topics:['observability'],readme_excerpt:'Trace every tool call and compare agent evaluations.'};
  const claims = [
    {capability:'Agent 可靠性评测',evidence_quote:'compare agent evaluations'},
    {capability:'工具调用追踪',evidence_quote:'Trace every tool call'}
  ];
  assert.equal(search.capabilityClaimsSupported(item,['Agent 可靠性评测','工具调用追踪'],claims),true);
  assert.equal(search.capabilityClaimsSupported(item,['Agent 可靠性评测','工具调用追踪'],claims.slice(0,1)),false);
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
