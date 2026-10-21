#!/usr/bin/env bash
# Start CS Lecture Finder. First run creates a virtualenv and installs yt-dlp.
set -e
cd "$(dirname "$0")"

PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then PY="$c"; break; fi
done
[ -z "$PY" ] && { echo "Python 3.9+ is required (brew install python)"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || \
  echo "Note: $($PY --version) is old; newer yt-dlp releases need Python 3.10+. 'brew install python' is recommended."

if [ ! -d .venv ]; then
  echo "Creating virtualenv with $($PY --version)…"
  "$PY" -m venv .venv
fi
# keep yt-dlp current (checked at most once a day) - YouTube changes often and old versions break
if [ -z "$(find .venv/.updated -mtime -1 2>/dev/null)" ]; then
  echo "Updating yt-dlp…"
  .venv/bin/python -m pip install -q --upgrade pip >/dev/null 2>&1 || true
  if .venv/bin/python -m pip install -q --upgrade -r requirements.txt; then touch .venv/.updated
  else echo "Could not install yt-dlp - YouTube discovery disabled, Internet Archive still works."; fi
fi

exec .venv/bin/python app.py "$@"
