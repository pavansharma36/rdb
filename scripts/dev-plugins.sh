#!/usr/bin/env bash
# Build the bundled plugins and install them into a plugins directory so a dev
# `npm run tauri dev` can discover them.
#
# For each plugin it: builds the binary, copies it into the plugins dir, runs
# `--describe` to get the plugin's PluginInfo, and writes a `<id>.plugin.json`
# manifest ({ pluginInfo, executable }) next to it.
#
# Usage:
#   scripts/dev-plugins.sh [debug|release]
#
# Honours $RDB_PLUGINS_DIR (defaults to <repo>/dev-plugins). Point the host at
# the same dir when running the app:
#   RDB_PLUGINS_DIR=<repo>/dev-plugins npm run tauri dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-debug}"
PLUGINS_DIR="${RDB_PLUGINS_DIR:-$ROOT/dev-plugins}"

CARGO_FLAGS=()
TARGET_SUBDIR=debug
if [ "$PROFILE" = "release" ]; then
  CARGO_FLAGS+=(--release)
  TARGET_SUBDIR=release
fi

# plugin id -> crate name
PLUGINS=(postgres mongodb rabbitmq)
CRATES=(rdb-plugin-postgres rdb-plugin-mongodb rdb-plugin-rabbitmq)

mkdir -p "$PLUGINS_DIR"

for i in "${!PLUGINS[@]}"; do
  id="${PLUGINS[$i]}"
  crate="${CRATES[$i]}"
  echo "==> building $crate ($PROFILE)"
  cargo build ${CARGO_FLAGS[@]+"${CARGO_FLAGS[@]}"} -p "$crate"

  bin_name="$crate"
  [ "$(uname)" = "Windows_NT" ] && bin_name="$crate.exe"
  src_bin="$ROOT/target/$TARGET_SUBDIR/$bin_name"
  dest_bin="$PLUGINS_DIR/$bin_name"
  cp "$src_bin" "$dest_bin"

  # Generate the manifest: wrap the plugin's own --describe output.
  describe_tmp="$PLUGINS_DIR/$id.describe.json"
  "$dest_bin" --describe > "$describe_tmp"
  node -e '
    const fs = require("fs");
    const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const manifest = { pluginInfo: info, executable: "./" + process.argv[3] };
    fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + "\n");
  ' "$describe_tmp" "$PLUGINS_DIR/$id.plugin.json" "$bin_name"
  rm -f "$describe_tmp"
  echo "    installed $id -> $PLUGINS_DIR/$id.plugin.json"
done

echo
echo "Plugins installed to: $PLUGINS_DIR"
echo "Run the app with:"
echo "  RDB_PLUGINS_DIR=$PLUGINS_DIR npm run tauri dev"
