const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
const feed=fs.readFileSync(path.join(__dirname,'../api/feed.js'),'utf8');
const scanner=fs.readFileSync(path.join(__dirname,'../scripts/scan-feed.cjs'),'utf8');
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/backfill-classics.yml'),'utf8');

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
  assert.match(workflow,/default: '20'/);
});
