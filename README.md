# Antigravity provider for CloudCLI

This plugin adds Google Antigravity as a chat provider in CloudCLI. It uses the `agy` command-line client for conversations, models, session history, and tool execution.

## Requirements

- CloudCLI with provider-plugin support
- Antigravity CLI installed and authenticated for the same user that runs CloudCLI
- Bash, Git, Node.js, and npm

## Install

Clone the published repository, then run the installer from its directory:

```sh
git clone <repository-url> antigravity-provider
cd antigravity-provider
./install.sh
```

The installer installs dependencies, builds the plugin, and copies the runtime files to `~/.claude-code-ui/plugins/antigravity`. Restart CloudCLI after installation.

### CloudCLI source checkouts without provider-plugin support

This repository includes a generic CloudCLI patch that adds provider-plugin support. If your CloudCLI build does not already include that support, pass a clean CloudCLI source checkout to the installer:

```sh
./install.sh --cloudcli-source /path/to/CloudCLI
```

The installer applies and commits the patch in that checkout, then installs the plugin. It refuses to patch a checkout with uncommitted or untracked files. Build and restart CloudCLI from the patched source to load provider plugins. If you update CloudCLI to an upstream revision that lacks provider-plugin support, apply the patch again before building that revision.

## Update

In the plugin clone, pull the latest version and rerun the installer:

```sh
git pull --ff-only
./install.sh
```

The installer replaces the installed plugin files for the current user. It does not change CloudCLI source unless `--cloudcli-source` is provided.

## Features

- Streaming conversations with tool activity, resume, and abort support
- Session history from Antigravity's conversation store
- Model and effort selection
- Default, Accept Edits, Bypass Permissions, and Plan modes
- In-chat tool approval prompts, with optional saved allow rules
- Settings integration for authentication status, permission rules, MCP servers, and skills
- A terminal view for starting or resuming Antigravity sessions

Headless Antigravity runs cannot show interactive permission prompts. The plugin uses Antigravity's `PreToolUse` hook to route tool calls through CloudCLI's approval UI. Antigravity deny rules take precedence; allowed reads and edits depend on the selected permission mode. Outside CloudCLI, the hook leaves permission handling to Antigravity.

## Development

```sh
npm ci
npm run build
npm test
```

Tests use sanitized synthetic fixtures. Set `CLOUDCLI_AGY_BINARY` to select a non-default Antigravity executable at runtime.
