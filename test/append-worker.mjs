#!/usr/bin/env node
/**
 * Helper for audit-append-test.mjs: append COUNT numbered entries through
 * appendAuditLine, so several processes can contend for the same audit file.
 *
 * Usage: node test/append-worker.mjs FILE WRITER_ID COUNT
 */

import { appendAuditLine } from '../run-lock.mjs';

const [file, writer, count] = process.argv.slice(2);
if (!file || writer === undefined || count === undefined) {
  console.error('usage: node test/append-worker.mjs FILE WRITER_ID COUNT');
  process.exit(1);
}

for (let i = 0; i < Number(count); i += 1) {
  appendAuditLine(file, { writer: Number(writer), seq: i });
}
