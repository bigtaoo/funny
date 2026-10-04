# Sourced by generate_image.sh / edit_image.sh before they do any work.
# Runs the calling script once per attempt (MISTRAL_ONCE=1). Keys rotate B -> C -> A -> B.
# On "rate limit" it retries every 20 s; once the current key has been rate-limited for
# 3 minutes it moves to the next key (agreed with the owner on 2026-09-30; the free tier
# seems to have a daily image quota per workspace). Other errors fail at once.
# The key that last succeeded is remembered in ~/.vibe/mistral_last_key, so the next run
# starts there. MISTRAL_KEY=A|B|C forces the starting key. Gives up after 15 minutes.
if [ -z "${MISTRAL_ONCE:-}" ]; then
  last_file="$HOME/.vibe/mistral_last_key"
  key="${MISTRAL_KEY:-$(cat "$last_file" 2>/dev/null || echo B)}"
  next_key() { case "$1" in B) echo C ;; C) echo A ;; *) echo B ;; esac; }
  start=$(date +%s)
  limited_since=""
  while :; do
    if out=$(MISTRAL_ONCE=1 MISTRAL_KEY="$key" bash "$0" "$@" 2>&1); then
      echo "$out"
      echo "$key" > "$last_file"
      echo "(key $key)" >&2
      exit 0
    fi
    if ! grep -q "rate limit" <<<"$out"; then
      echo "$out" >&2
      exit 1
    fi
    now=$(date +%s)
    [ -z "$limited_since" ] && limited_since=$now
    if [ $((now - start)) -ge 900 ]; then
      echo "still rate-limited after 15 minutes on every key, giving up" >&2
      exit 1
    fi
    if [ $((now - limited_since)) -ge 180 ]; then
      key=$(next_key "$key")
      limited_since=""
      echo "key rate-limited for 3 minutes, switching to key $key" >&2
      continue
    fi
    sleep 20
  done
fi
