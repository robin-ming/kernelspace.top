import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "content");
const postsDir = path.join(contentDir, "posts");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");
const config = JSON.parse(fs.readFileSync(path.join(root, "site.config.json"), "utf8"));

const isWatch = process.argv.includes("--watch");
const POSTS_PER_PAGE = 20;
const CATEGORY_POSTS_PER_PAGE = 20;
const FEED_LIMIT = 50;
const SEARCH_CONTENT_LIMIT = 1200;
const SEARCH_RESULT_LIMIT = 50;

function clean() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function parseFrontMatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: source };
  const data = {};
  const cleanValue = (item) => {
    const trimmed = item.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map(cleanValue)
        .filter(Boolean);
    } else {
      value = cleanValue(value);
    }
    data[key] = value;
  }
  return { data, body: match[2].trim() };
}

function warn(message) {
  console.warn(`Warning: ${message}`);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .trim()
    .replace(/[`~!@#$%^&*()+=[\]{};:'",.<>/?\\|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

function categorySlug(value) {
  return slugify(value).replaceAll("/", "-");
}

function stripInlineMarkdown(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function plainTextFromMarkdown(text) {
  return stripInlineMarkdown(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, " ")
    .replace(/^[-*+]\s+/gm, " ")
    .replace(/^\d+\.\s+/gm, " ")
    .replace(/[>|*_~#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptText(text, limit = 180) {
  const plain = plainTextFromMarkdown(text);
  return plain.length > limit ? `${plain.slice(0, limit).trim()}...` : plain;
}

function normalizePostData(data, body, slug, filename) {
  const title = data.title || stripInlineMarkdown((body.match(/^#\s+(.+)$/m) || [])[1] || slug);
  const date = data.date || "";
  const summary = data.summary || excerptText(body, 120) || title;
  const category = data.category || "Notes";
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const problems = [];

  if (!data.title) problems.push("missing title");
  if (!data.date) problems.push("missing date");
  if (data.date && !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) problems.push(`invalid date: ${data.date}`);
  if (!data.summary) problems.push("missing summary");
  if (!data.category) problems.push("missing category");
  if (!Array.isArray(data.tags)) problems.push("missing or invalid tags");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)) problems.push("slug should use URL-safe characters");
  if (problems.length) warn(`${filename}: ${problems.join(", ")}; using safe fallback values`);

  return { title, date, summary, category, tags };
}

function uniqueSlug(value, seen) {
  const base = slugify(value);
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function inlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return html;
}

function renderCodeBlock(language, code) {
  const source = escapeHtml(code.join("\n"));
  if (language === "mermaid") {
    return `<pre class="mermaid">${source}</pre>`;
  }
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${className}>${source}</code></pre>`;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableStart(lines, index) {
  return Boolean(lines[index]?.includes("|") && isTableSeparator(lines[index + 1] || ""));
}

function renderTable(rows) {
  const [head, ...body] = rows;
  const thead = `<thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function markdownToHtml(markdown, options = {}) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const headings = [];
  const headingIds = new Map();
  let paragraph = [];
  let list = [];
  let listType = null;
  let fence = null;
  let code = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(`<${tag}>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    list = [];
    listType = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (fence) {
        blocks.push(renderCodeBlock(fence, code));
        fence = null;
        code = [];
      } else {
        flushParagraph();
        flushList();
        fence = line.slice(3).trim().split(/\s+/)[0] || "text";
      }
      continue;
    }
    if (fence) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
      continue;
    }
    if (isTableStart(lines, i)) {
      flushParagraph();
      flushList();
      const rows = [splitTableRow(lines[i])];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      blocks.push(renderTable(rows));
      continue;
    }
    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 1;
      const id = uniqueSlug(heading[2], headingIds);
      const text = inlineMarkdown(heading[2]);
      headings.push({
        id,
        level,
        text: stripInlineMarkdown(heading[2])
      });
      blocks.push(`<h${level} id="${id}">${text}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      list.push(bullet[1]);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      list.push(ordered[1]);
      continue;
    }
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  const html = blocks.join("\n");
  return options.collectHeadings ? { html, headings } : html;
}

function readPage(file) {
  const source = fs.readFileSync(path.join(contentDir, file), "utf8");
  const { data, body } = parseFrontMatter(source);
  return { ...data, body, html: markdownToHtml(body) };
}

function readPosts() {
  if (!fs.existsSync(postsDir)) return [];
  const seenSlugs = new Set();
  return fs
    .readdirSync(postsDir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .map((name) => {
      const source = fs.readFileSync(path.join(postsDir, name), "utf8");
      const { data, body } = parseFrontMatter(source);
      const rendered = markdownToHtml(body, { collectHeadings: true });
      const slug = name.replace(/\.md$/, "");
      if (seenSlugs.has(slug)) throw new Error(`Duplicate post slug: ${slug}`);
      seenSlugs.add(slug);
      const normalized = normalizePostData(data, body, slug, name);
      return {
        slug,
        url: `/posts/${slug}/`,
        title: normalized.title,
        date: normalized.date,
        summary: normalized.summary,
        category: normalized.category,
        categorySlug: categorySlug(normalized.category),
        tags: normalized.tags,
        body,
        html: rendered.html,
        headings: rendered.headings
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function layout({ title, description, body, active = "", canonical = active, bodyClass = "page" }) {
  const pageTitle = title === config.title ? config.title : `${title} - ${config.title}`;
  const nav = config.nav
    .map((item) => `<a class="${active === item.href ? "active" : ""}" href="${item.href}">${item.label}</a>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description || config.description)}">
  <link rel="canonical" href="https://${config.domain}${canonical || "/"}">
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.title)}" href="/feed.xml">
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body class="${escapeHtml(bodyClass)}">
  <header class="site-header">
    <a class="brand" href="/">
      <span class="brand-mark">ks</span>
      <span class="brand-copy">
        <span class="brand-title">${escapeHtml(config.title)}</span>
        <span class="brand-subtitle">kernelspace.top</span>
      </span>
    </a>
    <nav aria-label="主导航">${nav}</nav>
  </header>
  <main>${body}</main>
  <footer class="site-footer">
    <span>© ${new Date().getFullYear()} ${escapeHtml(config.author)}</span>
    <a href="/feed.xml">RSS</a>
    <a href="https://${config.domain}">${config.domain}</a>
  </footer>
  <script>
    window.MathJax = {
      tex: {
        inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]],
        displayMath: [["$$", "$$"], ["\\\\[", "\\\\]"]]
      },
      svg: { fontCache: "global" }
    };
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict" });
  </script>
</body>
</html>`;
}

function writePage(route, html) {
  const targetDir = path.join(distDir, route);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "index.html"), html);
}

function pageRoute(base, page) {
  return page === 1 ? base : path.posix.join(base, "page", String(page), "/");
}

function paginate(items, perPage) {
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push({
      page: pages.length + 1,
      totalPages: Math.ceil(items.length / perPage),
      items: items.slice(i, i + perPage)
    });
  }
  return pages.length ? pages : [{ page: 1, totalPages: 1, items: [] }];
}

function renderPagination(base, page, totalPages) {
  if (totalPages <= 1) return "";
  const links = [];
  if (page > 1) links.push(`<a href="${pageRoute(base, page - 1)}">上一页</a>`);
  links.push(`<span>${page} / ${totalPages}</span>`);
  if (page < totalPages) links.push(`<a href="${pageRoute(base, page + 1)}">下一页</a>`);
  return `<nav class="pagination" aria-label="分页">${links.join("")}</nav>`;
}

function tagList(tags) {
  return tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
}

function groupByCategory(posts) {
  const groups = new Map();
  for (const post of posts) {
    if (!groups.has(post.category)) {
      groups.set(post.category, {
        name: post.category,
        slug: post.categorySlug,
        posts: []
      });
    }
    groups.get(post.category).posts.push(post);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function groupByArchiveMonth(posts) {
  const groups = new Map();
  for (const post of posts) {
    const key = post.date.slice(0, 7) || "undated";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function groupByArchiveYear(posts) {
  const groups = new Map();
  for (const post of posts) {
    const key = post.date.slice(0, 4) || "undated";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function sortCategoriesForTopics(categories) {
  return [...categories].sort((a, b) => {
    const aDate = a.posts[0]?.date || "";
    const bDate = b.posts[0]?.date || "";
    const dateOrder = bDate.localeCompare(aDate);
    if (dateOrder) return dateOrder;
    return a.name.localeCompare(b.name);
  });
}

function renderTopicCard(category) {
  const latest = category.posts[0];
  return `<a class="taxonomy-card topic-card" href="/categories/${category.slug}/">
    <span>${category.posts.length} 篇文章</span>
    <strong>${escapeHtml(category.name)}</strong>
    <small>${escapeHtml(latest?.summary || "暂无摘要")}</small>
    <div class="topic-latest">
      <span>最新更新</span>
      <em>${escapeHtml(latest?.title || "未命名")}</em>
    </div>
  </a>`;
}

function postRow(post) {
  return `<article class="post-row">
    <time>${escapeHtml(post.date)}</time>
    <div>
      <div class="post-meta">
        <a href="/categories/${post.categorySlug}/">${escapeHtml(post.category)}</a>
      </div>
      <h2><a href="${post.url}">${escapeHtml(post.title)}</a></h2>
      <p>${escapeHtml(post.summary)}</p>
      <div class="tags">${tagList(post.tags)}</div>
    </div>
  </article>`;
}

function renderToc(headings = []) {
  if (!headings.length) return "";
  const items = headings
    .map(
      (heading) => `<li class="toc-level-${heading.level}">
        <a href="#${heading.id}">${escapeHtml(heading.text)}</a>
      </li>`
    )
    .join("");
  return `<aside class="article-toc" aria-label="文章目录">
    <h2>Contents</h2>
    <ol>${items}</ol>
  </aside>`;
}

function renderComments() {
  const comments = config.comments;
  if (!comments || comments.provider !== "giscus" || !comments.enabled) return "";
  const giscus = comments.giscus || {};
  const required = ["repo", "repoId", "category", "categoryId"];
  const missing = required.filter((key) => !giscus[key]);

  if (missing.length) {
    return `<section class="comments-section comments-placeholder">
      <h2>评论</h2>
      <p>Giscus 评论区配置还缺少：${missing.map(escapeHtml).join(", ")}。</p>
    </section>`;
  }

  return `<section class="comments-section">
    <h2>评论</h2>
    <script src="https://giscus.app/client.js"
      data-repo="${escapeHtml(giscus.repo)}"
      data-repo-id="${escapeHtml(giscus.repoId)}"
      data-category="${escapeHtml(giscus.category)}"
      data-category-id="${escapeHtml(giscus.categoryId)}"
      data-mapping="${escapeHtml(giscus.mapping || "pathname")}"
      data-strict="${escapeHtml(giscus.strict || "0")}"
      data-reactions-enabled="${escapeHtml(giscus.reactionsEnabled || "1")}"
      data-emit-metadata="${escapeHtml(giscus.emitMetadata || "0")}"
      data-input-position="${escapeHtml(giscus.inputPosition || "bottom")}"
      data-theme="${escapeHtml(giscus.theme || "preferred_color_scheme")}"
      data-lang="${escapeHtml(giscus.lang || "zh-CN")}"
      data-loading="lazy"
      crossorigin="anonymous"
      async>
    </script>
  </section>`;
}

function renderHome(posts) {
  const home = readPage("home.md");
  const recent = posts
    .slice(0, 6)
    .map(
      (post) => `<article class="post-card">
        <div class="post-meta">${escapeHtml(post.date)} · <a href="/categories/${post.categorySlug}/">${escapeHtml(post.category)}</a></div>
        <h3><a href="${post.url}">${escapeHtml(post.title)}</a></h3>
        <p>${escapeHtml(post.summary)}</p>
      </article>`
    )
    .join("");
  return layout({
    title: config.title,
    active: "/",
    bodyClass: "home",
    body: `<section class="hero hero-immersive">
      <img class="hero-image" src="/assets/kernelspace-hero.png" alt="" aria-hidden="true">
      <div class="hero-copy">
        <p class="eyebrow">Systems, math, and reflection notes</p>
        <h1>${escapeHtml(home.title)}</h1>
        <p class="subtitle">${escapeHtml(home.subtitle)}</p>
        <div class="intro">${home.html}</div>
        <div class="hero-actions">
          <a class="button primary" href="/posts/">阅读文章</a>
          <a class="button" href="/about/">关于本站</a>
        </div>
      </div>
      <aside class="terminal-panel" aria-label="站点主题">
        <div class="terminal-bar"><span></span><span></span><span></span></div>
        <pre><code>panic: unable to handle kernel paging request
RIP: __handle_mm_fault+0x2a1/0x910

$ crash vmcore vmlinux
crash&gt; bt
crash&gt; kmem -i
crash&gt; dis -l schedule</code></pre>
      </aside>
    </section>
    <section class="signal-strip" aria-label="站点关注方向">
      <div><strong>Kernel Debugging</strong><span>crash, ftrace, perf, lockdep</span></div>
      <div><strong>Math Notes</strong><span>calculus, proof, structure, invariants</span></div>
      <div><strong>Life Notes</strong><span>reflection, boundaries, long-term thinking</span></div>
    </section>
    <section class="section-head">
      <h2>最近文章</h2>
      <a href="/posts/">查看全部</a>
    </section>
    <section class="post-grid">${recent}</section>`
  });
}

function renderPostsIndex(posts, page = 1, totalPages = 1) {
  const items = posts.map(postRow).join("");
  return layout({
    title: page === 1 ? "文章" : `文章 第 ${page} 页`,
    active: "/posts/",
    canonical: pageRoute("/posts/", page),
    body: `<section class="page-title"><h1>文章</h1><p>调试记录、补丁复盘和底层系统笔记。</p><div class="page-actions"><a class="button light" href="/categories/">分类</a><a class="button light" href="/archive/">归档</a></div></section><section class="post-list">${items}</section>${renderPagination("/posts/", page, totalPages)}`
  });
}

function renderTopicsPage(categories) {
  const page = readPage("topics.md");
  const cards = sortCategoriesForTopics(categories)
    .map((category) => renderTopicCard(category))
    .join("");

  return layout({
    title: page.title,
    active: "/topics/",
    body: `<section class="page-title">
      <h1>${escapeHtml(page.title)}</h1>
      <p>${escapeHtml(page.description || "")}</p>
    </section>
    <section class="topic-note">
      <p>${escapeHtml(page.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())}</p>
    </section>
    <section class="section-head">
      <h2>专题索引</h2>
      <a href="/categories/">查看全部分类</a>
    </section>
    <section class="taxonomy-grid topic-grid">${cards}</section>`
  });
}

function renderPost(post) {
  const toc = renderToc(post.headings);
  const comments = renderComments();
  return layout({
    title: post.title,
    description: post.summary,
    active: post.url,
    body: `<div class="article-shell">
      <article class="article">
        <header>
          <div class="post-meta">${escapeHtml(post.date)} ${tagList(post.tags)}</div>
          <h1>${escapeHtml(post.title)}</h1>
          <p>${escapeHtml(post.summary)}</p>
        </header>
        <div class="article-body">${post.html}</div>
      </article>
      ${toc}
      ${comments}
    </div>`
  });
}

function renderSimplePage(file, route, active) {
  const page = readPage(file);
  return layout({
    title: page.title,
    description: page.description,
    active,
    body: `<article class="article"><header><h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.description || "")}</p></header><div class="article-body">${page.html}</div></article>`
  });
}

function renderCategoriesIndex(categories) {
  const items = categories
    .map(
      (category) => `<a class="taxonomy-card" href="/categories/${category.slug}/">
        <span>${category.posts.length} 篇</span>
        <strong>${escapeHtml(category.name)}</strong>
        <small>${escapeHtml(category.posts[0]?.summary || "")}</small>
      </a>`
    )
    .join("");
  return layout({
    title: "分类",
    active: "/archive/",
    canonical: "/categories/",
    body: `<section class="page-title"><h1>分类</h1><p>按内核工程主题浏览文章。分类保持克制，只保留长期会写的方向。</p></section><section class="taxonomy-grid">${items}</section>`
  });
}

function renderCategoryPage(category, posts = category.posts, page = 1, totalPages = 1) {
  return layout({
    title: page === 1 ? category.name : `${category.name} 第 ${page} 页`,
    active: "/archive/",
    canonical: pageRoute(`/categories/${category.slug}/`, page),
    body: `<section class="page-title"><h1>${escapeHtml(category.name)}</h1><p>${category.posts.length} 篇文章</p><p><a href="/categories/">查看全部分类</a></p></section><section class="post-list">${posts.map(postRow).join("")}</section>${renderPagination(`/categories/${category.slug}/`, page, totalPages)}`
  });
}

function renderArchiveYear(year, posts) {
  const months = groupByArchiveMonth(posts)
    .map(
      ([month, monthPosts]) => `<section class="archive-month">
        <h2>${escapeHtml(month)}</h2>
        <div class="archive-list">${monthPosts
          .map(
            (post) => `<a href="${post.url}">
              <time>${escapeHtml(post.date)}</time>
              <span>${escapeHtml(post.title)}</span>
              <small>${escapeHtml(post.category)}</small>
            </a>`
          )
          .join("")}</div>
      </section>`
    )
    .join("");
  return layout({
    title: year ? `归档 ${year}` : "归档",
    active: "/archive/",
    canonical: year ? `/archive/${year}/` : "/archive/",
    body: `<section class="page-title"><h1>${year ? escapeHtml(year) : "归档"}</h1><p>按时间回看文章和调试记录。</p><div class="page-actions"><a class="button light" href="/categories/">分类</a><a class="button light" href="/posts/">全部文章</a>${year ? '<a class="button light" href="/archive/">全部年份</a>' : ""}</div></section><section class="archive">${months}</section>`
  });
}

function renderArchive(posts) {
  const years = groupByArchiveYear(posts)
    .map(
      ([year, yearPosts]) => `<a class="archive-year-card" href="/archive/${year}/">
        <strong>${escapeHtml(year)}</strong>
        <span>${yearPosts.length} 篇文章</span>
      </a>`
    )
    .join("");
  return layout({
    title: "归档",
    active: "/archive/",
    body: `<section class="page-title"><h1>归档</h1><p>按年份回看文章和调试记录。</p><div class="page-actions"><a class="button light" href="/categories/">分类</a><a class="button light" href="/posts/">全部文章</a></div></section><section class="archive-years">${years}</section>`
  });
}

function renderSearchPage() {
  return layout({
    title: "搜索",
    active: "/search/",
    canonical: "/search/",
    description: "搜索内核空间的全部文章。",
    body: `<section class="page-title search-title">
      <h1>搜索</h1>
      <p>输入关键词，匹配文章标题、摘要、分类、标签和正文。</p>
    </section>
    <section class="search-panel" aria-label="文章搜索">
      <label class="search-box">
        <span class="search-icon" aria-hidden="true"></span>
        <input id="site-search" type="search" autocomplete="off" placeholder="搜索 vmcore、crash、device tree..." aria-label="搜索文章">
      </label>
      <div class="search-hint" id="search-hint">支持多个关键词，空格分隔。</div>
      <div class="search-results" id="search-results"></div>
    </section>
    <script>
      const input = document.querySelector("#site-search");
      const results = document.querySelector("#search-results");
      const hint = document.querySelector("#search-hint");
      let index = [];
      let searchTimer = 0;

      const escapeHtml = (value = "") => String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

      const normalize = (value = "") => String(value).toLowerCase();

      const tokenize = (value = "") => normalize(value)
        .split(/\\s+/)
        .map((item) => item.trim())
        .filter(Boolean);

      function scorePost(post, terms) {
        const title = normalize(post.title);
        const summary = normalize(post.summary);
        const meta = normalize([post.category, ...(post.tags || [])].join(" "));
        const content = normalize(post.content);
        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 16;
          else if (summary.includes(term)) score += 8;
          else if (meta.includes(term)) score += 6;
          else if (content.includes(term)) score += 2;
          else return 0;
        }
        return score;
      }

      function render(query) {
        const terms = tokenize(query);
        if (!terms.length) {
          hint.textContent = "支持多个关键词，空格分隔。";
          results.innerHTML = "";
          return;
        }

        const matches = index
          .map((post) => ({ post, score: scorePost(post, terms) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || String(b.post.date).localeCompare(String(a.post.date)))
          .slice(0, ${SEARCH_RESULT_LIMIT});

        hint.textContent = matches.length ? \`找到 \${matches.length} 篇相关文章\` : "没有匹配的文章，换个关键词试试。";
        results.innerHTML = matches.map(({ post }) => \`
          <article class="search-result">
            <div class="post-meta">\${escapeHtml(post.date)} · \${escapeHtml(post.category)}</div>
            <h2><a href="\${post.url}">\${escapeHtml(post.title)}</a></h2>
            <p>\${escapeHtml(post.summary || post.excerpt || "")}</p>
            <div class="tags">\${(post.tags || []).map((tag) => \`<span>\${escapeHtml(tag)}</span>\`).join("")}</div>
          </article>
        \`).join("");
      }

      fetch("/search.json")
        .then((response) => response.json())
        .then((data) => {
          index = data;
          render(input.value);
        })
        .catch(() => {
          hint.textContent = "搜索索引加载失败。";
        });

      input.addEventListener("input", () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => render(input.value), 120);
      });
      input.focus({ preventScroll: true });
    </script>`
  });
}

function renderSearchIndex(posts) {
  return JSON.stringify(
    posts.map((post) => ({
      title: post.title,
      summary: post.summary,
      category: post.category,
      tags: post.tags,
      date: post.date,
      url: post.url,
      excerpt: excerptText(post.body, 180),
      content: excerptText(post.body, SEARCH_CONTENT_LIMIT)
    })),
    null,
    2
  );
}

function renderFeed(posts) {
  const items = posts
    .slice(0, FEED_LIMIT)
    .map(
      (post) => `<item>
  <title>${escapeHtml(post.title)}</title>
  <link>https://${config.domain}${post.url}</link>
  <guid>https://${config.domain}${post.url}</guid>
  <pubDate>${new Date(post.date).toUTCString()}</pubDate>
  <description>${escapeHtml(post.summary)}</description>
</item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeHtml(config.title)}</title>
  <link>https://${config.domain}</link>
  <description>${escapeHtml(config.description)}</description>
${items}
</channel>
</rss>`;
}

function renderSitemap(posts, categories = []) {
  const postPages = paginate(posts, POSTS_PER_PAGE).map((page) => pageRoute("/posts/", page.page));
  const categoryPages = categories.flatMap((category) =>
    paginate(category.posts, CATEGORY_POSTS_PER_PAGE).map((page) => pageRoute(`/categories/${category.slug}/`, page.page))
  );
  const archivePages = groupByArchiveYear(posts).map(([year]) => `/archive/${year}/`);
  const routes = [
    "/",
    "/search/",
    "/topics/",
    "/archive/",
    "/categories/",
    "/about/",
    ...postPages,
    ...categoryPages,
    ...archivePages,
    ...posts.map((post) => post.url)
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map((route) => `  <url><loc>https://${config.domain}${route}</loc></url>`).join("\n")}
</urlset>`;
}

function build() {
  clean();
  copyDir(publicDir, distDir);
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(root, "src/styles/site.css"), path.join(distDir, "assets/site.css"));
  const posts = readPosts();
  const categories = groupByCategory(posts);
  writePage("", renderHome(posts));
  for (const page of paginate(posts, POSTS_PER_PAGE)) {
    writePage(pageRoute("posts", page.page), renderPostsIndex(page.items, page.page, page.totalPages));
  }
  writePage("search", renderSearchPage());
  writePage("topics", renderTopicsPage(categories));
  writePage("archive", renderArchive(posts));
  for (const [year, yearPosts] of groupByArchiveYear(posts)) {
    writePage(path.join("archive", year), renderArchiveYear(year, yearPosts));
  }
  writePage("categories", renderCategoriesIndex(categories));
  for (const category of categories) {
    for (const page of paginate(category.posts, CATEGORY_POSTS_PER_PAGE)) {
      writePage(pageRoute(path.posix.join("categories", category.slug), page.page), renderCategoryPage(category, page.items, page.page, page.totalPages));
    }
  }
  writePage("about", renderSimplePage("about.md", "about", "/about/"));
  for (const post of posts) writePage(path.join("posts", post.slug), renderPost(post));
  writePage("404", layout({
    title: "404",
    body: `<section class="page-title"><h1>404</h1><p>这个页面不存在，可能文章路径已经调整。</p><p><a class="button primary" href="/">回到首页</a></p></section>`
  }));
  fs.writeFileSync(path.join(distDir, "feed.xml"), renderFeed(posts));
  fs.writeFileSync(path.join(distDir, "sitemap.xml"), renderSitemap(posts, categories));
  fs.writeFileSync(path.join(distDir, "search.json"), renderSearchIndex(posts));
  console.log(`Built ${posts.length} post(s) into dist/`);
}

build();

if (isWatch) {
  fs.watch(root, { recursive: true }, (_, filename) => {
    if (!filename || filename.startsWith("dist") || filename.startsWith("node_modules")) return;
    try {
      build();
    } catch (error) {
      console.error(error);
    }
  });
  console.log("Watching for changes...");
}
