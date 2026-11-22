const {configured,sql} = require('./_lib/db');

function integer(value,min,max,fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max,Math.max(min,number)) : fallback;
}

function itemOf(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const release = row.release_payload && typeof row.release_payload === 'object'
    ? row.release_payload : payload.release;
  return {
    ...payload,
    release,
    feed_event_id:Number(row.feed_event_id),
    feed_timeline_position:Number(row.timeline_position),
    feed_event_type:row.event_type,
    feed_published_at:row.feed_published_at,
    selection_reason:row.selection_reason || payload.selection_reason,
    feedResult:true
  };
}

module.exports = async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  if (!configured()) return res.status(503).json({error:'feed_database_not_configured'});
  const limit = integer(req.query?.limit,1,40,20);
  const before = integer(req.query?.before,1,Number.MAX_SAFE_INTEGER,null);
  const seen = integer(req.query?.seen,1,Number.MAX_SAFE_INTEGER,null);
  try {
    const db = sql();
    const rows = before
      ? await db`
          SELECT e.id AS feed_event_id,e.timeline_position,e.event_type,e.published_at AS feed_published_at,
            e.selection_reason,e.release_payload,p.payload
          FROM feed_events e
          JOIN projects p ON p.full_name_key=e.project_full_name_key
          WHERE e.status='published' AND e.timeline_position < ${before}
          ORDER BY e.timeline_position DESC LIMIT ${limit + 1}`
      : await db`
          SELECT e.id AS feed_event_id,e.timeline_position,e.event_type,e.published_at AS feed_published_at,
            e.selection_reason,e.release_payload,p.payload
          FROM feed_events e
          JOIN projects p ON p.full_name_key=e.project_full_name_key
          WHERE e.status='published'
          ORDER BY e.timeline_position DESC LIMIT ${limit + 1}`;
    const headRows = await db`SELECT max(id)::bigint AS head_id FROM feed_events WHERE status='published'`;
    const countRows = seen
      ? await db`SELECT count(*)::integer AS count FROM feed_events WHERE status='published' AND event_type<>'classic' AND id > ${seen}`
      : [{count:0}];
    const hasMore = rows.length > limit;
    const page = rows.slice(0,limit);
    return res.status(200).json({
      items:page.map(itemOf),
      head_id:headRows[0]?.head_id ? Number(headRows[0].head_id) : null,
      new_count:Number(countRows[0]?.count || 0),
      next_cursor:hasMore && page.length ? Number(page[page.length - 1].timeline_position) : null,
      has_more:hasMore,
      source:'persistent_feed'
    });
  } catch(error) {
    return res.status(502).json({error:'feed_unavailable',detail:String(error?.message || '').slice(0,120)});
  }
};
