import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 5173);
const ROOT = new URL('.', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function resolvePath(urlPath) {
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = normalize(join(ROOT, requested));
  if (!fullPath.startsWith(ROOT)) return null;
  return fullPath;
}

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const filePath = resolvePath(url.pathname);

  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}).listen(PORT, () => {
  console.log(`Browser wallet mint monitor: http://localhost:${PORT}`);
});
