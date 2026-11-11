#!/usr/bin/env bash
# Write the Slack webhook URLs into .env without echoing them.
#
# Run:  bash set-slack-env.sh
#
# Each URL is read with hidden input (nothing is echoed, nothing lands in shell
# history), checked to look like a Slack incoming webhook, and written as a
# single SLACK_*WEBHOOK_URL line in .env. Press Enter to leave a route unset, in
# which case it falls back to SLACK_WEBHOOK_URL (or stays disabled).
set -u
cd "$(dirname "$0")"

env_file=".env"
tmp_env="$(mktemp)"
tmp_set="$(mktemp)"
trap 'rm -f "$tmp_env" "$tmp_set"' EXIT

touch "$env_file"

ask() {
  local name="$1" label="$2" value=""
  printf '%s' "$label (hidden, Enter to skip): "
  IFS= read -rs value || true
  printf '\n'
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ -z "$value" ]; then
    echo "  $name: skipped"
    return 0
  fi
  case "$value" in
    https://hooks.slack.com/services/*) ;;
    *)
      echo "  $name: rejected - expected https://hooks.slack.com/services/..." >&2
      return 1
      ;;
  esac
  printf '%s\t%s\n' "$name" "$value" >> "$tmp_set"
  echo "  $name: set (${#value} characters)"
}

ask "SLACK_WEBHOOK_URL" "Default channel (sends + daily summary)"
ask "SLACK_ALERT_WEBHOOK_URL" "Refusals channel (high severity)"
ask "SLACK_WARNING_WEBHOOK_URL" "Low-treasury channel (medium severity)"

if [ ! -s "$tmp_set" ]; then
  echo "Nothing entered - $env_file left unchanged."
  exit 0
fi

names="$(cut -f1 "$tmp_set" | paste -sd'|' -)"
grep -vE "^(${names})=" "$env_file" > "$tmp_env" || true
cut -f1,2 "$tmp_set" | sed 's/\t/=/' >> "$tmp_env"
mv "$tmp_env" "$env_file"
chmod 600 "$env_file"

echo
echo "Wrote $env_file. What the tools now see:"
node --env-file="$env_file" -p \
  "['SLACK_WEBHOOK_URL','SLACK_ALERT_WEBHOOK_URL','SLACK_WARNING_WEBHOOK_URL'].map(k=>k+'='+(process.env[k]?'set':'unset')).join(' | ')" \
  2>/dev/null || echo "(could not re-read the file with node)"
