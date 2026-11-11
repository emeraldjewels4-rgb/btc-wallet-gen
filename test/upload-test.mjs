#!/usr/bin/env node
/**
 * Checks upload.mjs against an in-process SFTP server: config comes from the
 * env file, dry run writes nothing, --live uploads exactly site/index.html, and
 * the safety refusals hold.
 *
 * Run: npm run test:upload
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(tmpdir(), 'upload-test-work');
const ENV_FILE = join(WORK, '.env.upload');
const PAGE = join(WORK, 'site', 'index.html');
const USER = 'web9999';
const PASSWORD = 'correct-horse-battery-staple';
const PAGE_HTML =
  '<!doctype html>\n<html lang="en"><head><title>Treasury status</title></head>' +
  '<body><h1>Treasury status</h1></body></html>\n';
const DIRS = new Set(['public_html']);

const remote = new Map();
const opened = [];
let writeOps = 0;

const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
  // A rejected login makes the client socket reset; that is expected here.
  client.on('error', () => {});

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'password') return ctx.reject(['password']);
    if (ctx.username === USER && ctx.password === PASSWORD) return ctx.accept();
    return ctx.reject();
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const sftpStream = accept();
        const handles = new Map();
        let nextHandle = 1;
        const now = Math.floor(Date.now() / 1000);

        const attrsFor = (path) => {
          if (remote.has(path)) {
            return { mode: 0o100644, uid: 0, gid: 0, size: remote.get(path).size, atime: now, mtime: now };
          }
          if (DIRS.has(path)) return { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: now, mtime: now };
          return null;
        };

        const replyAttrs = (reqid, path) => {
          const attrs = attrsFor(path);
          if (!attrs) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return sftpStream.attrs(reqid, attrs);
        };

        sftpStream.on('REALPATH', (reqid) => {
          sftpStream.name(reqid, [{ filename: '/', longname: '/', attrs: { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: now, mtime: now } }]);
        });

        sftpStream.on('STAT', (reqid, path) => replyAttrs(reqid, path));
        sftpStream.on('LSTAT', (reqid, path) => replyAttrs(reqid, path));

        sftpStream.on('FSTAT', (reqid, handle) => {
          const entry = handles.get(handle.readUInt32BE(0));
          if (!entry) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
          return sftpStream.attrs(reqid, {
            mode: 0o100644,
            uid: 0,
            gid: 0,
            size: entry.size,
            atime: now,
            mtime: now,
          });
        });

        sftpStream.on('OPEN', (reqid, filename, flags) => {
          if (!(flags & OPEN_MODE.WRITE)) return sftpStream.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          opened.push(filename);
          const id = nextHandle;
          nextHandle += 1;
          handles.set(id, { path: filename, data: Buffer.alloc(0), size: 0 });
          const handle = Buffer.alloc(4);
          handle.writeUInt32BE(id, 0);
          return sftpStream.handle(reqid, handle);
        });

        sftpStream.on('WRITE', (reqid, handle, offset, data) => {
          const entry = handles.get(handle.readUInt32BE(0));
          if (!entry) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
          writeOps += 1;
          const end = offset + data.length;
          if (entry.data.length < end) {
            const grown = Buffer.alloc(end);
            entry.data.copy(grown);
            entry.data = grown;
          }
          data.copy(entry.data, offset);
          entry.size = Math.max(entry.size, end);
          return sftpStream.status(reqid, STATUS_CODE.OK);
        });

        sftpStream.on('CLOSE', (reqid, handle) => {
          const id = handle.readUInt32BE(0);
          const entry = handles.get(id);
          if (!entry) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
          handles.delete(id);
          remote.set(entry.path, { data: entry.data, size: entry.size });
          return sftpStream.status(reqid, STATUS_CODE.OK);
        });

        sftpStream.on('OPENDIR', (reqid, path) => {
          if (!DIRS.has(path)) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const id = nextHandle;
          nextHandle += 1;
          handles.set(id, { path, dir: true });
          const handle = Buffer.alloc(4);
          handle.writeUInt32BE(id, 0);
          return sftpStream.handle(reqid, handle);
        });

        sftpStream.on('READDIR', (reqid, handle) => {
          const entry = handles.get(handle.readUInt32BE(0));
          if (!entry?.dir) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
          sftpStream.status(reqid, STATUS_CODE.EOF);
        });
      });
    });
  });
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// Stands in for the web server in front of the uploaded page.
let httpMode = 'ok';
let httpHits = 0;
const web = createServer((req, res) => {
  httpHits += 1;
  if (httpMode === 'notfound') {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('not found');
    return;
  }
  if (httpMode === 'wrongtype') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(PAGE_HTML);
    return;
  }
  if (httpMode === 'short') {
    res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
    res.end(PAGE_HTML.slice(0, 40));
    return;
  }
  if (httpMode === 'othertitle') {
    res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
    res.end(PAGE_HTML.replace('Treasury status', 'Something else'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
  res.end(PAGE_HTML);
});
const webPort = await new Promise((resolve) => web.listen(0, '127.0.0.1', () => resolve(web.address().port)));
const WEB_URL = `http://127.0.0.1:${webPort}/index.html`;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
}

function runUpload(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'upload.mjs'), ...args], {
      cwd: WORK,
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function writeEnv(overrides = {}) {
  const values = {
    SFTP_HOST: '127.0.0.1',
    SFTP_PORT: String(port),
    SFTP_USER: USER,
    SFTP_PASSWORD: PASSWORD,
    SFTP_REMOTE_DIR: 'public_html',
    ...overrides,
  };
  const text = Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(ENV_FILE, `${text}\n`);
}

function writePage(html) {
  mkdirSync(dirname(PAGE), { recursive: true });
  writeFileSync(PAGE, html);
}

const outputs = [];
function record(result) {
  outputs.push(result.out);
  return result;
}

try {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, 'site'), { recursive: true });

  console.log('config');

  const help = record(await runUpload(['--help']));
  check('--help exits 0', help.code === 0 && /Usage: node upload\.mjs/.test(help.out));

  const noEnv = record(await runUpload([]));
  check('fails without the env file', noEnv.code === 1, `exit ${noEnv.code}`);
  check('names the missing config file', /no upload config file/.test(noEnv.out));

  writeEnv({ SFTP_PASSWORD: null });
  const noPassword = record(await runUpload([]));
  check('fails without a password', noPassword.code === 1, `exit ${noPassword.code}`);
  check('names the missing key', /SFTP_PASSWORD/.test(noPassword.out));
  check('never prints the password', !noPassword.out.includes(PASSWORD));

  console.log('page checks');

  writeEnv();
  const noPage = record(await runUpload([]));
  check('fails without a generated page', noPage.code === 1, `exit ${noPage.code}`);
  check('points at status-page.mjs', /status-page\.mjs/.test(noPage.out));

  writePage(`<!doctype html><html><body><script>alert(1)</script></body></html>`);
  const scripted = record(await runUpload([]));
  check('refuses a page with a script block', scripted.code === 3, `exit ${scripted.code}`);

  writePage('not html at all');
  const notHtml = record(await runUpload([]));
  check('refuses a file that is not HTML', notHtml.code === 3, `exit ${notHtml.code}`);

  console.log('dry run');

  writePage(PAGE_HTML);
  const dry = record(await runUpload([]));
  check('dry run exits 0', dry.code === 0, dry.out.trim().split('\n').pop());
  check('says it is a dry run', /dry run/.test(dry.out));
  check('names the local file', dry.out.includes('site/index.html'));
  check('names the remote path', dry.out.includes('public_html/index.html'));
  check('says what it would do', /would upload/.test(dry.out));
  check('shows the local size', dry.out.includes(`${Buffer.byteLength(PAGE_HTML)} bytes`));
  check('writes nothing on a dry run', writeOps === 0 && !remote.has('public_html/index.html'));

  console.log('live upload');

  const live = record(await runUpload(['--live']));
  check('live exits 0', live.code === 0, live.out.trim().split('\n').pop());
  check('uploaded exactly one file', opened.length === 1, opened.join(', '));
  check('uploaded only site/index.html', opened[0] === 'public_html/index.html', opened[0]);
  check('says it uploaded', /uploaded public_html\/index\.html/.test(live.out));
  check('remote content matches', remote.get('public_html/index.html')?.data.toString('utf8') === PAGE_HTML);
  check('remote size matches', remote.get('public_html/index.html')?.size === Buffer.byteLength(PAGE_HTML));
  check('never prints the password', !live.out.includes(PASSWORD));

  const again = record(await runUpload([]));
  check('reports an overwrite', /would overwrite/.test(again.out));
  check('shows the existing size', new RegExp(`exists, ${Buffer.byteLength(PAGE_HTML)} bytes`).test(again.out));

  console.log('verification');

  httpMode = 'ok';
  const verified = record(await runUpload(['--live', '--verify', WEB_URL]));
  check('verifies a live upload', verified.code === 0, verified.out.trim().split('\n').pop());
  check('reports the served size', verified.out.includes(`${Buffer.byteLength(PAGE_HTML)} bytes, title`));
  check('reports the served title', /title "Treasury status"/.test(verified.out));

  httpMode = 'notfound';
  const missing404 = record(await runUpload(['--live', '--verify', WEB_URL]));
  check('fails on HTTP 404', missing404.code === 2, `exit ${missing404.code}`);
  check('names the status code', /HTTP 404/.test(missing404.out));

  httpMode = 'wrongtype';
  const wrongType = record(await runUpload(['--live', '--verify', WEB_URL]));
  check('fails on a non-HTML content type', wrongType.code === 2, `exit ${wrongType.code}`);
  check('names the content type', /content type text\/plain/.test(wrongType.out));

  httpMode = 'short';
  const truncated = record(await runUpload(['--live', '--verify', WEB_URL]));
  check('fails when the served size differs', truncated.code === 2, `exit ${truncated.code}`);
  check('reports the expected size', /bytes, expected \d+/.test(truncated.out));

  httpMode = 'othertitle';
  const wrongTitle = record(await runUpload(['--live', '--verify', WEB_URL]));
  check('fails when the title differs', wrongTitle.code === 2, `exit ${wrongTitle.code}`);
  check('reports the expected title', /expected "Treasury status"/.test(wrongTitle.out));

  httpMode = 'ok';
  const hitsBefore = httpHits;
  const dryVerify = record(await runUpload(['--verify', WEB_URL]));
  check(
    'skips verification on a dry run',
    dryVerify.code === 0 && /verification skipped on a dry run/.test(dryVerify.out),
    dryVerify.out.trim().split('\n').pop(),
  );
  check('makes no HTTP request on a dry run', httpHits === hitsBefore, `${httpHits - hitsBefore} request(s)`);

  writeEnv({ SFTP_PUBLIC_URL: WEB_URL });
  const fromEnv = record(await runUpload(['--live']));
  check(
    'verifies using SFTP_PUBLIC_URL',
    fromEnv.code === 0 && /verified http/.test(fromEnv.out),
    fromEnv.out.trim().split('\n').pop(),
  );

  writeEnv();
  const badScheme = record(await runUpload(['--verify', 'ftp://example.com/index.html']));
  check('rejects a non-http verify URL', badScheme.code === 1, `exit ${badScheme.code}`);

  console.log('failures');

  writeEnv({ SFTP_PASSWORD: 'wrong-password' });
  const badAuth = record(await runUpload([]));
  check('a wrong password exits 2', badAuth.code === 2, `exit ${badAuth.code}`);
  check('reports an authentication failure', /authentication failed/.test(badAuth.out));
  check('does not leak the wrong password', !badAuth.out.includes('wrong-password'));

  writeEnv();
  const traversal = record(await runUpload(['--remote-dir', '../etc']));
  check('refuses a remote path with ..', traversal.code === 3, `exit ${traversal.code}`);

  const absolute = record(await runUpload(['--remote-dir', '/etc']));
  check('refuses an absolute remote path', absolute.code === 3, `exit ${absolute.code}`);

  writeEnv({ SFTP_PORT: '0' });
  const badPort = record(await runUpload([]));
  check('refuses a bad port', badPort.code === 1, `exit ${badPort.code}`);

  const badTimeout = record(await runUpload(['--timeout', '1']));
  check('refuses a short timeout', badTimeout.code === 1, `exit ${badTimeout.code}`);

  check('no output ever contained the password', outputs.every((text) => !text.includes(PASSWORD)));
} finally {
  server.close();
  web.close();
  rmSync(WORK, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.log(`UPLOAD TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log('UPLOAD TESTS PASSED');
