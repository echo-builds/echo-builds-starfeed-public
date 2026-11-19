# RepoScroll 推荐时间线

RepoScroll 的首页不是一次性、刷新即丢失的推荐结果，而是一条只增不乱序的推荐时间线。

## 内容范围

项目不必使用 AI，但必须能帮助 AI 产品经理理解至少一类决策：

- AI 能力与边界；
- AI 产品与交互形态；
- 产品构建工具；
- 数据、运营、成本、安全与基础设施；
- 值得借鉴的非 AI 产品创新。

候选项目先经过垃圾仓库、批量克隆、教程和资源合集过滤，再根据 README、Release 和仓库元数据核验产品价值。没有直接证据的候选不会发布。

## 时间线与用户进度

- `projects` 保存已经准备好的标题、简介、证据、封面和使用入口。
- `feed_events` 保存项目首次收录或重要 Release，每个事件拥有稳定递增 ID。
- `user_progress` 保存登录用户最新看过的事件和上次阅读位置。
- 匿名用户在浏览器本地保存同样的进度，登录后与云端合并。

每个用户的“X 个新项目”都通过全局最新事件与自己的最新已读事件计算，不使用统一的日批次。

## 扫描与发布

`.github/workflows/scan-feed.yml` 每 6 小时运行一次：

1. 从多个产品决策赛道召回候选；
2. 保存 Star、Fork 和活跃度快照；
3. 读取 README、Release 并选择产品截图；
4. 使用直接证据判断是否值得 AI 产品经理关注；
5. 完成中文标题、简介和封面后，写入永久时间线。

普通 Bug、依赖升级、文档修改和小版本 Patch 不会让旧项目重新出现。重要 Release 原则上还受 30 天冷却期限制。

## 部署配置

数据库使用 Neon Postgres。运行前需要：

1. 在 Vercel 和 GitHub Actions Secrets 配置 `DATABASE_URL`；
2. 在公开仓库设置 Actions Variable `FEED_SCANNER_ENABLED=true`；
3. 为扫描任务配置 `FEED_GITHUB_TOKEN`；
4. 选择免费的 Gemini 或 Cloudflare Workers AI 配置，用于严格的语义判断和中文文案；
5. 首次手动运行工作流并传入 `backfill=200`。

未配置数据库时，前端会自动回退到原有 `/api/discover` 推荐接口。
