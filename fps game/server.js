const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = path.resolve(__dirname);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method Not Allowed');
        return;
    }

    let urlPath;
    try {
        urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(ROOT, relative);

    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.stat(filePath, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
            res.writeHead(statErr && statErr.code === 'ENOENT' ? 404 : 403);
            res.end(statErr && statErr.code === 'ENOENT' ? 'Not Found' : 'Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(err.code === 'ENOENT' ? 404 : 500);
                res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
                return;
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
                'Content-Length': data.length
            });
            res.end(req.method === 'HEAD' ? undefined : data);
        });
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
