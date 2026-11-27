// Shared retry policy. 10,004 transfers or balance reads will meet a public
// RPC's rate limit at least once, so a run has to outlast a flaky endpoint.
// Only errors that say the request itself failed are retried; a revert, a bad
// key or an empty treasury still stops whatever called this.
export const ATTEMPTS = 5;

export function isTransient(error) {
  const name = error?.name ?? '';
  if (name === 'HttpRequestError' || name === 'TimeoutError' || name === 'WebSocketRequestError') return true;
  if (name === 'WaitForTransactionReceiptTimeoutError') return true;
  const status = error?.status ?? error?.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = error?.code ?? error?.cause?.code;
  if (code === -32005 || code === -32603) return true;
  const text = `${error?.shortMessage ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return /rate limit|too many requests|timed out|timeout|econnreset|econnrefused|epipe|socket hang up|fetch failed|header not found|temporarily unavailable/.test(
    text,
  );
}

export async function retry(label, action) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isTransient(error)) throw error;
      const delay = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(
        `retry     ${label}: ${error.shortMessage ?? error.message} (attempt ${attempt}/${ATTEMPTS - 1}, ${delay}ms)`,
      );
      await new Promise((done) => setTimeout(done, delay));
    }
  }
}
