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
test('README 中文翻译与原文降级有明确来源状态',()=>{
  assert.match(project,/translation_status:translationStatus/);
  assert.match(html,/当前显示 README 原文（中文翻译暂不可用）/);
  assert.doesNotThrow(()=>new Function('require','module','exports',project));
});
