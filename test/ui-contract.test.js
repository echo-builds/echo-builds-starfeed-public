const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const project = fs.readFileSync(path.join(__dirname,'../api/project.js'),'utf8');

test('前端脚本语法正确且登录后自动同步 Stars',()=>{
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(()=>new Function(script));
  assert.match(script,/await syncGitHubStars\(\);/);
  assert.match(script,/state\.pendingLocal = failed/);
  assert.match(script,/for \(const repo of localOnly\)/);
});
test('同步页只有自动状态与失败重试，不再询问导入本机收藏',()=>{
  assert.match(html,/id="auth-sync-state"/);
  assert.match(html,/id="auth-retry"/);
  assert.doesNotMatch(html,/id="local-import"/);
  assert.doesNotMatch(html,/id="local-import-yes"/);
  assert.doesNotMatch(html,/id="local-import-no"/);
  assert.doesNotMatch(html,/id="auth-sync"/);
});
test('推荐流详情优先使用数据库预处理中文，不再现场展示英文 README',()=>{
  assert.match(project,/stored\?\.payload\?\.content_ready===true/);
  assert.match(project,/Never make the/);
  assert.match(html,/repo\.content_ready===true && repo\.readme_markdown/);
  assert.match(html,/Number\(repo\.content_pipeline_version \|\| 0\)===5/);
  assert.match(html,/中文详情正在后台准备/);
  assert.doesNotMatch(html,/当前显示 README 原文（中文翻译暂不可用）/);
  assert.doesNotThrow(()=>new Function('require','module','exports',project));
});

test('卡片只展示推荐原因，不展示更新状态',()=>{
  assert.match(html,/new Set\(\['GitHub Trending','近期爆发'\]\)/);
  assert.doesNotMatch(html,/feed_event_type==='release'\?'重要更新'/);
  assert.match(html,/class="card-meta"><span class="stars"><\/span><span class="published"><\/span>/);
});

test('数据库时间线不会混入静态精选并保持更新批次与续看顺序',()=>{
  const block=html.slice(html.indexOf('async function loadDiscover'),html.indexOf('function readFavorites'));
  assert.match(block,/current\.filter\(repo=>repo\.feed_event_id\)/);
  assert.match(block,/uniqueProjects\(\[\.\.\.state\.updateBatch/);
  assert.doesNotMatch(block,/\.sort\(/);
});

test('README 表格按真实表格渲染并兼容行间空行',()=>{
  assert.match(html,/function markdownTableCells/);
  assert.match(html,/function markdownLines/);
  assert.match(html,/document\.createElement\('table'\)/);
  assert.match(html,/className='table-scroll'/);
});


test('搜索卡片不再回退展示长段英文仓库简介',()=>{
  assert.match(html,/暂未生成可靠的中文说明/);
  assert.doesNotMatch(html,/仓库原始说明：/);
  assert.match(html,/经过仓库资料核验的候选项目/);
});

test('回访时直接展示更新批次，读完后继续上次位置',()=>{
  assert.doesNotMatch(html,/id="new-projects"/);
  assert.match(html,/你离开后更新了 \$\{count\} 个项目/);
  assert.match(html,/本次更新已看完/);
  assert.match(html,/下面从你上次看到的位置继续/);
  assert.match(html,/dataset\.updateCard = 'true'/);
  assert.match(html,/updateBoundaryObserver/);
  assert.doesNotMatch(html,/behavior:'smooth'/);
});

test('README 翻译后保留标题、居中、链接、图片、表格和段落结构',()=>{
  assert.match(html,/function appendReadmeHtml/);
  assert.match(html,/new DOMParser\(\)/);
  assert.match(html,/classList\.add\('readme-center'\)/);
  assert.match(html,/classList\.add\('readme-table'\)/);
  assert.match(html,/function appendMarkdownInline/);
  assert.match(html,/readme-inline-image/);
  assert.match(html,/function markdownTableCells/);
});


test('推荐流详情会主动读取 V5 内容并绕开旧失败缓存',()=>{
  assert.match(html,/正在获取最新中文详情/);
  assert.match(html,/content_version=5/);
  assert.match(html,/cache:'no-store'/);
  assert.match(project,/Cache-Control','private, no-store/);
});


test('首页不再展示通用搜索入口',()=>{
  assert.match(html,/id="search-dock"[^>]*hidden/);
  assert.match(html,/\$\('#search-dock'\)\.hidden = true/);
  assert.match(html,/从产品经理视角，发现并看懂值得关注的开源项目/);
});
