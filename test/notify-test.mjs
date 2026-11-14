#!/usr/bin/env node
/**
 * Behavioural checks for notify.mjs: dedupe window, disabled mode, and
 * tolerance of a failing or unreachable webhook.
 *
 * Run: npm run test:notify
 */

import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSlackNotifier } from '../notify.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

const received = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }
  received.push({ path: req.url, payload });
  if (req.url === '/fail') {
    res.writeHead(500);
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const okUrl = `http://127.0.0.1:${port}/hook`;
  const failUrl = `http://127.0.0.1:${port}/fail`;

  console.log('== dedupe and cooldown ==');
  const notifier = createSlackNotifier({ webhookUrl: okUrl, cooldownMs: 300, log: () => {} });
  check('first alert is sent', (await notifier.alert('refused:1:budget', 'refill refused on Ethereum')) === 'sent');
  check('duplicate inside the cooldown is suppressed', (await notifier.alert('refused:1:budget', 'again')) === 'suppressed');
  check('a different key still sends', (await notifier.alert('low:1', 'treasury low')) === 'sent');
  check('only two requests reached the webhook', received.length === 2, String(received.length));
  check(
    'payload is a {"text": ...} body',
    received[0].payload.text === 'refill refused on Ethereum',
    JSON.stringify(received[0].payload),
  );

  await sleep(350);
  check('same key sends again after the cooldown', (await notifier.alert('refused:1:budget', 'later')) === 'sent');
  check('webhook saw the third request', received.length === 3, String(received.length));

  console.log('\n== failure handling ==');
  const failing = createSlackNotifier({ webhookUrl: failUrl, cooldownMs: 0, log: () => {} });
  check('HTTP 500 is reported as failed without throwing', (await failing.alert('k', 'boom')) === 'failed');
  const unreachable = createSlackNotifier({ webhookUrl: 'http://127.0.0.1:1/hook', cooldownMs: 0, log: () => {} });
  check('an unreachable webhook is reported as failed without throwing', (await unreachable.alert('k', 'boom')) === 'failed');

  console.log('\n== disabled mode ==');
  const disabled = createSlackNotifier({ webhookUrl: undefined, cooldownMs: 0, log: () => {} });
  check('notifier reports itself disabled', disabled.enabled === false);
  check(
    'disabled notifier performs no request',
    (await disabled.alert('k', 'x')) === 'disabled' && received.length === 4,
    String(received.length),
  );

  console.log('\n== channel routing ==');
  const routed = createSlackNotifier({
    webhookUrl: `http://127.0.0.1:${port}/default`,
    alertWebhookUrl: `http://127.0.0.1:${port}/alert`,
    warningWebhookUrl: `http://127.0.0.1:${port}/warning`,
    cooldownMs: 0,
    log: () => {},
  });
  const beforeRouting = received.length;
  await routed.alert('refused:1:budget', 'budget refusal');
  await routed.alert('low:1', 'low treasury');
  await routed.alert('sent:1:0xabc', 'sent');
  const routedRequests = received.slice(beforeRouting);
  const pathsIn = (list) => list.map((request) => request.path).join(',');
  check(
    'refusal goes to the alert channel',
    routedRequests.filter((request) => request.path === '/alert').length === 1,
    pathsIn(routedRequests),
  );
  check(
    'low treasury goes to the warning channel',
    routedRequests.filter((request) => request.path === '/warning').length === 1,
    pathsIn(routedRequests),
  );
  check(
    'success goes to the default channel',
    routedRequests.filter((request) => request.path === '/default').length === 1,
    pathsIn(routedRequests),
  );
  check('no alert is cross-posted', routedRequests.length === 3, pathsIn(routedRequests));

  const beforeStale = received.length;
  await routed.alert('stale:refill-audit.jsonl', 'no refill activity');
  check(
    "the dead-man's switch uses the alert channel",
    received.length - beforeStale === 1 && received[received.length - 1].path === '/alert',
    pathsIn(received.slice(beforeStale)),
  );
  check(
    'describe names all three channels',
    /refusals -> alert channel/.test(routed.describe()) &&
      /low treasury -> warning channel/.test(routed.describe()) &&
      /sends\/summary -> default channel/.test(routed.describe()),
    routed.describe(),
  );

  console.log('\n== routing fallback ==');
  const fallback = createSlackNotifier({ webhookUrl: `http://127.0.0.1:${port}/default`, cooldownMs: 0, log: () => {} });
  const beforeFallback = received.length;
  await fallback.alert('refused:1:cap', 'cap refusal');
  await fallback.alert('low:1', 'low');
  check(
    'dedicated routes fall back to the single webhook',
    received.slice(beforeFallback).every((request) => request.path === '/default') && received.length - beforeFallback === 2,
    pathsIn(received.slice(beforeFallback)),
  );

  console.log('\n== per-channel disable ==');
  const alertOnly = createSlackNotifier({ alertWebhookUrl: `http://127.0.0.1:${port}/alert`, cooldownMs: 0, log: () => {} });
  check('notifier is enabled with only an alert channel', alertOnly.enabled === true);
  check('refusal still sends', (await alertOnly.alert('refused:1:budget', 'x')) === 'sent');
  check('low treasury is disabled with no channel for it', (await alertOnly.alert('low:1', 'x')) === 'disabled');
  check('describe shows the warning route off', /low treasury -> off/.test(alertOnly.describe()), alertOnly.describe());

  if (failures > 0) {
    console.error(`\nNOTIFY TESTS FAILED: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nNOTIFY TESTS PASSED');
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
