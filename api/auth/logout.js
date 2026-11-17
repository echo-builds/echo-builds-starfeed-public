const {clearSession} = require('../_lib/session');

module.exports = function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') return res.status(405).json({error:'method_not_allowed'});
  clearSession(res);
  res.status(204).end();
};
