import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

// ── Agent definition builder ────────────────────────────────────────────────
export function buildAgentConfig(agentName) {
  return {
    name: agentName,
    displayName: "Repo Analyzer MCP",
    description:
      "Analyzes a repository for code patterns, dependencies, and structure. " +
      "Generates a summary report and creates GitHub issues for any concerns found.",
    tools: ["read", "search", "edit", "execute"],
    prompt:
      "You are a code analysis specialist running in a CI pipeline. " +
      "You MUST complete ALL work before responding. Do NOT say you will do something later " +
      "or that work is running in the background. Perform every step synchronously:\n" +
      "1. Map the repository structure using the available tools\n" +
      "2. Analyze dependencies (package.json, requirements.txt, go.mod, etc.)\n" +
      "3. Identify code patterns and CI/CD configuration\n" +
      "4. Run `mkdir -p reports` then write findings to `reports/repo-analysis.md` " +
      "   including all required Mermaid diagrams\n" +
      "5. Check for existing GitHub issues (github/list_issues) then create issues " +
      "   for each new finding (github/create_issue)\n" +
      "6. Only after ALL steps are done, respond with a summary of what you did.",
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        tools: ["*"],
        headers: {
          "X-MCP-Toolsets": "issues,repos,users,pull_requests",
        },
      },
    },
    infer: false,
  };
}

// ── Input parsing (works both in Actions and CLI mode) ──────────────────────
export function parseInputs(isActions = true) {
  if (isActions) {
    return {
      userPrompt: core.getInput("prompt", { required: true }),
      agentName:  core.getInput("agent",  { required: true }),
      githubToken: core.getInput("token", { required: true }),
      model:      core.getInput("model",  { required: false }) || "gpt-4.1",
      timeout:    parseInt(core.getInput("timeout", { required: false }) || "600000", 10),
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
  };
}

async function run() {
  const isActions = !!process.env.GITHUB_ACTIONS;
  const { userPrompt: prompt, agentName, githubToken: token, model, timeout } = parseInputs(isActions);

  core.info(`🚀 Starting Copilot agent: ${agentName}`);
  core.info(`📝 Prompt: ${prompt}`);
  core.info(`⏱  Timeout: ${timeout}ms`);

  // ── Authenticate via env var (highest priority for CI/CD) ───────────────
  // The SDK automatically reads COPILOT_GITHUB_TOKEN
  process.env.COPILOT_GITHUB_TOKEN = token;

  const client = new CopilotClient();
  await client.start();

  try {
    const session = await client.createSession({
      model,
      customAgents: [buildAgentConfig(agentName)],
      agent: agentName,
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
    const response = await session.sendAndWait({ prompt }, timeout);
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