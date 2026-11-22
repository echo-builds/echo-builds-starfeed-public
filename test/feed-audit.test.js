const test = require('node:test');
const assert = require('node:assert/strict');
const {buildQualityReport,rate} = require('../scripts/audit-feed.cjs')._test;

test('rate handles empty and populated libraries',()=>{
  assert.equal(rate(9,10),.9);
  assert.equal(rate(1,3),.333);
  assert.equal(rate(0,0),0);
});

test('quality report evaluates the agreed daily-use targets',()=>{
  const report=buildQualityReport({
    total:100,content_ready:92,with_cover:70,copy_complete:100,with_evidence:100,
    with_experience:45,invalid_tags:0,important_release:2,github_trending:3,recent_surge:4,no_tag:91
  },[{category:'ai_product',count:40}],[{id:8,status:'completed',candidates:20,published:2}]);
  assert.equal(report.automated_checks_passed,6);
  assert.equal(report.metrics.content_ready_rate,.92);
  assert.deepEqual(report.metrics.tags,{important_release:2,github_trending:3,recent_surge:4,none:91});
  assert.equal(report.categories.ai_product,40);
});

test('quality report exposes failed thresholds instead of hiding them',()=>{
  const report=buildQualityReport({
    total:40,content_ready:20,with_cover:10,copy_complete:39,with_evidence:30,invalid_tags:1
  });
  assert.equal(report.automated_checks_passed,0);
  assert.equal(report.checks.library_size,false);
  assert.equal(report.checks.invalid_tag_count,false);
});
