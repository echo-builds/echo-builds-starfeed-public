# RepoScroll · GitHub 推荐流

**从产品经理视角逛 GitHub：先看懂项目解决什么问题，再决定要不要深入了解。**

**正式产品入口（网页与手机）：[立即体验 RepoScroll](https://echo-builds-starfeed.vercel.app/)**

## 为什么做这个？

我是一名 AI 产品经理，平时会去 GitHub 看看最近出现了哪些新产品、新工具和技术变化。

但 GitHub 首先是为开发者设计的。打开 Trending 或 Explore，满屏都是仓库名称、英文介绍、框架术语和代码信息。想知道一个项目到底在做什么，往往要逐个点开 README，再从安装说明和技术细节中寻找答案。

而我最先想知道的是：

- **它在解决什么问题？**
- **它用了什么方法？**
- **现在做到了什么程度？**
- **为什么值得我继续看？**

于是，我做了 RepoScroll。

它不替代 GitHub，也不重新包装代码。它先从大量仓库中找出值得产品经理关注的项目，再用中文说明项目解决的问题、采用的方法和当前进展。用户看懂之后，再决定要不要进入原仓库了解技术实现。

## RepoScroll 怎么用？

### 01 · 打开就能逛

首页是双列项目流，不需要先想关键词，也不需要输入问题。

推荐既包括最近出现并快速受到关注的新项目，也包括刚刚发生重要变化的成熟项目。卡片上的 `GitHub Trending`、`近期爆发` 和 `重要更新` 标签，会直接说明它为什么此刻值得看。

推荐过的项目不会因为刷新而消失。新项目出现在当前位置上方，继续往下滑则会看到更早收录的项目；再次回来时，也可以从上次读到的位置继续。

### 02 · 先看懂，再深入

卡片优先展示真实产品截图，并用一句中文说明项目在解决什么问题。

点进详情后，可以继续阅读从 README 中保留并翻译的产品介绍、核心能力、截图和表格。这些内容保持原来的顺序；安装、部署、API、贡献和许可证等开发说明不会塞进详情页，需要时再进入 GitHub 查看。

### 03 · 留下真正有用的项目

看完之后可以：

- **查看 GitHub**：进入原始仓库，查看代码、Issue 和 Release。
- **开始使用**：项目提供在线体验、产品主页或下载版本时，直接前往。
- **收藏**：登录 GitHub 后与 Stars 同步，在不同设备上继续查看。

---

**GitHub 适合深入研究一个仓库，RepoScroll 先帮你决定哪个仓库值得打开。**

## 使用与部署

RepoScroll 只有一个正式体验入口：[https://echo-builds-starfeed.vercel.app/](https://echo-builds-starfeed.vercel.app/)。手机和电脑访问的是同一个产品，手机浏览器也支持添加到主屏幕。

本地只预览静态页面，可以在仓库目录运行：

~~~sh
python3 -m http.server 4173
~~~

随后打开 http://localhost:4173 。GitHub 登录、Stars 同步、推荐流和项目详情依赖 Vercel Functions 与数据库，静态预览不能完整运行这些能力。

完整部署需要在 Vercel 配置：

- `DATABASE_URL`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`

推荐库每 6 小时扫描一次。新项目的中文介绍可以通过 GitHub Actions 定期补充；需要时在 GitHub Actions Secrets 中设置 `ENABLE_FREE_GEMINI=true` 和 `GEMINI_API_KEY`。没有配置时任务会跳过，不会产生模型费用。

`GITHUB_API_TOKEN` 可以提高 GitHub API 的读取额度，但不是必须项。
