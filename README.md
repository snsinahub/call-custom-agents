# call-custom-agents

A [GitHub Action](https://docs.github.com/en/actions) and CLI tool that runs custom [GitHub Copilot](https://docs.github.com/en/copilot) agents using the [Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started). Point it at any custom agent defined in your organization's `.github-private/agents/` directory and it will run it to completion in CI — writing files, creating issues, and opening PRs automatically.

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
| `agent` | ✅ | — | The custom agent name (must match an `.agent.md` file in your org's `.github-private/agents/`) |
| `token` | ✅ | — | GitHub PAT with Copilot Requests permission |
| `model` | ❌ | `claude-sonnet-4.6` | AI model to use (matches GitHub UI coding agent) |
| `timeout` | ❌ | `600000` | Timeout in milliseconds to wait for agent completion |
| `create-pr` | ❌ | `true` | Create a pull request if the agent changes any files |
| `pr-title` | ❌ | `chore: apply changes from Copilot agent` | Title for the auto-created PR |
| `pr-branch` | ❌ | `copilot-agent/auto` | Branch name for the auto-created PR |

### Outputs

| Name | Description |
|------|-------------|
| `response` | The response content returned by the agent |
| `files-changed` | Whether the agent changed any files (`true`/`false`) |
| `pr-url` | URL of the created pull request (empty if none) |

### Minimal example

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Run repo analyzer
        id: analyze
        uses: snsina-org/call-custom-agents@main
        with:
          agent: repo-analyzer-mcp
          prompt: "Analyze this repository and create issues for any concerns"
          token: ${{ secrets.COPILOT_TOKEN }}
          model: claude-sonnet-4.6

      - name: Print results
        run: |
          echo "Response: ${{ steps.analyze.outputs.response }}"
          echo "Files changed: ${{ steps.analyze.outputs.files-changed }}"
          echo "PR: ${{ steps.analyze.outputs.pr-url }}"
```

> **Note:** The workflow needs `contents: write` and `pull-requests: write` permissions for the action to create branches and PRs.

See the [`examples/workflows/`](examples/workflows/) directory for more complete examples.

---

## How it works

The action uses the [Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started) to programmatically invoke custom agents. It tracks agent state dynamically through SDK events rather than static phrase matching:

| SDK Signal | What it tells us |
|---|---|
| `tool.execution_start` / `complete` | Tools actively executing (tracked via a pending-tools set) |
| `assistant.turn_start` / `end` | LLM is generating a response (nested turn counter) |
| `session.idle` + `backgroundTasks` | Session paused, but sub-agents or shells may still be running |
| `session.task_complete` | Agent explicitly signals it is done |
| `user_input.requested` | Agent is blocked waiting for user input (auto-replied in CI) |
| `system.notification` | Sub-agent completion/failure notifications from the server |
| `toolRequests` on last message | Unexecuted tool calls that need a nudge |

The agent is considered **done** when all of these are true:
1. `session.idle` has fired
2. No pending tool executions
3. No active assistant turns
4. No background tasks (agents/shells)
5. Idle duration exceeds stabilization threshold (15s)

Or immediately when `session.task_complete` fires.

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
MODEL=gpt-4.1 node src/run-agent.mjs repo-analyzer-mcp "Summarize dependencies"

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
