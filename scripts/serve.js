import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const port = Number(process.env.PORT || 8788);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    let filePath = path.join(distDir, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath)) filePath = path.join(distDir, "404.html");
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, () => {
    console.log(`Serving http://localhost:${port}`);
  });
