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
    // Create session WITHOUT customAgents. The CLI discovers remote agents
    // from .github-private/agents/ automatically. We invoke the remote
    // agent via @mention in the prompt and wait for subagent.completed.
    const session = await client.createSession({
      model,
      workingDirectory,
      systemMessage: {
        mode: "append",
        content: SYSTEM_PROMPT,
      },
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Track agent lifecycle ──────────────────────────────────────────
    let discoveredAgents = null;
    let lastAssistantContent = "";

    // Promise that resolves when the sub-agent completes or the session
    // becomes idle after the sub-agent finishes its work.
    const { promise: agentDone, resolve: resolveAgent, reject: rejectAgent } =
      Promise.withResolvers();

    let subagentStarted = false;
    let subagentCompleted = false;
    let wrongAgentStarted = null;

    const timeoutId = setTimeout(() => {
      rejectAgent(new Error(
        `Timeout after ${timeout}ms waiting for agent "${agentName}" to complete.`
      ));
    }, timeout);

    // ── Subscribe to all session events for visibility ─────────────────
    session.on((event) => {
      switch (event.type) {
        case "session.custom_agents_updated":
          discoveredAgents = event.data;
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;
        case "session.mcp_servers_loaded":
          core.info("🔌 MCP servers loaded");
          break;
        case "subagent.selected":
          core.info(
            `🎯 Agent selected: ${event.data.agentDisplayName} | ` +
            `Tools: ${event.data.tools?.join(", ") ?? "all"}`
          );
          break;
        case "subagent.started": {
          subagentStarted = true;
          const startedName = event.data.agentName ?? event.data.agentDisplayName ?? "";
          if (startedName.toLowerCase() !== agentName.toLowerCase() &&
              !startedName.toLowerCase().includes(agentName.toLowerCase())) {
            wrongAgentStarted = startedName;
          }
          core.info(
            `▶  Sub-agent started: ${event.data.agentDisplayName} ` +
            `(${event.data.toolCallId})`
          );
          break;
        }
        case "subagent.completed":
          subagentCompleted = true;
          core.info(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
          break;
        case "subagent.failed":
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
          core.error(`   Reason: ${event.data.error}`);
          rejectAgent(new Error(
            `Sub-agent "${event.data.agentDisplayName}" failed: ${event.data.error}`
          ));
          break;
        case "subagent.deselected":
          core.info("↩  Agent deselected, returning to parent");
          break;
        case "assistant.message":
          lastAssistantContent = event.data.content ?? "";
          core.info(`💬 Assistant message received (${lastAssistantContent.length} chars)`);
          break;
        case "session.idle":
          core.info("⏸  Session idle");
          // Only resolve when idle AFTER sub-agent completed (the main
          // agent does a final turn to summarize sub-agent output, then
          // goes idle). If no sub-agent was started, also resolve.
          if (subagentCompleted || !subagentStarted) {
            resolveAgent();
          }
          break;
        case "session.error":
          core.error(`🚨 Session error: ${event.data.message}`);
          rejectAgent(new Error(`Session error: ${event.data.message}`));
          break;
        default:
          core.info(`📡 Event: ${event.type}`);
          break;
      }
    });

    // ── Send prompt addressing the remote agent via @mention ────────────
    const fullPrompt = `@${agentName} ${userPrompt}`;
    core.info(`⏳ Sending prompt to @${agentName} (timeout: ${timeout}ms)…`);
    await session.send({ prompt: fullPrompt });

    // Wait for the agent to finish (subagent.completed + session.idle)
    await agentDone;
    clearTimeout(timeoutId);

    const content = lastAssistantContent;

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

    if (wrongAgentStarted) {
      throw new Error(
        `Agent "${agentName}" was discovered but NOT activated. ` +
        `The CLI fell back to built-in "${wrongAgentStarted}".`
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