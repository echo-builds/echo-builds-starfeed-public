# RepoScroll · GitHub 推荐流

**像刷小红书一样逛 GitHub，发现有趣的 AI 开源项目。**

**正式产品入口（网页与手机）：[立即体验 RepoScroll](https://echo-builds-starfeed.vercel.app/)**

本仓库用于保存源代码、产品说明和部署配置；用户无需前往其他地址体验不同功能。

## 为什么做这个？

我是一名 AI 产品经理，平时喜欢在 GitHub 上看看最近有什么新的 AI 产品、技术和有意思的开源项目。

但 GitHub 对我来说，一直不太好逛。

**一方面，我想随手刷刷，看看最近大家又做出了什么新东西。**

可打开 Trending 或 Explore，看到的往往是各种技术仓库、英文介绍、框架名称和代码信息。

我更关心的是：**这个项目解决了什么问题？怎么解决的？有什么值得关注的新技术？**

**另一方面，有时候我带着具体问题来，却不知道该搜什么。**

比如，我想找一个能把英文播客变成自然中文配音的项目。我知道自己想解决什么问题，却不知道应该搜索哪些技术关键词。通常只能先把需求告诉 ChatGPT，再让它帮我去 GitHub 找。

于是，我做了 RepoScroll。

我不想重新做一个 GitHub，而是希望能用更符合自己习惯的方式，**像刷内容一样发现有趣的项目，像描述问题一样寻找现成的解决方案。**

## RepoScroll 怎么用？

### 01 · 像刷小红书一样发现项目

打开就是双列信息流，推荐近期值得关注的高星 AI 项目。

既包括新出现、快速受到关注的项目，也包括最近有重要进展的成熟项目。

优先展示真实产品截图，用易懂的中文介绍它解决什么问题、提供了什么能力。

不需要逐个点开仓库，也能轻松了解最近大家在做什么。

### 02 · 用自然语言搜索解决方案

不用猜技术关键词，直接描述你遇到的问题。

> 有没有工具能把英文播客翻译成中文配音，听起来更自然一些？

RepoScroll 会理解需求，生成不同的检索方向，从 GitHub 寻找相关项目，再依据 README 逐项核对核心能力。结果会同时说明适合原因、已核验能力、缺失环节和未经试听或实测的主观体验，不用 Star 数替代需求匹配。

### 03 · 看懂之后，直接去用

感兴趣就点开卡片。

先了解项目的基本信息，再阅读从 README 中提取并翻译的产品介绍、功能和使用说明，查看真实截图。

如果想进一步了解或使用，可以：

- **查看 GitHub**：进入原始仓库，查看代码、Issue、Release 等。
- **开始使用**：有在线体验、产品主页或下载版本时，直接前往。
- **收藏**：登录 GitHub，同步 Stars，方便以后找回来。

---

**GitHub 以代码仓库为中心，而我更想以产品和问题为中心去逛 GitHub。**

我希望先看到一个项目解决了什么问题，再决定要不要了解它的技术实现。

RepoScroll 想做的，就是让发现开源项目像刷内容一样轻松，让寻找解决方案像描述问题一样自然。

## 使用与部署

RepoScroll 只有一个正式体验入口：[https://echo-builds-starfeed.vercel.app/](https://echo-builds-starfeed.vercel.app/)。手机和电脑访问的是同一个完整产品，手机浏览器也支持添加到主屏幕。

本地只预览静态页面，可以在仓库目录运行：

```sh
python3 -m http.server 4173
```

随后打开 http://localhost:4173 。GitHub 登录、Stars 同步、推荐与搜索接口依赖 Vercel Functions，静态预览不能完整运行这些能力。

Vercel 部署需要配置 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`SESSION_SECRET` 和 `DATABASE_URL`。首次启用持久推荐流时运行 `npm run db:migrate`，再运行 `npm run feed:backfill` 预处理首批 200 个候选项目。\n\n推荐库每 6 小时由公开仓库的 `scan-feed.yml` 扫描一次。配置 GitHub Actions Secret `DATABASE_URL` 和 `FEED_GITHUB_TOKEN`，并将 Actions Variable `FEED_SCANNER_ENABLED` 设为 `true` 后才会开始写入；未配置时线上会继续使用原有推荐接口，不会中断浏览。

### 免费运行与可选 AI 配置

- **默认零模型请求**：推荐流优先使用已核对的中文内容；新仓库仍可进入推荐，但可能显示原始简介。GitHub 登录、Stars、推荐流不要求模型 API Key。
- **另一个免费模型选项（Gemini）**：可以自行申请 Google AI Studio 的 Gemini API Key，并在 Vercel 配置 `GEMINI_API_KEY` 与 `ENABLE_FREE_GEMINI=true`。模型默认为 `gemini-2.5-flash-lite`，可通过 `GEMINI_FREE_MODEL` 修改。
- **推荐：Cloudflare Workers AI 免费自然语言搜索**：在 Cloudflare 创建 **Workers Free** 账户，获取 Account ID 和有 Workers AI 使用权限的 API Token。在 Vercel 环境变量中设置 `FREE_AI_PROVIDER=cloudflare-qwen`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`。`cloudflare-qwen` 是为兼容既有部署保留的配置名；当前默认使用免费模型白名单内的 `@cf/google/gemma-4-26b-a4b-it`，也可通过 `CLOUDFLARE_FREE_MODEL` 选择白名单内模型。模型思考模式关闭，以降低搜索延迟。Workers Free 每日免费配额用完后会限流或停止服务；**不要升级到 Workers Paid，也不要配置付费自动回退**。
- **免费额度用尽或智能理解失败**：不会切换到 Vercel AI Gateway 或其他付费模型，也不会展示未经 README 证据核验的通用关键词结果；页面会明确提示智能搜索暂不可用。免费 Gemini 是否可用、限额和收费状态以 Google AI Studio 中该项目的实际设置为准；为确保不产生费用，请使用未启用付费结算的免费层项目。
- **新项目中文介绍定期补充**：仓库的 [Refresh verified Chinese project cards](https://github.com/echo-builds/echo-builds-starfeed-public/actions/workflows/refresh-featured-copy.yml) 工作流每天执行一次。默认没有密钥时仅跳过，不会调用模型或生成内容。需要时可在 GitHub Actions Secrets 中设置 `ENABLE_FREE_GEMINI=true` 和 `GEMINI_API_KEY`，每次最多尝试 4 个项目；成功且证据校验通过后提交至 `data/featured-copy.json`。设置于 Vercel 的环境变量不会自动同步至 GitHub Actions。
- **可选的首页 AI 分类**：只有额外配置 `ENABLE_LIVE_DISCOVERY_AI=true` 才会调用模型，不建议免费部署开启；默认关闭。
- **可选 GitHub 读取凭证**：`GITHUB_API_TOKEN` 可提高 GitHub API 读取额度，不是必须项。

本地只启动静态服务器时无法运行后端接口；完整使用需要部署 Vercel Functions。Cloudflare Workers AI 免费方案和 Gemini 免费方案任选其一；当 `FREE_AI_PROVIDER=cloudflare-qwen` 或 `cloudflare-free` 时使用 Cloudflare 免费模型白名单，默认没有付费模型降级。
