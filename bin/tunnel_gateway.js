/**
 * bin/tunnel_gateway.js
 * Unified Local Gateway for Ngrok Tunneling
 * Forwards HTTP traffic to Apache (port 80) and WebSocket /ws to Ratchet (port 8080)
 */

const http = require('http');
const net = require('net');

const HTTP_TARGET_PORT = 80;
const WS_TARGET_PORT = 8080;
const GATEWAY_PORT = 3000;

const server = http.createServer((req, res) => {
    // Forward standard HTTP/API/PHP requests to Apache
    const options = {
        hostname: '127.0.0.1',
        port: HTTP_TARGET_PORT,
        path: req.url,
        method: req.method,
        headers: {
            ...req.headers,
            host: `127.0.0.1:${HTTP_TARGET_PORT}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http',
            'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''
        }
    };

    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('[Gateway HTTP Error]:', err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Gateway Error: Apache server is not reachable on port 80.');
        }
    });

    req.pipe(proxyReq);
});

// Handle WebSocket upgrade
server.on('upgrade', (req, clientSocket, head) => {
    const url = req.url || '';
    
    // Connect to Ratchet WebSocket daemon on port 8080
    const targetSocket = net.connect(WS_TARGET_PORT, '127.0.0.1', () => {
        // Rewrite the request line to pass full query parameters to Ratchet
        // Notice: Ratchet expects GET /?room_id=... HTTP/1.1
        const targetPath = url.startsWith('/ws') ? (url.slice(3) || '/') : url;
        const normalizedPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;

        let rawReq = `${req.method} ${normalizedPath} HTTP/1.1\r\n`;
        for (const [key, val] of Object.entries(req.headers)) {
            if (key.toLowerCase() === 'host') {
                rawReq += `Host: 127.0.0.1:${WS_TARGET_PORT}\r\n`;
            } else {
                rawReq += `${key}: ${val}\r\n`;
            }
        }
        rawReq += '\r\n';

        targetSocket.write(rawReq);
        if (head && head.length > 0) {
            targetSocket.write(head);
        }

        // Pipe bidirectionally
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', (err) => {
        console.error('[Gateway WS Error]:', err.message);
        clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
        targetSocket.destroy();
    });
});

server.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`   JAMRI UNIFIED TUNNEL GATEWAY`);
    console.log(`   Listening on: http://0.0.0.0:${GATEWAY_PORT}`);
    console.log(`   Routing HTTP -> Apache (127.0.0.1:${HTTP_TARGET_PORT})`);
    console.log(`   Routing /ws  -> WebSocket (127.0.0.1:${WS_TARGET_PORT})`);
    console.log(`====================================================`);
});
