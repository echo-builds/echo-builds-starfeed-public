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
  assert.match(html,/中文详情正在后台准备/);
  assert.doesNotMatch(html,/当前显示 README 原文（中文翻译暂不可用）/);
  assert.doesNotThrow(()=>new Function('require','module','exports',project));
});

test('卡片只接受三种关注标签且与 Star 同行展示',()=>{
  assert.match(html,/new Set\(\['重要更新','GitHub Trending','近期爆发'\]\)/);
  assert.match(html,/class="card-meta"><span class="stars"><\/span><span class="published"><\/span>/);
});

test('数据库时间线不会混入静态精选并按事件倒序',()=>{
  const block=html.slice(html.indexOf('async function loadDiscover'),html.indexOf('function readFavorites'));
  assert.match(block,/current\.filter\(repo=>repo\.feed_event_id\)/);
  assert.match(block,/Number\(b\.feed_event_id \|\| 0\)-Number\(a\.feed_event_id \|\| 0\)/);
});
