const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
const feed=fs.readFileSync(path.join(__dirname,'../api/feed.js'),'utf8');
const scanner=fs.readFileSync(path.join(__dirname,'../scripts/scan-feed.cjs'),'utf8');
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/backfill-classics.yml'),'utf8');
const packageJson=require('../package.json');

test('历史项目使用独立时间线位置追加到底部',()=>{
  assert.match(schema,/timeline_position bigint/);
  assert.match(scanner,/min\(timeline_position\)/);
  assert.match(scanner,/max\(timeline_position\)/);
  assert.match(feed,/ORDER BY e\.timeline_position DESC/);
  assert.match(feed,/next_cursor:[^\n]+timeline_position/);
});

test('历史回填不会触发新项目提示',()=>{
  assert.match(feed,/event_type<>'classic'/);
});

test('每天后台审核一批历史经典项目',()=>{
  assert.match(workflow,/cron: '43 4 \* \* \*'/);
  assert.match(workflow,/--backfill=/);
  assert.match(workflow,/default: '200'/);
});

test('内容升级失败时保留上一个可读版本并小批量重试',()=>{
  assert.match(scanner,/failed content-pipeline upgrade must never replace/);
  assert.match(scanner,/stored\.content_ready===true && stored\.readme_markdown/);
  assert.match(scanner,/content_refresh_error/);
  assert.equal(packageJson.scripts['feed:refresh'],'node scripts/scan-feed.cjs --refresh=10');
});

test('内容迁移优先处理用户最容易看到的顶部项目',()=>{
  assert.match(scanner,/max\(e\.timeline_position\)/);
  assert.match(scanner,/timeline_position[\s\S]+DESC/);
});

test('已发布项目的内容升级不依赖 AI 重新批准',()=>{
  assert.match(scanner,/retainExistingApproval=item\.existing && !decision/);
  assert.match(scanner,/!keep && !cached && !retainExistingApproval/);
  assert.match(scanner,/storedPayload\?\.ai_title/);
  assert.match(scanner,/stored\.evidence_quotes/);
});

test('六小时常规扫描优先补齐缺失或旧版详情',()=>{
  assert.match(scanner,/SELECT full_name_key,payload FROM projects[\s\S]+content_ready[\s\S]+content_pipeline_version[\s\S]+last_scanned_at ASC LIMIT 80/);
});


test('历史补库分类服务不可用时明确失败，不伪装成成功',()=>{
  assert.match(scanner,/backfill_classifier_unavailable/);
  assert.match(scanner,/backfillTarget && candidates\.length && decisions\.size===0/);
});
