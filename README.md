# call-custom-agents

A [GitHub Action](https://docs.github.com/en/actions) and CLI tool that runs a custom [GitHub Copilot](https://docs.github.com/en/copilot) agent using the [Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started). The built-in agent analyzes repositories, generates reports, and creates GitHub issues for findings — all powered by MCP.

---

## Repository layout

```
call-custom-agents/
├── src/
│   └── run-agent.mjs        # Source — agent logic and exports
├── tests/
│   └── run-agent.test.mjs   # Unit tests (Node built-in test runner)
├── examples/
│   └── workflows/
│       ├── basic.yml         # Minimal usage example
│       ├── on-pr.yml         # Run on pull requests
│       └── scheduled.yml     # Run on a cron schedule
├── action.yml                # GitHub Action definition (composite)
├── package.json
└── package-lock.json
```

---

## Using as a GitHub Action

This is a **composite action** — it installs Node.js 24 and runs `npm ci` at runtime, so there is no pre-bundled `dist/` to maintain.

### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `prompt` | ✅ | — | The prompt to send to the agent |
| `agent` | ✅ | `repo-analyzer-mcp` | The custom agent name |
| `token` | ✅ | — | GitHub PAT with Copilot Requests permission |
| `model` | ❌ | `gpt-4.1` | AI model to use |

### Outputs

| Name | Description |
|------|-------------|
| `response` | The response content returned by the agent |

### Minimal example

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run repo analyzer
        id: analyze
        uses: snsina-org/call-custom-agents@main
        with:
          agent: repo-analyzer-mcp
          prompt: "Analyze this repository and create issues for any concerns"
          token: ${{ secrets.COPILOT_TOKEN }}

      - name: Print response
        run: echo "${{ steps.analyze.outputs.response }}"
```

See the [`examples/workflows/`](examples/workflows/) directory for more complete examples.

---

## Using as a CLI tool

### Prerequisites

| Requirement | Detail |
|-------------|--------|
| Node.js | **18 or later** |
| GitHub Copilot CLI | Must be installed and authenticated |
| GitHub Copilot subscription | Pro, Pro+, Business, or Enterprise |

### Installation

```bash
git clone https://github.com/snsina-org/call-custom-agents
cd call-custom-agents
npm install
```

### Usage

```bash
node src/run-agent.mjs <agent-name> "<prompt>"
```

#### Examples

```bash
# Run the default repo analyzer agent
node src/run-agent.mjs repo-analyzer-mcp "Analyze this repository"

# Use a different model
MODEL=gpt-4o node src/run-agent.mjs repo-analyzer-mcp "Summarize dependencies"

# Provide a GitHub token for MCP issue creation
GITHUB_TOKEN=ghp_xxx node src/run-agent.mjs repo-analyzer-mcp "Find issues and report them"
```

---

## Development

### Install dependencies

```bash
npm install
```

### Test

Runs unit tests with Node.js's built-in test runner.

```bash
npm test
```

### npm scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `node src/run-agent.mjs` | Run the agent CLI |
| `npm run build` | `ncc build src/run-agent.mjs -o dist --minify` | Bundle into `dist/` (optional, for local use) |
| `npm test` | `node --test tests/run-agent.test.mjs` | Run unit tests |
