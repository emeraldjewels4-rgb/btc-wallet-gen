/**
 * Minimal Slack incoming-webhook stand-in for the rehearsal harnesses.
 * Records every JSON payload and answers 200 so alerting can be asserted.
 */
import { createServer } from 'node:http';

export async function startFakeSlack() {
  const messages = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      messages.push(JSON.parse(raw));
    } catch {
      messages.push({ raw });
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/services/TEST/FAKE`,
    messages,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
