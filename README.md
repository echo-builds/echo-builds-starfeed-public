# RepoScroll · GitHub 推荐流

**像刷小红书一样逛 GitHub，先看懂项目解决什么问题，再决定要不要打开仓库。**

[**立即体验 RepoScroll**](https://echo-builds-starfeed.vercel.app/)

## GitHub 上项目很多，但并不好逛

我是一名 AI 产品经理，平时会去 GitHub 看看最近出现了哪些新产品、新工具和技术变化。

但 GitHub 首先是为开发者设计的。

打开 Trending 或 Explore，首先看到的是仓库名称、英文简介、编程语言和 Star 数。想知道一个项目到底能做什么，通常还要逐个打开 README，从安装说明、代码示例和技术术语中寻找答案。

而我逛 GitHub 时，最先想知道的是：

- 它解决了什么具体问题？
- 用户可以拿它做什么？
- 它为什么最近值得关注？

于是，我做了 RepoScroll。

**GitHub 以代码仓库为中心，而我更想以产品和问题为中心去逛 GitHub。**

## RepoScroll 怎么用？

RepoScroll 从 GitHub 中找出近期正在增长、持续更新，并且值得 AI 产品经理关注的项目。

首页采用双列信息流，优先展示真实产品截图，用一句易懂的中文说明项目解决什么问题。

**再次打开 RepoScroll 时，页面会从上次读到的位置继续；如果有新项目，它们会排在上方，之前的内容也会保留。**

遇到感兴趣的项目，点开卡片即可看懂它具体做什么；项目提供体验入口时，也可以直接使用或下载。

## RepoScroll 推荐什么？

RepoScroll 不是简单按照历史 Star 数排序。

它优先推荐：

- 最近新增 Star 较多、正在受到关注的项目；
- 近期发布了重要版本、值得重新了解的成熟项目；
- 提供真实产品、工具或新交互方式的项目；
- 能给 AI 产品经理带来产品启发或实际帮助的项目。

推荐流每 6 小时检查一次新项目和重要变化。

## 直接使用

RepoScroll 的正式入口是：

[**https://echo-builds-starfeed.vercel.app/**](https://echo-builds-starfeed.vercel.app/)

手机和电脑访问的是同一个产品。使用手机浏览器时，也可以把 RepoScroll 添加到主屏幕，像普通应用一样打开。

## 自己部署

RepoScroll 已开源。你可以 Fork 本仓库，连接自己的数据库与 GitHub OAuth App，部署一套属于自己的推荐流。

完整步骤见 [部署说明](./docs/DEPLOYMENT.md)。

## License

[MIT License](./LICENSE)
