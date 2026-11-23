# 部署 RepoScroll

RepoScroll 由静态前端、Vercel Functions、PostgreSQL、GitHub OAuth 和定时推荐任务组成。仅启动静态页面无法完整运行登录、Stars 同步、推荐流和项目详情。

## 准备工作

你需要：

- Node.js 20 或更高版本；
- 一个 Vercel 账号；
- 一个 PostgreSQL 数据库（例如 Neon）；
- 一个 GitHub OAuth App。

## 1. Fork 并导入 Vercel

1. Fork 本仓库到自己的 GitHub 账号或组织。
2. 在 Vercel 中选择 **Add New Project**，导入 Fork 后的仓库。
3. 暂时不要部署，先完成下面的数据库和登录配置。

## 2. 创建数据库

创建 PostgreSQL 数据库并取得连接字符串，稍后将它保存为 `DATABASE_URL`。

在本地克隆 Fork 后的仓库并初始化数据库：

~~~sh
npm install
DATABASE_URL='你的 PostgreSQL 连接字符串' npm run db:migrate
~~~

该命令会执行 [`db/schema.sql`](../db/schema.sql)。

## 3. 配置 GitHub 登录

在 GitHub 的 **Settings → Developer settings → OAuth Apps** 中创建 OAuth App：

- **Homepage URL**：你的正式访问地址，例如 `https://your-project.vercel.app`
- **Authorization callback URL**：`https://your-project.vercel.app/api/auth/callback`

保存后取得 `Client ID`，并生成 `Client secret`。

RepoScroll 会根据当前域名生成回调地址，因此如果以后更换正式域名，也要同步修改 OAuth App 的 Homepage URL 和 callback URL。

## 4. 配置 Vercel 环境变量

在 Vercel 项目的 **Settings → Environment Variables** 中添加：

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串 |
| `GITHUB_CLIENT_ID` | 是 | GitHub OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | 是 | GitHub OAuth App 的 Client secret |
| `SESSION_SECRET` | 是 | 至少 32 个字符，用于加密登录状态 |

可以用下面的命令生成 `SESSION_SECRET`：

~~~sh
openssl rand -hex 32
~~~

保存环境变量后部署项目。部署完成后，先确认首页可以打开，再验证 GitHub 登录和收藏同步。

## 5. 开启推荐流更新

仓库中的 [`.github/workflows/scan-feed.yml`](../.github/workflows/scan-feed.yml) 每 6 小时检查一次新项目和重要变化。

在 Fork 后仓库的 **Settings → Secrets and variables → Actions** 中配置：

### 必需

- Repository variable：`FEED_SCANNER_ENABLED=true`
- Repository secret：`DATABASE_URL`

工作流会使用 GitHub Actions 自带的 `GITHUB_TOKEN` 读取公开仓库，不需要额外创建 Personal Access Token。

### 可选：生成项目中文介绍

如果不配置 AI 服务，相关步骤会自动跳过。需要时可选择以下任一免费提供方。

Gemini：

- Repository variable：`FREE_AI_PROVIDER=gemini`
- Repository variable：`ENABLE_FREE_GEMINI=true`
- Repository secret：`GEMINI_API_KEY`

Cloudflare Workers AI：

- Repository variable：`FREE_AI_PROVIDER=cloudflare-free`
- Repository secret：`CLOUDFLARE_ACCOUNT_ID`
- Repository secret：`CLOUDFLARE_API_TOKEN`

配置完成后，可以在 **Actions → Scan RepoScroll feed → Run workflow** 手动运行一次，确认数据库迁移、推荐扫描和质量检查全部通过。

## 本地静态预览

如果只想查看页面布局，可以在仓库目录运行：

~~~sh
python3 -m http.server 4173
~~~

随后打开 [http://localhost:4173](http://localhost:4173)。

这个方式只提供静态预览；完整能力仍需要 Vercel Functions、数据库和 GitHub OAuth。
