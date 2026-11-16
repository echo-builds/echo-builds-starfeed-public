// Free Gemini is opt-in. No automatic paid AI Gateway fallback.
const MODEL = process.env.GEMINI_FREE_MODEL || 'gemini-2.5-flash-lite';
let active=0, cooldownUntil=0;
function enabled() {
  return process.env.ENABLE_FREE_GEMINI === 'true' &&
    Boolean(process.env.GEMINI_API_KEY) &&
    /^[A-Za-z0-9._-]+$/.test(MODEL);
}
async function generate(messages,options={}) {
  if (!enabled()) throw new Error('free_ai_disabled');
  if (Date.now()<cooldownUntil) throw new Error('free_ai_rate_limited');
  if (active>=2) throw new Error('free_ai_busy');
  active++;
  try {
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+MODEL+':generateContent',{
      method:'POST',
      headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:messages.filter(m=>m.content).map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.content)}]})),
        generationConfig:{
          temperature:options.temperature??0.1,
          maxOutputTokens:Math.min(6000,Math.max(128,options.maxTokens||1600)),
          ...(options.json===false?{}:{responseMimeType:'application/json'})
        }
      }),
      signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) {
      if ([429,402,403].includes(response.status)) cooldownUntil=Date.now()+900000;
      throw new Error('free_ai_http_'+response.status);
    }
    const payload=await response.json();
    const text=(payload.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
    if (!text) throw new Error('free_ai_empty');
    return text;
  } finally {active--;}
}
function parseJSON(raw) {
  const source=String(raw||'').trim();
  try {return JSON.parse(source)} catch {
    const match=source.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('free_ai_invalid_json');
    return JSON.parse(match[0]);
  }
}
async function generateJSON(messages,options={}) {return parseJSON(await generate(messages,options));}
module.exports={enabled,generate,generateJSON};
