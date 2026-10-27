#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Install the Antigravity provider plugin for CloudCLI.

Usage:
  ./install.sh [--cloudcli-source DIR]

Options:
  --cloudcli-source DIR  Apply this repository's provider-plugin patch to a
                         clean CloudCLI source checkout before installation.
  -h, --help             Show this help.

The plugin is installed for the current user in ~/.claude-code-ui/plugins/antigravity.
EOF
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CORE_SOURCE=""

while (($#)); do
  case "$1" in
    --cloudcli-source)
      if (($# < 2)) || [[ -z "$2" ]]; then
        echo "error: --cloudcli-source requires a directory" >&2
        exit 2
      fi
      CORE_SOURCE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${HOME:-}" ]]; then
  echo 'error: HOME is not set' >&2
  exit 1
fi
for command in node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: $command is required to build and install this plugin" >&2
    exit 1
  fi
done

PLUGIN_DIR="$HOME/.claude-code-ui/plugins/antigravity"
PLUGIN_PARENT="$(dirname "$PLUGIN_DIR")"

if [[ "$ROOT" != "$PLUGIN_DIR" ]] && [[ -e "$PLUGIN_DIR" ]]; then
  if [[ ! -d "$PLUGIN_DIR" || -L "$PLUGIN_DIR" ]] || ! node -e '
    try {
      const manifest = require(process.argv[1]);
      process.exit(manifest.name === "antigravity" ? 0 : 1);
    } catch { process.exit(1); }
  ' "$PLUGIN_DIR/manifest.json"; then
    echo "error: refusing to replace $PLUGIN_DIR because it is not an Antigravity plugin directory" >&2
    exit 1
  fi
fi

if [[ -n "$CORE_SOURCE" ]]; then
  if ! CORE_ROOT="$(git -C "$CORE_SOURCE" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "error: --cloudcli-source must point inside a Git checkout: $CORE_SOURCE" >&2
    exit 1
  fi
  if [[ ! -f "$CORE_ROOT/server/index.ts" || ! -d "$CORE_ROOT/server/modules/plugins" ]]; then
    echo "error: this does not look like a CloudCLI source checkout: $CORE_ROOT" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$CORE_ROOT" status --porcelain --untracked-files=all)" ]]; then
    echo "error: CloudCLI source checkout has local changes; commit or save them before applying the provider patch: $CORE_ROOT" >&2
    exit 1
  fi
fi

echo 'Installing build dependencies...'
(cd "$ROOT" && npm ci)
rm -rf "$ROOT/dist"
(cd "$ROOT" && npm run build)

if [[ -n "$CORE_SOURCE" ]]; then
  echo "Applying provider-plugin support to $CORE_ROOT..."
  "$ROOT/scripts/apply-core-patches.sh" "$CORE_ROOT"
fi

mkdir -p "$PLUGIN_PARENT"
if [[ "$ROOT" == "$PLUGIN_DIR" ]]; then
  echo "Plugin is already in its CloudCLI install directory: $PLUGIN_DIR"
else
  STAGE="$(mktemp -d "$PLUGIN_PARENT/.antigravity-install.XXXXXX")"
  BACKUP="$PLUGIN_PARENT/.antigravity-backup.$$.$RANDOM"
  while [[ -e "$BACKUP" ]]; do
    BACKUP="$PLUGIN_PARENT/.antigravity-backup.$$.$RANDOM"
  done
  cleanup() {
    local status=$?
    if [[ -n "${STAGE:-}" && -e "$STAGE" ]]; then
      rm -rf -- "$STAGE"
    fi
    if [[ -e "$BACKUP" && ! -e "$PLUGIN_DIR" ]]; then
      mv -- "$BACKUP" "$PLUGIN_DIR"
    fi
    exit "$status"
  }
  trap cleanup EXIT

  cp -R "$ROOT/manifest.json" "$ROOT/package.json" "$ROOT/icon.svg" "$ROOT/dist" "$STAGE/"
  if [[ -e "$PLUGIN_DIR" ]]; then
    mv -- "$PLUGIN_DIR" "$BACKUP"
  fi
  mv -- "$STAGE" "$PLUGIN_DIR"
  STAGE=""
  rm -rf -- "$BACKUP"
  trap - EXIT
  echo "Installed Antigravity provider in $PLUGIN_DIR"
fi

echo 'Restart CloudCLI to load the plugin.'
echo 'Antigravity CLI must be installed and authenticated for the user running CloudCLI.'
