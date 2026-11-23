const crypto = require('node:crypto');
const CONTENT_PIPELINE_VERSION = 5;

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

function selectProductMarkdown(markdown,maxChars=24000) {
  const operational = /(install(?:ation|ing)?|setup|quick\s*start|getting\s*started|get\s*started|using(?:\s+the)?|prerequisites?|requirements?|connect(?:ing)?\s+(?:a\s+)?(?:phone|device)|device\s+(?:connection|pairing)|run(?:ning)?\s+(?:locally|the\s+app)|usage|command(?:s|\s+line)?|deploy|development|build from source|building from source|contribut|license|api reference|configuration|troubleshoot|faq|benchmark detail|changelog|release notes|acknowledg|credits?|sponsors?|donat|开始使用|快速开始|入门指南|使用(?:方法|说明|指南|\s+[^\n]{0,40})|使用前准备|准备工作|需要准备什么|环境要求|系统要求|连接(?:手机|设备)|设备连接|设备配对|运行方式|命令行|选择.{0,12}服务|服务配置|下载安装|安装|部署|升级|卸载|开发|源码构建|参与开发|贡献|许可证|配置|常见问题|故障排查|更新记录|致谢|感谢支持|赞助)/i;
  const cleaned = String(markdown || '')
    .replace(/```[\s\S]*?```/g,'')
    .replace(/<p\b[^>]*align=["']center["'][^>]*>[\s\S]*?<\/p>/gi,block=>{
      const linkCount=(block.match(/<a\b/gi) || []).length;
      const visible=block.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      return linkCount>=2 && /(下载|开始使用|常见问题|discord|english|简体中文|日本語|türkçe|documentation|docs)/i.test(visible) ? '' : block;
    })
    .replace(/(?:\n\s*){3,}/g,'\n\n');
  const all = sections(cleaned);
  // Keep the author's product narrative in order, but drop operational
  // sections and all nested subsections beneath them. A detail page should
  // help someone understand the product before sending setup work to GitHub.
  const chosen=[];
  let excludedLevel=null;
  for (const section of all) {
    const level=Number(section.level || 0);
    if (excludedLevel!==null) {
      if (level>excludedLevel) continue;
      excludedLevel=null;
    }
    if (section.heading && operational.test(section.heading)) {
      excludedLevel=level || 1;
      continue;
    }
    chosen.push(section);
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

function resolveReadmeUrls(markdown,repo) {
  const branch=repo.default_branch || 'main';
  const rawBase=`https://raw.githubusercontent.com/${repo.full_name}/${branch}/`;
  const repoBase=`https://github.com/${repo.full_name}`;
  const imageUrl=value=>/^https?:\/\//i.test(value)?value:rawBase+value.replace(/^\.\//,'').replace(/^\//,'');
  const linkUrl=value=>{
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('#')) return repoBase+value;
    if (value.startsWith('/')) return 'https://github.com'+value;
    return `${repoBase}/blob/${branch}/`+value.replace(/^\.\//,'');
  };
  return String(markdown || '')
    .replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g,(all,start,url,end)=>start+imageUrl(url)+end)
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,(all,start,url,end)=>start+imageUrl(url)+end)
    .replace(/(\[[^\]]+\]\()([^)\s]+)(\))/g,(all,start,url,end)=>start+linkUrl(url)+end)
    .replace(/(<a\b[^>]*\bhref=["'])([^"']+)(["'])/gi,(all,start,url,end)=>start+linkUrl(url)+end);
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
      {role:'system',content:'你是忠实的 GitHub README 中文翻译器。只翻译读者能看到的自然语言，不总结、不扩写、不评价。项目名、产品名和专有名词保持原文。严格原样保留 Markdown 标题层级、列表、图片、链接、命令和代码，以及所有 HTML 标签、属性、URL、锚点、对齐方式和嵌套结构；不要把 HTML 改写成纯文本。Markdown 表格必须保持原列数、竖线和分隔行，每个表格行只占一行，表格行之间不要插入空行。不要添加开场或结尾。'},
      {role:'user',content:`这是第 ${index+1}/${chunks.length} 段：\n\n${chunks[index]}`}
    ],{json:false,temperature:0,maxTokens:1600,timeoutMs:25000});
    if (!result || !/[㐀-鿿]/.test(result)) throw new Error('translation_missing_chinese');
    translated.push(result.trim());
  }
  return translated.join('\n\n').trim();
}

async function prepareProjectContent({readme,repo,release,freeAI}) {
  const fingerprint=sourceFingerprint(readme);
  const selected=resolveReadmeUrls(selectProductMarkdown(readme),repo);
  const base={
    content_pipeline_version:CONTENT_PIPELINE_VERSION,
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
  CONTENT_PIPELINE_VERSION,
  isMostlyChinese,sections,selectProductMarkdown,resolveReadmeUrls,resolveImages:resolveReadmeUrls,sourceFingerprint,markdownChunks,
  productExperience,translateMarkdown,prepareProjectContent
};
