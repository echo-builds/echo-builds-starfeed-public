const crypto = require('node:crypto');

function isMostlyChinese(text) {
  const sample = String(text || '')
    .replace(/<[^>]+>/g,' ')
    .replace(/https?:\/\/\S+/gi,' ')
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/[`#>*_\-\[\]()!\d\s]/g,'')
    .slice(0,3000);
  if (!sample) return false;
  const chinese = (sample.match(/[㐀-鿿]/g) || []).length;
  return chinese / sample.length > .32;
}

function sections(markdown) {
  const lines = String(markdown || '').replace(/\r/g,'').split('\n');
  const result = [];
  let current = {heading:'',body:[]};
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      if (current.body.some(value=>value.trim())) result.push(current);
      current = {heading:match[2].trim(),level:match[1].length,body:[line]};
    } else current.body.push(line);
  }
  if (current.body.some(value=>value.trim())) result.push(current);
  return result;
}

function selectProductMarkdown(markdown,maxChars=3600) {
  const include = /(about|overview|introduction|what is|why|feature|capabilit|how it works|workflow|use cases?|usage|demo|screenshots?|preview|product|介绍|关于|概览|功能|能力|工作原理|使用场景|怎么用|演示|截图)/i;
  const exclude = /(install|setup|deploy|development|build from source|contribut|license|api reference|configuration|troubleshoot|benchmark detail|安装|部署|开发|贡献|许可证|配置|故障排查)/i;
  const cleaned = String(markdown || '').replace(/```[\s\S]*?```/g,'').replace(/(?:\n\s*){3,}/g,'\n\n');
  const all = sections(cleaned);
  const chosen = [];
  for (let index=0;index<all.length;index++) {
    const section=all[index];
    if (!section.heading && index===0) chosen.push(section);
    else if (include.test(section.heading) && !exclude.test(section.heading)) chosen.push(section);
  }
  if (chosen.length<2) {
    for (const section of all) {
      if (chosen.includes(section) || exclude.test(section.heading)) continue;
      chosen.push(section);
      if (chosen.length>=4) break;
    }
  }
  const lines=chosen.map(section=>section.body.join('\n').trim()).filter(Boolean).join('\n\n').split('\n');
  const kept=[];
  let total=0;
  for (const line of lines) {
    if (total+line.length>maxChars) break;
    kept.push(line);
    total+=line.length+1;
  }
  return kept.join('\n').replace(/<[^>]*$/,'').replace(/(?:\n\s*){3,}/g,'\n\n').trim();
}

function resolveImages(markdown,repo) {
  const branch=repo.default_branch || 'main';
  const base=`https://raw.githubusercontent.com/${repo.full_name}/${branch}/`;
  return String(markdown || '')
    .replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g,(all,start,url,end)=>start+(/^https?:\/\//i.test(url)?url:base+url.replace(/^\.\//,''))+end)
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,(all,start,url,end)=>start+(/^https?:\/\//i.test(url)?url:base+url.replace(/^\.\//,''))+end);
}

function sourceFingerprint(markdown) {
  return crypto.createHash('sha256').update(String(markdown || '')).digest('hex');
}

function markdownChunks(markdown,maxChars=1700) {
  const result=[];
  let current=[];
  let length=0;
  const flush=()=>{
    const value=current.join('\n').trim();
    if (value) result.push(value);
    current=[];
    length=0;
  };
  for (const rawLine of String(markdown || '').split('\n')) {
    const line=rawLine.trimEnd();
    if (line.length>maxChars) {
      flush();
      for (let index=0;index<line.length;index+=maxChars) result.push(line.slice(index,index+maxChars));
      continue;
    }
    if (length+line.length+1>maxChars) flush();
    current.push(line);
    length+=line.length+1;
  }
  flush();
  return result;
}

function publicUrl(value) {
  try {
    const url=new URL(String(value || '').trim());
    return ['https:','http:'].includes(url.protocol)?url.href:null;
  } catch { return null; }
}

function productExperience(repo,release) {
  const homepage=publicUrl(repo.homepage);
  const releaseUrl=publicUrl(release?.html_url);
  const hasAssets=Array.isArray(release?.assets)&&release.assets.some(asset=>publicUrl(asset?.browser_download_url));
  const homepageUrl=homepage?new URL(homepage):null;
  const isGitHub=homepageUrl&&/(^|\.)github\.com$/i.test(homepageUrl.hostname);
  const looksLikeDocs=homepage&&/(^docs\.|readthedocs|\/docs(?:\/|$))/i.test(homepage);
  const looksLikeLiveApp=homepageUrl&&(/^(app|demo|try|play)\./i.test(homepageUrl.hostname)||/(vercel\.app|netlify\.app|github\.io|hf\.space)$/i.test(homepageUrl.hostname)||/huggingface\.co\/spaces\//i.test(homepageUrl.hostname+homepageUrl.pathname));
  if (homepage&&!isGitHub&&looksLikeLiveApp) return {url:homepage,mode:'online'};
  if (releaseUrl&&hasAssets) return {url:releaseUrl,mode:'download'};
  if (homepage&&!isGitHub&&!looksLikeDocs) return {url:homepage,mode:'online'};
  return null;
}

async function translateMarkdown(markdown,freeAI) {
  const chunks=markdownChunks(markdown);
  const translated=[];
  for (let index=0;index<chunks.length;index++) {
    const result=await freeAI.generate([
      {role:'system',content:'你是忠实的 GitHub README 中文翻译器。只翻译正文，不总结、不扩写、不评价。保留 Markdown 标题层级、列表、图片、链接、命令、专有名词和代码。不要添加开场或结尾。'},
      {role:'user',content:`这是第 ${index+1}/${chunks.length} 段：\n\n${chunks[index]}`}
    ],{json:false,temperature:0,maxTokens:1600,timeoutMs:25000});
    if (!result || !/[㐀-鿿]/.test(result)) throw new Error('translation_missing_chinese');
    translated.push(result.trim());
  }
  return translated.join('\n\n').trim();
}

async function prepareProjectContent({readme,repo,release,freeAI}) {
  const fingerprint=sourceFingerprint(readme);
  const selected=resolveImages(selectProductMarkdown(readme),repo);
  const base={
    readme_source_sha:fingerprint,
    content_prepared_at:new Date().toISOString(),
    experience:productExperience(repo,release)
  };
  if (!selected) return {...base,content_ready:false,translation_status:'pending',readme_markdown:''};
  if (isMostlyChinese(selected)) return {...base,content_ready:true,translation_status:'original_chinese',readme_markdown:selected};
  if (!freeAI?.enabled?.()) return {...base,content_ready:false,translation_status:'pending',readme_markdown:''};
  try {
    const translated=await translateMarkdown(selected,freeAI);
    return {...base,content_ready:true,translation_status:'translated',readme_markdown:translated};
  } catch(error) {
    return {...base,content_ready:false,translation_status:'pending',readme_markdown:'',content_error:String(error?.message || error).slice(0,80)};
  }
}

module.exports={
  isMostlyChinese,sections,selectProductMarkdown,resolveImages,sourceFingerprint,markdownChunks,
  productExperience,translateMarkdown,prepareProjectContent
};
