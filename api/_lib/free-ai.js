// Explicit free-only providers. Never fall back to a paid AI Gateway.
const GEMINI_MODEL = process.env.GEMINI_FREE_MODEL || 'gemini-2.5-flash-lite';
// Fixed model prevents accidental paid-model selection.
const CLOUDFLARE_QWEN_MODEL = '@cf/qwen/qwen3.8-27b';
let active = 0;
let cooldownUntil = 0;

function provider() {
  const selection = String(process.env.FREE_AI_PROVIDER || '').trim().toLowerCase();
  if (selection === 'cloudflare-qwen') {
    if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN &&
        /^[0-9a-f]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID)) return 'cloudflare-qwen';
    return null;
  }
  if (selection !== '' && selection !== 'gemini') return null;
  if (process.env.ENABLE_FREE_GEMINI === 'true' &&
      process.env.GEMINI_API_KEY && /^[A-Za-z0-9._-]+$/.test(GEMINI_MODEL)) return 'gemini';
  return null;
}
function enabled() { return Boolean(provider()); }

async function callGemini(messages,options) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',{
      method:'POST',
      headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:messages.filter(m=>m?.content).map(m=>({
          role:m.role === 'assistant' ? 'model' : 'user',
          parts:[{text:String(m.content)}]
        })),
        generationConfig:{
          temperature:options.temperature ?? 0.1,
          maxOutputTokens:Math.min(6000,Math.max(128,options.maxTokens || 1600)),
          ...(options.json === false ? {} : {responseMimeType:'application/json'})
        }
      }),
      signal:AbortSignal.timeout(25000)
    }
  );
  if (!response.ok) {
    const error = new Error('free_ai_http_'+response.status);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const text = (payload.candidates?.[0]?.content?.parts || [])
    .map(p=>p.text || '').join('').trim();
  if (!text) throw new Error('free_ai_empty');
  return text;
}

async function callCloudflareQwen(messages,options) {
  // Workers AI is free on the Workers Free plan up to its daily allocation.
  // A Paid plan is not recommended for this zero-cost project.
  const url = 'https://api.cloudflare.com/client/v4/accounts/' +
    process.env.CLOUDFLARE_ACCOUNT_ID + '/ai/v1/chat/completions';
  const response = await fetch(url,{
    method:'POST',
    headers:{
      Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:CLOUDFLARE_QWEN_MODEL,
      messages:messages.filter(m=>m?.content).map(m=>({
        role:['system','assistant','user'].includes(m.role) ? m.role : 'user',
        content:String(m.content)
      })),
      temperature:options.temperature ?? 0.1,
      max_tokens:Math.min(5000,Math.max(128,options.maxTokens || 1600)),
      stream:false
    }),
    signal:AbortSignal.timeout(25000)
  });
  if (!response.ok) {
    const error = new Error('free_ai_http_'+response.status);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const answer = payload.choices?.[0]?.message?.content;
  const text = typeof answer === 'string'
    ? answer.trim()
    : Array.isArray(answer)
      ? answer.map(part=>part.text || '').join('').trim()
      : '';
  if (!text) throw new Error('free_ai_empty');
  return text;
}

async function generate(messages,options={}) {
  const current = provider();
  if (!current) throw new Error('free_ai_disabled');
  if (Date.now() < cooldownUntil) throw new Error('free_ai_rate_limited');
  if (active >= 2) throw new Error('free_ai_busy');
  active++;
  try {
    return current === 'cloudflare-qwen'
      ? await callCloudflareQwen(messages,options)
      : await callGemini(messages,options);
  } catch(error) {
    if ([402,403,429].includes(error?.status)) cooldownUntil = Date.now() + 15*60*1000;
    throw error;
  } finally { active--; }
}

function parseJSON(raw) {
  const source = String(raw || '').trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
  try { return JSON.parse(source); }
  catch {
    const match = source.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('free_ai_invalid_json');
    return JSON.parse(match[0]);
  }
}
async function generateJSON(messages,options={}) {
  return parseJSON(await generate(messages,options));
}
module.exports={provider,enabled,generate,generateJSON};
