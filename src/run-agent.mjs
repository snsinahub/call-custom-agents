import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

// ── System instruction for the agent ────────────────────────────────────────
export const SYSTEM_PROMPT =
  "You are a code analysis specialist running in a non-interactive CI pipeline. " +
  "You MUST complete ALL work in the current turn before responding. " +
  "NEVER say work is running in the background. NEVER defer work to a later step. " +
  "NEVER suggest /tasks or ask the user to check back. " +
  "Do everything synchronously in this turn:\n" +
  "1. Use tools to map the repository structure\n" +
  "2. Analyze dependencies (package.json, requirements.txt, go.mod, etc.)\n" +
  "3. Identify code patterns and CI/CD configuration\n" +
  "4. Run `mkdir -p reports` then write findings to `reports/repo-analysis.md` " +
  "   including Mermaid diagrams\n" +
  "5. Check for existing GitHub issues (github/list_issues) then create issues " +
  "   for each new finding (github/create_issue)\n" +
  "6. Only after ALL steps are complete, respond with a summary of what you did " +
  "   and the issues you created.";

// ── MCP server config for GitHub API access ─────────────────────────────────
export const MCP_SERVERS = {
  github: {
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    tools: ["*"],
    headers: {
      "X-MCP-Toolsets": "issues,repos,users,pull_requests",
    },
  },
};

// ── Input parsing (works both in Actions and CLI mode) ──────────────────────
export function parseInputs(isActions = true) {
  if (isActions) {
    return {
      userPrompt: core.getInput("prompt", { required: true }),
      agentName:  core.getInput("agent",  { required: true }),
      githubToken: core.getInput("token", { required: true }),
      model:      core.getInput("model",  { required: false }) || "gpt-4.1",
      timeout:    parseInt(core.getInput("timeout", { required: false }) || "600000", 10),
      workingDirectory: process.env.GITHUB_WORKSPACE || process.cwd(),
    };
  }
  // CLI mode: node src/run-agent.mjs <agent> <prompt>
  const [, , agentName, ...rest] = process.argv;
  return {
    agentName,
    userPrompt: rest.join(" "),
    githubToken: process.env.GITHUB_TOKEN,
    model:       process.env.MODEL || "gpt-4.1",
    timeout:     parseInt(process.env.TIMEOUT || "600000", 10),
    workingDirectory: process.cwd(),
  };
}

async function run() {
  const isActions = !!process.env.GITHUB_ACTIONS;
  const { userPrompt, agentName, githubToken: token, model, timeout, workingDirectory } = parseInputs(isActions);

  core.info(`🚀 Starting Copilot agent: ${agentName}`);
  core.info(`📝 Prompt: ${userPrompt}`);
  core.info(`📂 Working directory: ${workingDirectory}`);
  core.info(`⏱  Timeout: ${timeout}ms`);

  // ── Authenticate via env var (highest priority for CI/CD) ───────────────
  process.env.COPILOT_GITHUB_TOKEN = token;

  const client = new CopilotClient();
  await client.start();

  try {
    // Use systemMessage + workingDirectory instead of customAgents to avoid
    // background task dispatch. The system prompt is appended to the SDK's
    // default instructions so all work runs in the foreground turn.
    const session = await client.createSession({
      model,
      workingDirectory,
      systemMessage: {
        mode: "append",
        content: SYSTEM_PROMPT,
      },
      mcpServers: MCP_SERVERS,
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Subscribe to all session events for visibility ─────────────────
    session.on((event) => {
      switch (event.type) {
        case "subagent.selected":
          core.info(
            `🎯 Agent selected: ${event.data.agentDisplayName} | ` +
            `Tools: ${event.data.tools?.join(", ") ?? "all"}`
          );
          break;
        case "subagent.started":
          core.info(
            `▶  Sub-agent started: ${event.data.agentDisplayName} ` +
            `(${event.data.toolCallId})`
          );
          break;
        case "subagent.completed":
          core.info(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
          break;
        case "subagent.failed":
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
          core.error(`   Reason: ${event.data.error}`);
          break;
        case "subagent.deselected":
          core.info("↩  Agent deselected, returning to parent");
          break;
        case "tool.called":
          core.info(`🔧 Tool called: ${event.data.name}`);
          break;
        case "tool.result":
          core.info(`🔧 Tool result: ${event.data.name} → ${event.data.status ?? "ok"}`);
          break;
        case "assistant.message":
          core.info(`💬 Assistant message received (${event.data.content?.length ?? 0} chars)`);
          break;
        case "session.idle":
          core.info("⏸  Session idle — agent finished processing");
          break;
        case "session.error":
          core.error(`🚨 Session error: ${event.data.message}`);
          break;
        default:
          core.info(`📡 Event: ${event.type}`);
          break;
      }
    });

    // ── Send the prompt and wait for completion ──────────────────────────
    core.info(`⏳ Waiting for agent to complete (timeout: ${timeout}ms)…`);
    const response = await session.sendAndWait({ prompt: userPrompt }, timeout);
    const content  = response?.data.content ?? "";

    core.info("\n--- Agent response ---");
    core.info(content);

    // Set action output
    core.setOutput("response", content);

  } finally {
    await client.stop();
  }
}

run().catch((err) => {
  core.setFailed(`Action failed: ${err.message}`);
  process.exit(1);
});