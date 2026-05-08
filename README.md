# Kernel Space

`kernelspace.top` 是一个面向 Linux 内核工程笔记的静态博客。站点源码托管在 GitHub，构建产物部署到 Cloudflare Pages。

设计目标：

- 写作使用 Markdown，不依赖后台和数据库。
- 构建只依赖 Node.js 标准库，不引入第三方 npm 包。
- 文章页适合长技术文，自动生成 Contents 目录。
- 支持分类、归档、RSS、sitemap 和 Giscus 评论。
- 部署链路简单，push 到 `main` 后由 Cloudflare Pages 自动构建。

## 技术栈

- Runtime: Node.js 20+
- Generator: `scripts/build.js`
- Preview server: `scripts/serve.js`
- Stylesheet: `src/styles/site.css`
- Content: Markdown with front matter
- Hosting: Cloudflare Pages
- Comments: Giscus + GitHub Discussions

没有使用 Hugo、Hexo、Astro、Next.js 等框架。站点功能边界很清楚，使用自定义静态生成器更容易维护和迁移。

## 目录结构

```text
.
├── content/
│   ├── home.md
│   ├── about.md
│   ├── topics.md
│   └── posts/
│       └── *.md
├── public/
│   ├── _headers
│   ├── _redirects
│   ├── robots.txt
│   └── assets/
│       └── kernelspace-hero.png
├── scripts/
│   ├── build.js
│   └── serve.js
├── src/styles/
│   └── site.css
├── site.config.json
├── package.json
└── dist/
```

`dist/` 是构建产物目录，由 `npm run build` 生成，不提交到 Git。

## 构建流程

构建命令：

```bash
npm run build
```

构建器会执行这些工作：

- 清空并重建 `dist/`
- 复制 `public/` 到 `dist/`
- 复制 CSS 到 `dist/assets/site.css`
- 读取 `content/*.md` 和 `content/posts/*.md`
- 解析 front matter
- 将 Markdown 转成 HTML
- 生成首页、文章列表页、文章详情页
- 生成分类页和归档页
- 生成 `feed.xml`
- 生成 `sitemap.xml`
- 生成 `404/index.html`

本地预览：

```bash
npm run build
npm run serve
```

打开：

```text
http://localhost:8788
```

## 文章格式

文章放在 `content/posts/`，文件名会成为 URL slug。

示例：

```markdown
---
title: 驱动 probe 失败排查：从错误码看资源依赖
date: 2026-05-06
summary: probe 失败不是一个点，而是一条资源依赖链。
category: Driver Development
tags: [driver, probe, kernel]
---

正文内容。
```

生成 URL：

```text
/posts/driver-probe-failure/
```

字段说明：

- `title`: 文章标题
- `date`: 发布日期，格式为 `YYYY-MM-DD`
- `summary`: 文章摘要，用于文章列表、RSS 和页面 description
- `category`: 文章主分类
- `tags`: 文章标签数组

如果不写 `category`，默认归到 `Notes`。

## 分类和归档

分类是半自动的：写文章时手动指定 `category`，构建时自动生成分类页面。

当前建议分类：

```text
Kernel Debugging
Driver Development
Device Tree
Kdump / Crash
Patch Notes
Boot Flow
Notes
```

生成页面：

```text
/categories/
/categories/kernel-debugging/
/categories/driver-development/
/archive/
```

`/archive/` 按月份归档文章。分类页和归档页都会自动加入 sitemap。

## Contents 目录

文章页会自动从 Markdown 标题生成右侧 `Contents` 目录。

实现方式：

- `scripts/build.js` 在 Markdown 渲染阶段收集标题
- 标题自动生成稳定 `id`
- 文章页右侧输出 `<aside class="article-toc">`
- 桌面端 sticky 显示
- 移动端显示为正文前的目录块

写文章时只需要正常使用标题：

```markdown
## 问题背景

## 分析过程

### 第一次假设
```

不需要手写目录。

## 评论系统

评论使用 Giscus，数据存储在 GitHub Discussions。

当前配置在 `site.config.json`：

```json
"comments": {
  "provider": "giscus",
  "enabled": true,
  "giscus": {
    "repo": "robin-ming/kernelspace.top",
    "repoId": "R_kgDOSXaXvw",
    "category": "Comments",
    "categoryId": "DIC_kwDOSXaXv84C8jyy",
    "mapping": "pathname",
    "theme": "preferred_color_scheme",
    "lang": "zh-CN"
  }
}
```

评论映射方式是 `pathname`。例如：

```text
/posts/kernel-panic-first-hour/
```

会对应 GitHub Discussions 中的一条 discussion。首次有人评论时，Giscus 会自动创建对应 discussion。

如果需要临时关闭评论：

```json
"enabled": false
```

## Cloudflare Pages

Cloudflare Pages 构建配置：

```text
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
Node.js version: 20 或更新
```

仓库已经包含 `.node-version`：

```text
20
```

自定义域名：

```text
kernelspace.top
www.kernelspace.top
```

DNS 已托管在 Cloudflare 时，可以直接在 Pages 项目里绑定自定义域名。

## Cloudflare 文件

`public/_headers` 会被复制到 `dist/_headers`，用于设置基础安全响应头：

```text
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

`public/_redirects` 会被复制到 `dist/_redirects`，用于 Cloudflare Pages redirects。

`public/robots.txt` 指向：

```text
https://kernelspace.top/sitemap.xml
```

## 日常发布流程

新增文章：

```bash
$EDITOR content/posts/new-article.md
npm run build
git add -- content/posts/new-article.md
git commit -m "Add new article"
git push origin main
```

Cloudflare Pages 会在 push 后自动部署。

修改站点样式：

```bash
$EDITOR src/styles/site.css
npm run build
git add -- src/styles/site.css
git commit -m "Update site styles"
git push origin main
```

修改站点配置：

```bash
$EDITOR site.config.json
npm run build
git add -- site.config.json
git commit -m "Update site config"
git push origin main
```

## 已实现功能

- 首页沉浸式 hero
- Markdown 文章
- 文章列表
- 文章详情页
- 自动 Contents 目录
- 分类页
- 归档页
- 专题页
- 关于页
- RSS feed
- sitemap
- 404 页面
- Giscus 评论
- Cloudflare Pages 部署

## 注意事项

- `dist/` 是生成产物，不要手工编辑。
- 分类建议保持少而稳定，标签可以更细。
- Giscus 依赖 GitHub Discussions 和 Giscus App 授权。
- 如果修改 front matter 格式，注意同步 `scripts/build.js` 的解析逻辑。
- 当前 Markdown 解析器是轻量实现，只覆盖本站需要的标题、段落、列表、代码块、行内代码、加粗和链接。
