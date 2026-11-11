#!/usr/bin/env node
/**
 * Upload the generated treasury status page over SFTP.
 *
 * Exactly one file is ever transferred: site/index.html. The host, username and
 * password come from a local env file (.env.upload by default) that is
 * git-ignored and never printed. Dry run is the default: it connects, looks at
 * the remote directory, and reports what would be sent. Nothing is written
 * until --live is passed.
 *
 * Usage:
 *   node upload.mjs                      # dry run, safe
 *   node upload.mjs --live               # actually upload
 *   node upload.mjs --env other.env --remote-dir public_html/site
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'ssh2';

const ENV_DEFAULT = '.env.upload';
const PAGE_PATH = 'site/index.html';
const REMOTE_NAME = 'index.html';
const MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_S = 20;
const VERIFY_TIMEOUT_MS = 20000;

export function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function usage() {
  console.log(`Usage: node upload.mjs [options]

Uploads ${PAGE_PATH} to a web host over SFTP. Dry run unless --live is passed.

Options:
  --live                   upload the file (otherwise nothing is written)
  --env PATH               env file with the connection details (default ${ENV_DEFAULT})
  --remote-dir DIR         remote directory, relative to the login root
                           (default public_html, or SFTP_REMOTE_DIR)
  --verify URL             after a live upload, fetch URL and check the served
                           size and <title> (or set SFTP_PUBLIC_URL in the env file)
  --timeout SECONDS        connection timeout (default ${DEFAULT_TIMEOUT_S})
  -h, --help               show this help

Env file keys (never pass these on the command line):
  SFTP_HOST                server hostname
  SFTP_USER                account username
  SFTP_PASSWORD            account password
  SFTP_PORT                port (default 22)
  SFTP_REMOTE_DIR          remote directory (optional, overridden by --remote-dir)

Only ${PAGE_PATH} is ever uploaded, and only when it looks like the static page
status-page.mjs writes, so a misdirected command cannot publish a key file, the
audit log or .env.

Exit codes: 0 ok, 1 usage or config error, 2 connection or upload failure,
3 refused (the file or the destination failed a safety check).`);
}

export function parseArgs(argv) {
  const opts = {
    live: false,
    env: ENV_DEFAULT,
    remoteDir: null,
    verify: null,
    timeout: DEFAULT_TIMEOUT_S,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };

    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--dry-run') {
      opts.live = false;
    } else if (arg === '--env') {
      opts.env = next();
    } else if (arg === '--remote-dir') {
      opts.remoteDir = next();
    } else if (arg === '--verify') {
      opts.verify = next();
    } else if (arg === '--timeout') {
      const seconds = Number(next());
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) {
        fail(`--timeout expects whole seconds between 5 and 300`);
      }
      opts.timeout = seconds;
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }

  return opts;
}

// Minimal KEY=VALUE parser: comments, blank lines, optional "export ", and
// single or double quotes around a value. Nothing is expanded.
export function loadEnvFile(path) {
  if (!existsSync(path)) {
    fail(`no upload config file at ${path} (copy .env.upload.example to .env.upload)`);
  }
  const env = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const index = withoutExport.indexOf('=');
    if (index <= 0) fail(`${path} has a line that is not KEY=VALUE: "${line.slice(0, 40)}"`);
    const key = withoutExport.slice(0, index).trim();
    let value = withoutExport.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function readConfig(env, opts) {
  const missing = ['SFTP_HOST', 'SFTP_USER', 'SFTP_PASSWORD'].filter((key) => !env[key]);
  if (missing.length > 0) {
    fail(`the upload config is missing ${missing.join(', ')} (set them in the env file)`);
  }

  const port = env.SFTP_PORT ? Number(env.SFTP_PORT) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`SFTP_PORT must be a port number, got "${env.SFTP_PORT}"`);
  }

  const remoteDir = opts.remoteDir ?? env.SFTP_REMOTE_DIR ?? 'public_html';
  if (!isSafeRemoteDir(remoteDir)) {
    fail(`refusing remote directory "${remoteDir}": use a relative path with no ".." segments`, 3);
  }

  const publicUrl = opts.verify ?? env.SFTP_PUBLIC_URL ?? null;
  if (publicUrl) {
    if (!/^https?:\/\//i.test(publicUrl)) fail(`--verify expects an http(s) URL, got "${publicUrl}"`);
    try {
      new URL(publicUrl);
    } catch {
      fail(`--verify URL is not valid: "${publicUrl}"`);
    }
  }

  return {
    host: env.SFTP_HOST,
    port,
    username: env.SFTP_USER,
    password: env.SFTP_PASSWORD,
    remoteDir: posix.normalize(remoteDir).replace(/\/+$/, ''),
    publicUrl,
  };
}

export function isSafeRemoteDir(dir) {
  const value = String(dir).trim();
  if (!value) return false;
  if (value.startsWith('/') || value.includes('\\') || value.startsWith('~')) return false;
  if (value.split('/').some((part) => part === '..' || part === '')) return false;
  return true;
}

export function remotePathFor(remoteDir) {
  return posix.join(remoteDir, REMOTE_NAME);
}

// The uploader is deliberately unable to send anything but the generated page.
export function checkPage(path) {
  const full = resolve(path);
  if (dirname(full) !== resolve(dirname(PAGE_PATH)) || basename(full) !== REMOTE_NAME) {
    fail(`refusing to upload ${full}: only ${PAGE_PATH} is allowed`, 3);
  }
  if (!existsSync(full)) {
    fail(`no page at ${PAGE_PATH} - run "node status-page.mjs --out ${PAGE_PATH}" first`);
  }
  const stats = statSync(full);
  if (!stats.isFile()) fail(`${PAGE_PATH} is not a regular file`, 3);
  if (stats.size === 0) fail(`${PAGE_PATH} is empty`, 3);
  if (stats.size > MAX_BYTES) {
    fail(`${PAGE_PATH} is ${stats.size} bytes, larger than the ${MAX_BYTES}-byte limit`, 3);
  }

  const buffer = readFileSync(full);
  const head = buffer.subarray(0, 200).toString('utf8').toLowerCase();
  if (!head.includes('<!doctype html') && !head.includes('<html')) {
    fail(`${PAGE_PATH} does not look like an HTML page`, 3);
  }
  if (/<script[\s>]/i.test(buffer.toString('utf8'))) {
    fail(`refusing to upload ${PAGE_PATH}: it contains a <script> block`, 3);
  }

  return {
    path: full,
    size: stats.size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    buffer,
  };
}

// The password must not reach the terminal through an error message.
function scrub(message, password) {
  let text = String(message ?? '');
  if (password) text = text.split(password).join('***');
  return text.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '<url>';
    }
  });
}

function connect(config, timeoutS, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    const conn = new Client();
    const timer = setTimeout(() => {
      conn.end();
      rejectPromise(new Error(`timed out after ${timeoutS}s connecting to ${config.host}:${config.port}`));
    }, timeoutS * 1000);

    conn
      .on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            rejectPromise(new Error(`could not open an SFTP session: ${err.message}`));
            return;
          }
          clearTimeout(timer);
          resolvePromise({ conn, sftp });
        });
      })
      .on('error', (err) => {
        clearTimeout(timer);
        const reason =
          err.level === 'client-authentication'
            ? `authentication failed for user ${config.username} (check SFTP_USER and SFTP_PASSWORD)`
            : scrub(err.message, password);
        rejectPromise(new Error(reason));
      })
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: timeoutS * 1000,
      });
  });
}

function statOrNull(sftp, path) {
  return new Promise((resolvePromise) => {
    sftp.stat(path, (err, stats) => {
      resolvePromise(err ? null : stats);
    });
  });
}

function fastPut(sftp, localPath, remotePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp.fastPut(localPath, remotePath, { mode: 0o644 }, (err) => {
      if (err) rejectPromise(new Error(err.message));
      else resolvePromise();
    });
  });
}

function pageTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}

async function fetchPage(url, password) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      size: bytes.length,
      text: bytes.toString('utf8'),
    };
  } catch (err) {
    fail(`verification failed: could not fetch ${url}: ${scrub(err?.message ?? err, password)}`, 2);
  }
}

function comparePage(fetched, page, expectedTitle) {
  const problems = [];
  if (fetched.status !== 200) problems.push(`HTTP ${fetched.status}`);
  if (!/text\/html/i.test(fetched.type)) problems.push(`content type ${fetched.type || '(none)'}`);
  if (fetched.size !== page.size) problems.push(`${fetched.size} bytes, expected ${page.size}`);
  const title = pageTitle(fetched.text);
  if (title !== expectedTitle) {
    problems.push(`title ${JSON.stringify(title)}, expected ${JSON.stringify(expectedTitle)}`);
  }
  return problems;
}

// Reads the page back from its public URL. A host or CDN can still be serving
// the previous copy right after the upload, so a mismatch is retried once past
// the cache before it counts as a failure.
async function verifyPublication(url, page, password) {
  const expectedTitle = pageTitle(page.buffer.toString('utf8'));
  if (!expectedTitle) fail(`cannot verify ${url}: ${PAGE_PATH} has no <title>`, 3);

  let target = url;
  let fetched = await fetchPage(target, password);
  let problems = comparePage(fetched, page, expectedTitle);

  const worthRetrying = fetched.status === 200 && /text\/html/i.test(fetched.type);
  if (problems.length > 0 && worthRetrying) {
    const busted = new URL(url);
    busted.searchParams.set('cachebust', String(Date.now()));
    target = busted.toString();
    fetched = await fetchPage(target, password);
    problems = comparePage(fetched, page, expectedTitle);
  }

  if (problems.length > 0) {
    fail(`verification failed for ${target}: ${problems.join('; ')}`, 2);
  }

  log(
    `verified ${target}: HTTP ${fetched.status}, ` +
      `${/text\/html/i.test(fetched.type) ? 'text/html' : fetched.type}, ` +
      `${fetched.size} bytes, title "${expectedTitle}"`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  // Configuration first: a missing .env.upload is a more useful error than a
  // missing page when nothing has been set up yet.
  const config = readConfig(loadEnvFile(opts.env), opts);
  const page = checkPage(PAGE_PATH);
  const remotePath = remotePathFor(config.remoteDir);
  const verifyUrl = config.publicUrl;

  log(
    `${opts.live ? 'LIVE' : 'dry run'}: ${config.host}:${config.port} as ${config.username}, ` +
      `${PAGE_PATH} -> ${remotePath}`,
  );
  log(`local ${PAGE_PATH}: ${page.size} bytes, sha256 ${page.sha256.slice(0, 16)}`);

  let connection;
  try {
    connection = await connect(config, opts.timeout, config.password);
  } catch (err) {
    fail(scrub(err.message, config.password), 2);
  }

  const { conn, sftp } = connection;
  let didUpload = false;
  try {
    const remoteDirStats = await statOrNull(sftp, config.remoteDir);
    if (!remoteDirStats) {
      fail(`remote directory ${config.remoteDir} does not exist (create it, or pass --remote-dir)`, 2);
    }
    if (!remoteDirStats.isDirectory()) {
      fail(`remote path ${config.remoteDir} is not a directory`, 2);
    }

    const existing = await statOrNull(sftp, remotePath);
    if (existing) {
      log(`remote ${remotePath}: exists, ${existing.size} bytes, modified ${new Date(existing.mtime * 1000).toISOString()}`);
    } else {
      log(`remote ${remotePath}: does not exist yet`);
    }

    if (!opts.live) {
      log(
        `would ${existing ? 'overwrite' : 'upload'} ${remotePath} (${page.size} bytes). ` +
          'Nothing was uploaded; pass --live to do it.',
      );
      if (verifyUrl) log(`verification skipped on a dry run (would fetch ${verifyUrl})`);
      return;
    }

    const started = Date.now();
    try {
      await fastPut(sftp, page.path, remotePath);
    } catch (err) {
      fail(`upload failed: ${scrub(err.message, config.password)}`, 2);
    }

    const written = await statOrNull(sftp, remotePath);
    if (!written || written.size !== page.size) {
      fail(`upload finished but the remote size is ${written ? written.size : 'missing'}, expected ${page.size}`, 2);
    }

    log(`uploaded ${remotePath}: ${written.size} bytes in ${Date.now() - started}ms`);
    didUpload = true;
  } finally {
    conn.end();
  }

  if (didUpload && verifyUrl) await verifyPublication(verifyUrl, page, config.password);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  main().catch((err) => fail(scrub(err?.message ?? err), 2));
}
