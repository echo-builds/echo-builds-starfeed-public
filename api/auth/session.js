const {clearSession,getSession,refreshSession,setSession} = require('../_lib/session');

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'method_not_allowed'});
  const result = await refreshSession(getSession(req));
  if (!result.session) {
    clearSession(res);
    return res.status(200).json({user:null});
  }
  if (result.refreshed) setSession(res,result.session);
  res.status(200).json({user:result.session.user});
};
