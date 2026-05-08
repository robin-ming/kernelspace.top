# Kernel Space

`kernelspace.top` 的静态博客源码。文章使用 Markdown 编写，构建产物输出到 `dist/`，适合部署到 Cloudflare Pages。

## 本地使用

```bash
npm run build
npm run serve
```

打开 `http://localhost:8788` 预览。

## 写文章

在 `content/posts/` 新建 Markdown 文件：

```markdown
---
title: 文章标题
date: 2026-05-08
summary: 一句话摘要
tags: [kernel, debug]
---

正文内容。
```

## Cloudflare Pages

- Framework preset: `None`
- Build command: `npm run build`
- Build output directory: `dist`
- Node.js version: `20` 或更新

自定义域名使用 `kernelspace.top`，DNS 在 Cloudflare 时可以直接在 Pages 项目里绑定。

## 评论

站点已接入 Giscus 组件，但默认关闭。启用步骤：

1. 在 GitHub 仓库 Settings 中开启 Discussions。
2. 新建一个 Discussion category，建议命名为 `Comments`。
3. 安装 Giscus App 到 `robin-ming/kernelspace.top`。
4. 打开 https://giscus.app/ 生成配置，补全 `site.config.json` 中的 `comments.giscus.categoryId`。
5. 将 `comments.enabled` 改为 `true`。

当前已配置：

```json
"repo": "robin-ming/kernelspace.top",
"repoId": "R_kgDOSXaXvw",
"mapping": "pathname"
```
