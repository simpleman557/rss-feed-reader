#!/bin/bash
# Double-click launcher: starts Feed Reader (if it isn't already running) and opens
# it in your default browser. Leave this window open while you're using the app —
# closing it (or Ctrl+C) stops the server. Re-running this while it's already up
# just opens a new browser tab instead of starting a second instance.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

URL="http://localhost:3001"

is_up() {
  curl -s -o /dev/null --max-time 2 "$URL"
}

echo "Feed Reader"
echo "-----------"

if is_up; then
  echo "Already running — opening $URL"
  open "$URL"
  exit 0
fi

echo "Starting…"
npm start &
SERVER_PID=$!

# Give it up to ~30s to come up (npm start rebuilds the frontend first, then starts
# the server), then open the browser as soon as it responds.
for _ in $(seq 1 60); do
  if is_up; then
    open "$URL"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Feed Reader exited before it came up — see the output above for the error."
    exit 1
  fi
  sleep 0.5
done

echo ""
echo "Feed Reader is running at $URL"
echo "Close this window (or press Ctrl+C) to stop it."
wait "$SERVER_PID"
