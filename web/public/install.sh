#!/bin/sh
# agenticjobs installer.
#
#   curl -fsSL https://agenticjobs.work/install.sh | sh
#
# Installs the `agenticjobs` CLI and the `agenticjobs-mcp` stdio server under
# your home directory. No root, no package manager, no system files touched.
# Updating is `agenticjobs update` and removing is `agenticjobs uninstall`,
# which runs a script this installer leaves behind.
#
#   sh -s -- --version X    install a specific release
#   sh -s -- --prefix DIR   install root (default: ~/.local)
set -eu

PKG="@profullstack/agenticjobs"
SITE="${AGENTICJOBS_SITE:-https://agenticjobs.work}"
PREFIX="${AGENTICJOBS_PREFIX:-$HOME/.local}"
VERSION="${AGENTICJOBS_VERSION:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --prefix)  PREFIX="${2:?--prefix needs a value}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || echo "See $SITE"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- what this machine has ----------------------------------------------------

case "$(uname -s)" in
  Linux|Darwin) : ;;
  *) fail "unsupported operating system: $(uname -s). Linux and macOS are supported." ;;
esac

# The board is pure JavaScript, so there is no per-architecture build and no
# tarball to pick. What it does need is a Node new enough to run it.
command -v node >/dev/null 2>&1 || fail "Node 24 or newer is required, and node was not found.
  Debian/Ubuntu:  https://github.com/nodesource/distributions
  macOS:          brew install node
  Any:            https://mise.jdx.dev"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "Node 24 or newer is required; this is $(node -v).
  agenticjobs runs unbundled ES modules and uses Node 24 APIs."
fi

command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node)."

SHARE="$PREFIX/share/agenticjobs"
BIN="$PREFIX/bin"
mkdir -p "$SHARE" "$BIN"

# --- install ------------------------------------------------------------------

SPEC="$PKG"
[ -n "$VERSION" ] && SPEC="$PKG@$VERSION"

say "Installing $SPEC into $SHARE ..."

# Installed into a private tree rather than globally, so this cannot fight with
# a system npm prefix, cannot need root, and can be removed by deleting one
# directory. --omit=dev because nothing here builds from source.
rm -rf "$SHARE/node_modules" "$SHARE/package.json" "$SHARE/package-lock.json"
cd "$SHARE"
printf '{\n  "name": "agenticjobs-install",\n  "private": true\n}\n' > package.json
npm install --silent --no-audit --no-fund --omit=dev "$SPEC" >/dev/null 2>&1 ||
  npm install --no-audit --no-fund --omit=dev "$SPEC" ||
  fail "npm could not install $SPEC"

PKG_DIR="$SHARE/node_modules/$PKG"
[ -d "$PKG_DIR" ] || fail "$SPEC installed but $PKG_DIR is missing."

INSTALLED=$(node -p "require('$PKG_DIR/package.json').version" 2>/dev/null || echo "unknown")

# --- shims --------------------------------------------------------------------
#
# Written here rather than symlinked, so the CLI always runs against the copy
# this installer put down even if npm's own bin links change underneath.

for cmd in agenticjobs agenticjobs-mcp; do
  entry="$PKG_DIR/bin/$cmd.mjs"
  [ -f "$entry" ] || fail "$SPEC does not contain bin/$cmd.mjs"
  cat > "$BIN/$cmd" <<SHIM
#!/bin/sh
# $cmd. Written by the installer; \`agenticjobs uninstall\` removes it.
AGENTICJOBS_HOME="$SHARE" exec node "$entry" "\$@"
SHIM
  chmod 0755 "$BIN/$cmd"
done

# --- what was installed, and how to remove it ---------------------------------

PATHS="$BIN/agenticjobs
$BIN/agenticjobs-mcp
$SHARE"

INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
  printf '{\n'
  printf '  "package": "%s",\n' "$PKG"
  printf '  "version": "%s",\n' "$INSTALLED"
  printf '  "installer": "%s/install.sh",\n' "$SITE"
  printf '  "installedAt": "%s",\n' "$INSTALLED_AT"
  printf '  "prefix": "%s",\n' "$PREFIX"
  printf '  "paths": [\n'
  printf '%s\n' "$PATHS" | sed 's/.*/    "&",/' | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$SHARE/manifest.json"

# Written at install time by the thing that knew exactly what it created, so
# removal is exact and works with no network. A tool that needs the internet to
# uninstall itself is one you cannot remove on a plane.
{
  echo '#!/bin/sh'
  echo '# Removes agenticjobs. Written by the installer.'
  echo '# Your config and your saved logins are NOT touched:'
  echo '#   ~/.config/agenticjobs/'
  echo 'set -eu'
  printf '%s\n' "$PATHS" | sed 's|.*|rm -rf "&"|'
  echo 'echo "agenticjobs removed. Your boards and tokens are still in ~/.config/agenticjobs."'
} > "$SHARE/uninstall.sh"
chmod 0755 "$SHARE/uninstall.sh"

# --- report -------------------------------------------------------------------

say ""
say "Installed agenticjobs $INSTALLED"
say ""

case ":$PATH:" in
  *":$BIN:"*)
    say "Next:"
    say "  agenticjobs signup            create an account on $SITE"
    say "  agenticjobs search rust       search it"
    ;;
  *)
    say "$BIN is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    say ""
    say "Or run it directly:  $BIN/agenticjobs signup"
    ;;
esac

say ""
say "Update with \`agenticjobs update\`, remove with \`agenticjobs uninstall\`."
say "Docs: $SITE/docs"
