# call-custom-agents

A Node.js CLI tool that uses the [GitHub Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started) to run a named custom agent with a prompt you supply on the command line.

---

## Prerequisites

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

## Installation

```bash
git clone https://github.com/snsina-org/call-custom-agents
cd call-custom-agents
npm install
```

---

## Usage

```bash
node run-agent.mjs <agent-name> "<prompt>"
```

### Examples

```bash
# Ask the researcher agent about authentication
node run-agent.mjs researcher "How does auth work?"

# Ask the editor agent to fix a bug
node run-agent.mjs editor "Fix the null-check in src/utils.js"

# Ask the security auditor to review code
node run-agent.mjs security-auditor "Are there any SQL injection risks?"
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

Open `run-agent.mjs` and add an entry to the `AGENTS` array:

```js
{
  name: "my-agent",           // CLI identifier
  displayName: "My Agent",    // Human-readable name shown in logs
  description: "Does stuff",  // Short description of what the agent does
  tools: ["grep", "view"],    // Tools the agent is allowed to use
  prompt: "System prompt…",   // Instructions given to the model
  infer: false,
}
```

Then call it with:

```bash
node run-agent.mjs my-agent "Do the thing"
```

---

## npm Scripts

| Script | Command |
|--------|---------|
| `npm start` | `node run-agent.mjs` |
| `npm run run-agent` | `node run-agent.mjs` |
