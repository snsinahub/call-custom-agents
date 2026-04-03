# call-custom-agents

A Node.js CLI tool and [GitHub Action](https://docs.github.com/en/actions) that uses the [GitHub Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started) to run a named custom agent with a prompt you supply.

---

## Repository layout

```
call-custom-agents/
├── src/
│   └── run-agent.mjs      # Source — agent logic and exports
├── tests/
│   └── run-agent.test.mjs # Unit tests (Node built-in test runner)
├── dist/
│   └── index.mjs          # Bundled output — called by action.yml
├── action.yml             # GitHub Action definition
├── package.json
└── .gitignore
```

---

## Using as a GitHub Action

### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `agent-name` | ✅ | — | Name of the agent to run (`researcher`, `editor`, `security-auditor`) |
| `prompt` | ✅ | — | The prompt to send to the agent |
| `model` | ❌ | `gpt-4.1` | The model to use |
| `github-token` | ❌ | — | GitHub token for authentication. Takes priority over other auth methods. Recommended: `${{ secrets.GITHUB_TOKEN }}` |

### Outputs

| Name | Description |
|------|-------------|
| `response` | The response returned by the agent |

### Example workflow

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run security auditor
        id: audit
        uses: snsina-org/call-custom-agents@main
        with:
          agent-name: security-auditor
          prompt: 'Are there any SQL injection risks in this codebase?'
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Print response
        run: echo "${{ steps.audit.outputs.response }}"
```

> **Note:** The action runs the pre-built `dist/index.mjs` directly — no `npm install` is needed at runtime.

---

## Using as a CLI tool

### Prerequisites

| Requirement | Detail |
|-------------|--------|
| Node.js | **18 or later** |
| GitHub Copilot CLI | Must be installed and authenticated |
| GitHub Copilot subscription | Pro, Pro+, Business, or Enterprise |

Install and authenticate the Copilot CLI first:

```bash
gh extension install github/gh-copilot
gh copilot --version  # verify
```

---

### Installation

```bash
git clone https://github.com/snsina-org/call-custom-agents
cd call-custom-agents
npm install
```

---

### Usage

```bash
node src/run-agent.mjs <agent-name> "<prompt>"
```

#### Examples

```bash
# Ask the researcher agent about authentication
node src/run-agent.mjs researcher "How does auth work?"

# Ask the editor agent to fix a bug
node src/run-agent.mjs editor "Fix the null-check in src/utils.js"

# Ask the security auditor to review code
node src/run-agent.mjs security-auditor "Are there any SQL injection risks?"
```

---

## Available Agents

| Agent name | Display name | Description |
|---|---|---|
| `researcher` | Research Agent | Explores codebases and answers questions using read-only tools |
| `editor` | Editor Agent | Makes targeted, minimal code changes |
| `security-auditor` | Security Auditor | Reviews code for security vulnerabilities and identifies potential issues |

---

## Adding Custom Agents

Open `src/run-agent.mjs` and add an entry to the `AGENTS` array:

```js
{
  name: "my-agent",           // identifier used in CLI and action inputs
  displayName: "My Agent",    // human-readable name shown in logs
  description: "Does stuff",  // short description of what the agent does
  tools: ["grep", "view"],    // tools the agent is allowed to use
  prompt: "System prompt…",   // instructions given to the model
  infer: false,
}
```

After adding an agent, rebuild and commit `dist/`:

```bash
npm run build
git add dist/
git commit -m "chore: rebuild dist"
```

Then call it:

```bash
node src/run-agent.mjs my-agent "Do the thing"
```

Or in a workflow:

```yaml
with:
  agent-name: my-agent
  prompt: 'Do the thing'
```

---

## Development

### Install dependencies

```bash
npm install
```

### Build

Bundles `src/run-agent.mjs` into `dist/index.mjs` using [`@vercel/ncc`](https://github.com/vercel/ncc).
The built file is committed to the repository so the action works without a runtime install step.

```bash
npm run build
```

### Test

Runs unit tests with Node.js's built-in test runner (no extra framework needed).

```bash
npm test
```

### npm Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `node src/run-agent.mjs` | Run the agent CLI |
| `npm run run-agent` | `node src/run-agent.mjs` | Alias for `npm start` |
| `npm run build` | `ncc build src/run-agent.mjs -o dist --minify` | Bundle into `dist/` |
| `npm test` | `node --test tests/run-agent.test.mjs` | Run unit tests |
