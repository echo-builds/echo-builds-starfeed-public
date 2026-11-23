const test=require('node:test');
const assert=require('node:assert/strict');

const content=require('../api/_lib/project-content');
const feed=require('../scripts/scan-feed.cjs')._test;

test('产品详情只选产品介绍并排除安装和开发章节',()=>{
  const markdown=[
    '# Demo','A tool for product teams.','## Features','- Record interviews','- Extract evidence',
    '## Installation','npm install demo','## Development','Run tests'
  ].join('\n');
  const selected=content.selectProductMarkdown(markdown);
  assert.match(selected,/Record interviews/);
  assert.doesNotMatch(selected,/npm install/);
  assert.doesNotMatch(selected,/Run tests/);
});

test('产品详情保留自然语言标题下的连续产品叙事',()=>{
  const markdown=[
    '# 岛仔 · Daozai','一座小岛，装下桌面日常。',
    '## 微信里有新消息，看一眼岛边','微信和 QQ 未读提醒。',
    '## 换个皮肤，也换个位置','支持五款皮肤和三边停靠。',
    '## 听歌时，歌词就在抬眼处','播放、暂停、切歌和歌词。',
    '## 日程、待办和专注，放在一起','| 想做的事 | 岛仔能帮你 |','| --- | --- |','| 专心做事 | 专注与休息计时 |',
    '## 下载安装','下载安装包。','## 开源与致谢','感谢贡献者。'
  ].join('\n');
  const selected=content.selectProductMarkdown(markdown);
  assert.match(selected,/微信和 QQ 未读提醒/);
  assert.match(selected,/五款皮肤和三边停靠/);
  assert.match(selected,/播放、暂停、切歌和歌词/);
  assert.match(selected,/\| 想做的事 \| 岛仔能帮你 \|/);
  assert.doesNotMatch(selected,/下载安装包/);
  assert.doesNotMatch(selected,/感谢贡献者/);
});

test('长 README 会被拆成短段翻译并保存为准备完成状态',async()=>{
  const calls=[];
  const freeAI={
    enabled:()=>true,
    generate:async messages=>{
      calls.push(messages);
      return '# 中文介绍\n这是忠实翻译后的产品能力。';
    }
  };
  const readme=['# Product','English product overview. '.repeat(80),'## Features','Useful workflow. '.repeat(90)].join('\n');
  const prepared=await content.prepareProjectContent({
    readme,repo:{full_name:'demo/product',default_branch:'main'},release:null,freeAI
  });
  assert.equal(prepared.content_ready,true);
  assert.equal(prepared.content_pipeline_version,content.CONTENT_PIPELINE_VERSION);
  assert.equal(prepared.translation_status,'translated');
  assert.ok(calls.length>=2);
  assert.match(prepared.readme_markdown,/中文介绍/);
});

test('翻译失败不会把英文 README 发布给用户',async()=>{
  const prepared=await content.prepareProjectContent({
    readme:'# Product\nAn English product overview and useful features.',
    repo:{full_name:'demo/product',default_branch:'main'},release:null,
    freeAI:{enabled:()=>true,generate:async()=>{throw new Error('timeout');}}
  });
  assert.equal(prepared.content_ready,false);
  assert.equal(prepared.translation_status,'pending');
  assert.equal(prepared.readme_markdown,'');
});

test('关注标签严格按重要更新、Trending、近期爆发排序',()=>{
  const base={eventType:'new',isTrending:false,starVelocity:80,starDelta:20,hasPrevious:true,stars:1000};
  assert.equal(feed.attentionTag({...base,eventType:'release',isTrending:true}),'重要更新');
  assert.equal(feed.attentionTag({...base,isTrending:true}),'GitHub Trending');
  assert.equal(feed.attentionTag(base),'近期爆发');
  assert.equal(feed.attentionTag({...base,starDelta:2}),'');
});

test('候选按产品赛道配比抽取，避免 AI 基础设施挤满首页',()=>{
  const lanes=['ai_capability','ai_product','product_building','product_operations','product_inspiration'];
  const entries=[];
  for (const lane of lanes) for (let index=0;index<20;index++) entries.push({lane,repo:{full_name:`${lane}/${index}`,name:String(index),description:'',topics:[],stargazers_count:100000-index,created_at:'2026-01-01',forks_count:100}});
  const selected=feed.balancedEntries(entries,20);
  const counts=Object.fromEntries(lanes.map(lane=>[lane,selected.filter(item=>item.lane===lane).length]));
  assert.deepEqual(counts,{ai_capability:5,ai_product:5,product_building:4,product_operations:3,product_inspiration:3});
});

test('旧项目连续两次不合格才从推荐流移除',()=>{
  const first=feed.nextQualityReview(null,{keep:false,reject_reason:'纯安全攻防工具'},'2026-11-22T01:00:00Z');
  assert.equal(first.reject_streak,1);
  assert.equal(feed.shouldRemoveExisting(first),false);
  const second=feed.nextQualityReview(first,{keep:false,reject_reason:'仍然缺少通用产品价值'},'2026-11-22T07:00:00Z');
  assert.equal(second.reject_streak,2);
  assert.equal(feed.shouldRemoveExisting(second),true);
});

test('一次合格复审会清空旧项目的连续拒绝记录',()=>{
  const previous={status:'rejected',reject_streak:1,last_reason:'证据不足'};
  const approved=feed.nextQualityReview(previous,{keep:true},'2026-11-22T07:00:00Z');
  assert.deepEqual(approved,{status:'approved',reject_streak:0,last_reason:'',last_reviewed_at:'2026-11-22T07:00:00Z'});
  assert.equal(feed.shouldRemoveExisting(approved),false);
});

test('分类服务没有结论时保持旧项目原状态',()=>{
  const previous={status:'rejected',reject_streak:1,last_reason:'证据不足'};
  assert.equal(feed.nextQualityReview(previous,null),previous);
});


test('README 中相对图片和链接会解析成可访问的 GitHub 地址',()=>{
  const markdown='<p align="center"><img src="./assets/hero.png"></p>\n[Quick start](docs/start.md)';
  const resolved=content.resolveReadmeUrls(markdown,{full_name:'demo/product',default_branch:'main'});
  assert.match(resolved,/raw\.githubusercontent\.com\/demo\/product\/main\/assets\/hero\.png/);
  assert.match(resolved,/github\.com\/demo\/product\/blob\/main\/docs\/start\.md/);
});

test('翻译指令要求保留 HTML 结构和产品名',async()=>{
  const prompts=[];
  await content.prepareProjectContent({
    readme:'# Pinky\n<p align="center">Control your phone.</p>',
    repo:{full_name:'demo/pinky',default_branch:'main'},release:null,
    freeAI:{enabled:()=>true,generate:async messages=>{prompts.push(messages);return '# Pinky\n<p align="center">控制你的手机。</p>';}}
  });
  const system=prompts[0][0].content;
  assert.match(system,/HTML 标签、属性、URL、锚点、对齐方式和嵌套结构/);
  assert.match(system,/项目名、产品名和专有名词保持原文/);
});


test('仓库自带简体中文 README 时优先使用官方中文版本',()=>{
  const paths=feed.localizedChineseReadmePaths(
    '<a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>',
    {full_name:'DIYgod/pinky',default_branch:'main'}
  );
  assert.deepEqual(paths,['README.zh-CN.md']);
});
