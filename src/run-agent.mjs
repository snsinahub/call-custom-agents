import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

// ── System instruction appended to the SDK default ──────────────────────────
export const SYSTEM_PROMPT =
  "You are running in a non-interactive CI pipeline. " +
  "CRITICAL RULES:\n" +
  "- Do NOT delegate work to other sub-agents or background tasks.\n" +
  "- Do ALL work yourself, directly, using tools in this turn.\n" +
  "- NEVER say work is running in the background.\n" +
  "- NEVER suggest /tasks or ask the user to check back.\n" +
  "- You MUST use tools to write files and create issues — do not just describe what you would do.\n" +
  "- Only respond with a summary AFTER all tool calls are complete.";

// ── Custom agent config builder ─────────────────────────────────────────────
export function buildAgentConfig(agentName) {
  return {
    name: agentName,
    displayName: agentName,
    description: "Custom agent invoked from CI pipeline",
    tools: null, // all tools available
    prompt:
      "You are a code analysis specialist. " +
      "Do ALL work yourself in this turn — NEVER delegate to sub-agents or background tasks. " +
      "Use tools to read, analyze, write files, and create GitHub issues. " +
      "Steps:\n" +
      "1. Use tools to map the repository structure and read key files\n" +
      "2. Analyze dependencies and code patterns\n" +
      "3. Use the execute tool to run `mkdir -p reports`\n" +
      "4. Use the edit tool to write findings to `reports/repo-analysis.md` with Mermaid diagrams\n" +
      "5. Use github/list_issues MCP tool to check existing issues\n" +
      "6. Use github/create_issue MCP tool to create an issue for each NEW finding\n" +
      "7. Only after ALL steps, respond with a summary of what you did",
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

// ── Build the full prompt sent to the model ─────────────────────────────────
export function buildPrompt(userPrompt) {
  return (
    "Analyze the repository in the current working directory. " +
    "Do ALL steps yourself — do NOT delegate to sub-agents or background tasks. " +
    "You MUST use tools to write a report file and create GitHub issues. " +
    "Do not just describe findings — actually write them to disk and create issues.\n\n" +
    "User instructions: " + userPrompt
  );
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
    // Create session with the custom agent activated.
    // The agent config defines its tools, MCP servers, and instructions.
    // systemMessage appends CI-specific rules (no background tasks, etc.)
    const agentConfig = buildAgentConfig(agentName);
    const session = await client.createSession({
      model,
      workingDirectory,
      systemMessage: {
        mode: "append",
        content: SYSTEM_PROMPT,
      },
      customAgents: [agentConfig],
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
    const fullPrompt = buildPrompt(userPrompt);
    core.info(`⏳ Waiting for agent to complete (timeout: ${timeout}ms)…`);
    const response = await session.sendAndWait({ prompt: fullPrompt }, timeout);
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