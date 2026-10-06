#!/bin/sh
# Start on macOS from the instance directory, or set RIFTJACK_HOME.
set -eu
mode=${1:---background}
case "$mode" in --foreground|--background) ;; *) echo "Usage: $0 [--foreground|--background]" >&2; exit 1 ;; esac
umask 077
PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:/opt/homebrew/bin:/usr/local/bin"
export PATH
code=$(cd "$(dirname "$0")/.." && pwd -P)
root=$(cd "${RIFTJACK_HOME:-.}" && pwd -P)
if [ "$root" = "$code" ] || [ ! -f "$root/.env" ]; then
    echo "Run from the instance directory or set RIFTJACK_HOME." >&2
    exit 1
fi
cd "$root"

node_bin=$(command -v node) || { echo 'Install Node.js 24+ first.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
command -v lsof >/dev/null || { echo 'lsof is required.' >&2; exit 1; }
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ is required."); process.exit(1); }'
if [ ! -d "$code/node_modules/tsx" ]; then
    echo "Install dependencies first: npm --prefix \"$code\" ci" >&2
    exit 1
fi
tsx=$(cd "$code" && "$node_bin" --input-type=module -e 'console.log((await import("node:url")).fileURLToPath(import.meta.resolve("tsx")))')
# Parse dotenv with Node; never execute .env as shell code. Keep it out of the
# supervisor environment so its children can reload settings after !restart.
data_dir=$("$node_bin" --env-file-if-exists=.env -p 'require("node:path").resolve(process.env.DATA_DIR || "./data")')
"$node_bin" --env-file-if-exists=.env --import "$tsx" "$code/src/main.ts" --check-config

# Verify the replacement loads before stopping the working instance.
"$node_bin" --import "$tsx" --input-type=module -e 'await import((await import("node:url")).pathToFileURL(process.argv[2]).href)' -- preflight "$code/src/supervisor.ts"
exec python3 "$code/scripts/connector-launcher.py" "$root" "$node_bin" "$data_dir" "$code" "$tsx" "$mode"
