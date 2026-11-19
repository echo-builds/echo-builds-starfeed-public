const {getSession,refreshSession,setSession} = require('./_lib/session');
const {configured,sql} = require('./_lib/db');

function eventId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (!configured()) return res.status(503).json({error:'feed_database_not_configured'});
  const auth = await refreshSession(getSession(req));
  if (!auth.session?.user?.login) return res.status(401).json({error:'authentication_required'});
  if (auth.refreshed) setSession(res,auth.session);
  const login = String(auth.session.user.login).toLowerCase();
  const userId = eventId(auth.session.user.id);
  const db = sql();
  try {
    if (req.method === 'GET') {
      const rows = await db`
        SELECT latest_seen_event_id,resume_event_id,updated_at
        FROM user_progress WHERE github_login=${login}`;
      return res.status(200).json({progress:rows[0] || null});
    }
    if (req.method === 'PUT') {
      const latest = eventId(req.body?.latest_seen_event_id);
      const resume = eventId(req.body?.resume_event_id);
      if (!latest && !resume) return res.status(400).json({error:'progress_required'});
      const rows = await db`
        INSERT INTO user_progress
          (github_login,github_user_id,latest_seen_event_id,resume_event_id,updated_at)
        VALUES (${login},${userId},${latest},${resume},now())
        ON CONFLICT (github_login) DO UPDATE SET
          github_user_id=COALESCE(EXCLUDED.github_user_id,user_progress.github_user_id),
          latest_seen_event_id=CASE
            WHEN EXCLUDED.latest_seen_event_id IS NULL THEN user_progress.latest_seen_event_id
            ELSE GREATEST(COALESCE(user_progress.latest_seen_event_id,0),EXCLUDED.latest_seen_event_id)
          END,
          resume_event_id=COALESCE(EXCLUDED.resume_event_id,user_progress.resume_event_id),
          updated_at=now()
        RETURNING latest_seen_event_id,resume_event_id,updated_at`;
      return res.status(200).json({progress:rows[0]});
    }
    return res.status(405).json({error:'method_not_allowed'});
  } catch(error) {
    return res.status(502).json({error:'progress_unavailable',detail:String(error?.message || '').slice(0,120)});
  }
};
