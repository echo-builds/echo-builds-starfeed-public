const {configured,sql} = require('../api/_lib/db');

const TARGETS={
  library_size:100,
  content_ready_rate:.9,
  cover_rate:.65,
  copy_complete_rate:1,
  evidence_rate:1,
  invalid_tag_count:0
};

function number(value) {
  const parsed=Number(value || 0);
  return Number.isFinite(parsed)?parsed:0;
}

function rate(value,total) {
  return total ? Math.round((number(value)/total)*1000)/1000 : 0;
}

function buildQualityReport(summary,categories=[],recentRuns=[]) {
  const total=number(summary.total);
  const metrics={
    library_size:total,
    content_ready_rate:rate(summary.content_ready,total),
    cover_rate:rate(summary.with_cover,total),
    copy_complete_rate:rate(summary.copy_complete,total),
    evidence_rate:rate(summary.with_evidence,total),
    experience_rate:rate(summary.with_experience,total),
    invalid_tag_count:number(summary.invalid_tags),
    tags:{
      important_release:number(summary.important_release),
      github_trending:number(summary.github_trending),
      recent_surge:number(summary.recent_surge),
      none:number(summary.no_tag)
    }
  };
  const checks={
    library_size:metrics.library_size>=TARGETS.library_size,
    content_ready_rate:metrics.content_ready_rate>=TARGETS.content_ready_rate,
    cover_rate:metrics.cover_rate>=TARGETS.cover_rate,
    copy_complete_rate:metrics.copy_complete_rate>=TARGETS.copy_complete_rate,
    evidence_rate:metrics.evidence_rate>=TARGETS.evidence_rate,
    invalid_tag_count:metrics.invalid_tag_count===TARGETS.invalid_tag_count
  };
  return {
    generated_at:new Date().toISOString(),
    targets:TARGETS,
    metrics,
    checks,
    automated_checks_passed:Object.values(checks).filter(Boolean).length,
    automated_checks_total:Object.keys(checks).length,
    categories:Object.fromEntries(categories.map(row=>[row.category || 'uncategorized',number(row.count)])),
    recent_scans:recentRuns.map(row=>({
      id:number(row.id),status:row.status,candidates:number(row.candidates),published:number(row.published),
      started_at:row.started_at,finished_at:row.finished_at
    }))
  };
}

async function main() {
  if (!configured()) throw new Error('DATABASE_URL is required');
  const db=sql();
  const rows=await db`
    WITH published_projects AS (
      SELECT p.full_name_key,p.category,p.payload
      FROM projects p
      WHERE EXISTS (
        SELECT 1 FROM feed_events e
        WHERE e.project_full_name_key=p.full_name_key AND e.status='published'
      )
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE payload->>'content_ready'='true')::int AS content_ready,
      COUNT(*) FILTER (WHERE COALESCE(payload->>'cover','')<>'')::int AS with_cover,
      COUNT(*) FILTER (WHERE COALESCE(payload->>'title','')<>'' AND COALESCE(payload->>'cover_copy','')<>'' AND COALESCE(payload->>'selection_reason','')<>'')::int AS copy_complete,
      COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(payload->'evidence_quotes','[]'::jsonb))>0)::int AS with_evidence,
      COUNT(*) FILTER (WHERE payload->'experience' IS NOT NULL AND payload->'experience'<>'null'::jsonb)::int AS with_experience,
      COUNT(*) FILTER (WHERE COALESCE(payload->>'attention_tag','') NOT IN ('','重要更新','GitHub Trending','近期爆发'))::int AS invalid_tags,
      COUNT(*) FILTER (WHERE payload->>'attention_tag'='重要更新')::int AS important_release,
      COUNT(*) FILTER (WHERE payload->>'attention_tag'='GitHub Trending')::int AS github_trending,
      COUNT(*) FILTER (WHERE payload->>'attention_tag'='近期爆发')::int AS recent_surge,
      COUNT(*) FILTER (WHERE COALESCE(payload->>'attention_tag','')='')::int AS no_tag
    FROM published_projects`;
  const categories=await db`
    SELECT COALESCE(p.category,'uncategorized') AS category,COUNT(*)::int AS count
    FROM projects p
    WHERE EXISTS (
      SELECT 1 FROM feed_events e
      WHERE e.project_full_name_key=p.full_name_key AND e.status='published'
    )
    GROUP BY COALESCE(p.category,'uncategorized') ORDER BY count DESC`;
  const recentRuns=await db`
    SELECT id,status,candidates,published,started_at,finished_at
    FROM scan_runs ORDER BY id DESC LIMIT 5`;
  console.log(JSON.stringify(buildQualityReport(rows[0] || {},categories,recentRuns)));
}

if (require.main===module) main().catch(error=>{ console.error(error); process.exitCode=1; });

module.exports._test={TARGETS,buildQualityReport,rate};
