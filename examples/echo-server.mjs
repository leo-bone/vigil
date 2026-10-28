// 本地回显服务器：用于演示「推送通道」与「真实执行适配器」确实把事件/动作发了出来。
// 仅演示用，接收任意 POST/GET 并原样打印 body。
import { createServer } from 'node:http';

const PORT = Number(process.env.ECHO_PORT ?? 8765);
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] ${req.method} ${req.url}`);
    if (body) {
      try {
        console.log('  body:', JSON.stringify(JSON.parse(body), null, 2).slice(0, 800));
      } catch {
        console.log('  body:', body.slice(0, 800));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: `echo-${Date.now()}`, receivedAt: ts }));
  });
});
server.listen(PORT, () => console.log(`echo server listening on http://127.0.0.1:${PORT}`));
