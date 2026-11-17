const crypto = require('crypto');

const SESSION_COOKIE = 'starfeed_session';
const STATE_COOKIE = 'starfeed_oauth_state';

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return crypto.createHash('sha256').update(secret).digest();
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key(),iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return [encode(iv),encode(cipher.getAuthTag()),encode(ciphertext)].join('.');
}

function decrypt(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const [iv,tag,ciphertext] = token.split('.').map(part=>Buffer.from(part,'base64url'));
    if (!iv || !tag || !ciphertext) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm',key(),iv);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
    return JSON.parse(value);
  } catch { return null; }
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const index = part.indexOf('=');
    const name = index < 0 ? part : part.slice(0,index);
    const value = index < 0 ? '' : part.slice(index + 1);
    try { return [name,decodeURIComponent(value)]; } catch { return [name,value]; }
  }));
}

function appendCookie(res,value) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie',current ? [...(Array.isArray(current) ? current : [current]),value] : value);
}

function cookie(name,value,maxAge) {
  const parts = [`${name}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','Secure','SameSite=Lax'];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0,Math.floor(maxAge))}`);
  return parts.join('; ');
}

function setSession(res,session) {
  const refreshSeconds = Math.max(3600,Math.min(15552000,Math.floor(((session.refreshTokenExpiresAt || Date.now() + 15552000000) - Date.now()) / 1000)));
  appendCookie(res,cookie(SESSION_COOKIE,encrypt(session),refreshSeconds));
}

function clearSession(res) {
  appendCookie(res,cookie(SESSION_COOKIE,'',0));
}

function getSession(req) {
  return decrypt(cookies(req)[SESSION_COOKIE]);
}

function setOAuthState(res,value) {
  appendCookie(res,cookie(STATE_COOKIE,encrypt(value),600));
}

function getOAuthState(req) {
  return decrypt(cookies(req)[STATE_COOKIE]);
}

function clearOAuthState(res) {
  appendCookie(res,cookie(STATE_COOKIE,'',0));
}

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  return `${protocol}://${host}`;
}

async function refreshSession(session) {
  if (!session) return {session:null,refreshed:false};
  if (!session.expiresAt || session.expiresAt > Date.now() + 60000) return {session,refreshed:false};
  if (!session.refreshToken || (session.refreshTokenExpiresAt && session.refreshTokenExpiresAt <= Date.now())) return {session:null,refreshed:false};
  const response = await fetch('https://github.com/login/oauth/access_token',{
    method:'POST',
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({
      client_id:process.env.GITHUB_CLIENT_ID,
      client_secret:process.env.GITHUB_CLIENT_SECRET,
      grant_type:'refresh_token',
      refresh_token:session.refreshToken
    })
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) return {session:null,refreshed:false};
  return {session:{
    ...session,
    accessToken:token.access_token,
    expiresAt:Date.now() + Number(token.expires_in || 28800) * 1000,
    refreshToken:token.refresh_token || session.refreshToken,
    refreshTokenExpiresAt:Date.now() + Number(token.refresh_token_expires_in || 15552000) * 1000
  },refreshed:true};
}

module.exports = {
  clearOAuthState,clearSession,getOAuthState,getSession,originOf,refreshSession,
  safeReturnTo,setOAuthState,setSession
};
