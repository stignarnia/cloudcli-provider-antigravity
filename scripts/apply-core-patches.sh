#!/usr/bin/env bash
#
# Applies core-patch/*.patch (in name order) to a CloudCLI checkout and commits
# each one, so the next update can reset to clean upstream and apply again.
#
#   apply-core-patches.sh <cloudcli-checkout>
#
# Per patch:
#   applies cleanly           -> applied and committed
#   already in upstream       -> skipped (upstream merged it or an equivalent)
#   conflicts                 -> tries a 3-way merge; if that fails too, the
#                                patch is skipped, the tree is left exactly as
#                                before it, and the script exits 1 at the end
#
# A skipped 10-provider-plugins.patch leaves plain upstream CloudCLI: it still
# builds and runs, it just ignores provider plugins until the patch is
# regenerated against the new upstream.
#
set -uo pipefail

SRC="${1:?usage: $0 <cloudcli-checkout>}"
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../core-patch" && pwd)"
GIT=(git -C "$SRC" -c user.name="cloudcli local patches" -c user.email="local-patches@localhost" -c core.hooksPath=/dev/null)

failed=0
shopt -s nullglob
for patch in "$PATCH_DIR"/*.patch; do
    name="$(basename "$patch")"

    if "${GIT[@]}" apply --check "$patch" 2>/dev/null; then
        "${GIT[@]}" apply --index "$patch"
    elif "${GIT[@]}" apply --check --reverse "$patch" 2>/dev/null; then
        echo "  -> $name: already in upstream, skipped"
        continue
    elif "${GIT[@]}" apply --index --3way "$patch" 2>/dev/null; then
        echo "  -> $name: applied with a 3-way merge"
    else
        "${GIT[@]}" reset -q --hard HEAD
        echo "  !! $name: does not apply to this upstream, SKIPPED (regenerate it)" >&2
        failed=1
        continue
    fi

    "${GIT[@]}" commit -q --no-verify -m "local patch: $name"
    echo "  -> $name: applied"
done

exit "$failed"
