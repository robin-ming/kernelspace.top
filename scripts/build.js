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
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    data[key] = value;
  }
  return { data, body: match[2].trim() };
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
  return fs
    .readdirSync(postsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const source = fs.readFileSync(path.join(postsDir, name), "utf8");
      const { data, body } = parseFrontMatter(source);
      const rendered = markdownToHtml(body, { collectHeadings: true });
      const slug = name.replace(/\.md$/, "");
      return {
        slug,
        url: `/posts/${slug}/`,
        title: data.title || slug,
        date: data.date || "",
        summary: data.summary || "",
        category: data.category || "Notes",
        categorySlug: categorySlug(data.category || "Notes"),
        tags: Array.isArray(data.tags) ? data.tags : [],
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
        inlineMath: [["\\\\(", "\\\\)"]],
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

const topicPlan = [
  {
    name: "Kernel Debugging",
    summary: "panic、crash、ftrace、lockdep 和现场证据。",
  },
  {
    name: "Device Tree",
    summary: "dts、binding、clock、regulator 和设备描述。",
  },
  {
    name: "Driver Development",
    summary: "probe、irq、dma、clock 和资源依赖。",
  },
  {
    name: "Kdump / Crash",
    summary: "vmcore、crash、dump 流程和分析方法。",
  },
  {
    name: "Boot Flow",
    summary: "从 bootloader 到 init 的启动路径。",
  },
  {
    name: "Patch Notes",
    summary: "补丁复盘、根因闭环和提交说明。",
  },
];

function renderTopicCard(plan, category) {
  if (!category) {
    return `<div class="taxonomy-card topic-card topic-card-muted">
      <span>待整理</span>
      <strong>${escapeHtml(plan.name)}</strong>
      <small>${escapeHtml(plan.summary)}</small>
      <div class="topic-latest">
        <span>状态</span>
        <em>文章还在补充中</em>
      </div>
    </div>`;
  }

  const latest = category.posts[0];
  return `<a class="taxonomy-card topic-card" href="/categories/${category.slug}/">
    <span>${category.posts.length} 篇文章</span>
    <strong>${escapeHtml(plan.name)}</strong>
    <small>${escapeHtml(plan.summary)}</small>
    <div class="topic-latest">
      <span>最新文章</span>
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
    .slice(0, 5)
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
        <p class="eyebrow">Linux kernel engineering notes</p>
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
      <div><strong>Driver Bring-up</strong><span>probe, irq, dma, clocks</span></div>
      <div><strong>Patch Notes</strong><span>root cause, tradeoffs, review</span></div>
    </section>
    <section class="section-head">
      <h2>最近文章</h2>
      <a href="/posts/">查看全部</a>
    </section>
    <section class="post-grid">${recent}</section>`
  });
}

function renderPostsIndex(posts) {
  const items = posts.map(postRow).join("");
  return layout({
    title: "文章",
    active: "/posts/",
    body: `<section class="page-title"><h1>文章</h1><p>调试记录、补丁复盘和底层系统笔记。</p><div class="page-actions"><a class="button light" href="/categories/">分类</a><a class="button light" href="/archive/">归档</a></div></section><section class="post-list">${items}</section>`
  });
}

function renderTopicsPage(categories) {
  const page = readPage("topics.md");
  const categoryByName = new Map(categories.map((category) => [category.name, category]));
  const cards = topicPlan
    .map((topic) => renderTopicCard(topic, categoryByName.get(topic.name)))
    .join("");

  return layout({
    title: page.title,
    active: "/topics/",
    body: `<section class="page-title">
      <h1>${escapeHtml(page.title)}</h1>
      <p>${escapeHtml(page.description || "")}</p>
    </section>
    <section class="article topic-intro">
      <div class="article-body">${page.html}</div>
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

function renderCategoryPage(category) {
  return layout({
    title: category.name,
    active: "/archive/",
    canonical: `/categories/${category.slug}/`,
    body: `<section class="page-title"><h1>${escapeHtml(category.name)}</h1><p>${category.posts.length} 篇文章</p><p><a href="/categories/">查看全部分类</a></p></section><section class="post-list">${category.posts.map(postRow).join("")}</section>`
  });
}

function renderArchive(posts) {
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
    title: "归档",
    active: "/archive/",
    body: `<section class="page-title"><h1>归档</h1><p>按时间回看文章和调试记录。</p><div class="page-actions"><a class="button light" href="/categories/">分类</a><a class="button light" href="/posts/">全部文章</a></div></section><section class="archive">${months}</section>`
  });
}

function renderFeed(posts) {
  const items = posts
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
  const routes = [
    "/",
    "/posts/",
    "/topics/",
    "/archive/",
    "/categories/",
    "/about/",
    ...categories.map((category) => `/categories/${category.slug}/`),
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
  writePage("posts", renderPostsIndex(posts));
  writePage("topics", renderTopicsPage(categories));
  writePage("archive", renderArchive(posts));
  writePage("categories", renderCategoriesIndex(categories));
  for (const category of categories) writePage(path.join("categories", category.slug), renderCategoryPage(category));
  writePage("about", renderSimplePage("about.md", "about", "/about/"));
  for (const post of posts) writePage(path.join("posts", post.slug), renderPost(post));
  writePage("404", layout({
    title: "404",
    body: `<section class="page-title"><h1>404</h1><p>这个页面不存在，可能文章路径已经调整。</p><p><a class="button primary" href="/">回到首页</a></p></section>`
  }));
  fs.writeFileSync(path.join(distDir, "feed.xml"), renderFeed(posts));
  fs.writeFileSync(path.join(distDir, "sitemap.xml"), renderSitemap(posts, categories));
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
