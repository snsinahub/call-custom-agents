import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

// ── CI-specific system message appended to the agent's own instructions ─────
export const SYSTEM_PROMPT =
  "You are running in a non-interactive CI pipeline. " +
  "CRITICAL RULES:\n" +
  "- Complete ALL work in this turn before responding.\n" +
  "- NEVER say work is running in the background.\n" +
  "- NEVER suggest /tasks or ask the user to check back.\n" +
  "- Use tools to actually perform actions — do not just describe what you would do.\n" +
  "- Only respond with a summary AFTER all tool calls are complete.";

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

  // ── Authenticate ──────────────────────────────────────────────────────
  process.env.COPILOT_GITHUB_TOKEN = token;

  const client = new CopilotClient();
  await client.start();

  try {
    // Register a minimal inline agent with the same name as the remote one.
    // The CLI merges the remote agent's definition (tools, MCP servers,
    // prompt) with this inline stub. Using `agent:` pre-selects it so
    // the work runs INLINE in the main session (not as a background
    // sub-agent). This is the pattern that produced real results in
    // earlier runs — session.idle means all work is done.
    const session = await client.createSession({
      model,
      workingDirectory,
      customAgents: [{
        name: agentName,
        prompt: "",   // empty — defer entirely to the remote agent's prompt
        infer: false,
      }],
      agent: agentName,
      systemMessage: {
        mode: "append",
        content: SYSTEM_PROMPT,
      },
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Track events ───────────────────────────────────────────────────
    let discoveredAgents = null;

    session.on((event) => {
      switch (event.type) {
        case "session.custom_agents_updated":
          discoveredAgents = event.data;
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;
        case "session.mcp_servers_loaded":
          core.info("🔌 MCP servers loaded (remote agent definition merged)");
          break;
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
        case "assistant.message":
          core.info(`💬 Assistant message received (${event.data.content?.length ?? 0} chars)`);
          break;
        case "session.idle":
          core.info("⏸  Session idle — all work complete");
          break;
        case "session.error":
          core.error(`🚨 Session error: ${event.data.message}`);
          break;
        default:
          core.info(`📡 Event: ${event.type}`);
          break;
      }
    });

    // ── Send prompt and wait for session.idle ───────────────────────────
    core.info(`⏳ Sending prompt to ${agentName} (timeout: ${timeout}ms)…`);
    const response = await session.sendAndWait({ prompt: userPrompt }, timeout);
    const content = response?.data.content ?? "";

    // ── Validate ────────────────────────────────────────────────────────
    const agentList = discoveredAgents?.agents ?? [];
    const agentFound = agentList.some(
      (a) => a.name === agentName || a.id === agentName
    );
    if (!agentFound && discoveredAgents) {
      const available = agentList.map((a) => a.name).join(", ") || "none";
      throw new Error(
        `Agent "${agentName}" was NOT found in discovered agents. ` +
        `Available agents: [${available}]. ` +
        `Ensure the agent file exists in your org's .github-private/agents/ directory.`
      );
    }

    // Detect "running in background" non-answers
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes("running in the background") ||
        lowerContent.includes("is now analyzing") ||
        lowerContent.includes("will update you") ||
        lowerContent.includes("will notify you") ||
        lowerContent.includes("check its status") ||
        lowerContent.includes("analysis is complete")) {
      throw new Error(
        `Agent "${agentName}" deferred work to a background task instead of completing inline. ` +
        `Response: "${content.substring(0, 200)}"`
      );
    }

    core.info("\n--- Agent response ---");
    core.info(content);

    // Set action output
    core.setOutput("response", content);

  } finally {
    await client.stop();
  }
}

// Only auto-run when executed directly (not when imported by tests)
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  run().catch((err) => {
    core.setFailed(`Action failed: ${err.message}`);
    process.exit(1);
  });
}