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
    // Plain session — no customAgents, no agent pre-selection.
    // Remote org agents always run as background sub-agents in the CLI.
    // We handle this by polling: after the initial @mention dispatch,
    // we keep asking for results until the sub-agent completes.
    const session = await client.createSession({
      model,
      workingDirectory,
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Track events ───────────────────────────────────────────────────
    let subagentDone = false;

    session.on((event) => {
      switch (event.type) {
        case "session.custom_agents_updated":
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;
        case "session.mcp_servers_loaded":
          core.info("🔌 MCP servers loaded");
          break;
        case "subagent.started":
          core.info(
            `▶  Sub-agent started: ${event.data.agentDisplayName} ` +
            `(${event.data.toolCallId})`
          );
          break;
        case "subagent.completed":
          subagentDone = true;
          core.info(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
          break;
        case "subagent.failed":
          subagentDone = true;
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
          core.error(`   Reason: ${event.data.error}`);
          break;
        case "assistant.message":
          core.info(`💬 Assistant message received (${event.data.content?.length ?? 0} chars)`);
          break;
        case "session.idle":
          core.info("⏸  Session idle");
          break;
        case "session.error":
          core.error(`🚨 Session error: ${event.data.message}`);
          break;
        default:
          core.info(`📡 Event: ${event.type}`);
          break;
      }
    });

    // ── Invoke the org agent via @mention ───────────────────────────────
    const fullPrompt = `@${agentName} ${userPrompt}`;
    core.info(`⏳ Sending prompt to @${agentName} (timeout: ${timeout}ms)…`);
    let response = await session.sendAndWait({ prompt: fullPrompt }, timeout);
    let content = response?.data.content ?? "";

    // ── Poll loop: org agents dispatch to background, so we keep ────────
    // asking until the sub-agent finishes and produces real output.
    // Use broad patterns — the model varies its wording each time.
    const POLL_PHRASES = [
      "running in the background",
      "is still running",
      "is now running",
      "still in progress",
      "not finished",
      "has not completed",
      "hasn't completed",
      "not yet complete",
      "is now analyzing",
      "will update you",
      "will notify you",
      "will be automatically notified",
      "as soon as it completes",
      "when it completes",
      "check its status",
      "check its progress",
      "monitor its progress",
      "/tasks",
      "background task",
      "let me know if you need anything else in the meantime",
    ];
    const MAX_POLLS = 120;
    const POLL_DELAY = 15000; // 15s between polls
    let polls = 0;
    const deadline = Date.now() + timeout;

    while (polls < MAX_POLLS && Date.now() < deadline) {
      const lower = content.toLowerCase();
      const isDeferred = POLL_PHRASES.some((p) => lower.includes(p));

      if (!isDeferred || subagentDone) break;

      polls++;
      core.info(`🔄 Agent deferred to background (poll ${polls}/${MAX_POLLS}). Waiting ${POLL_DELAY / 1000}s…`);
      await new Promise((r) => setTimeout(r, POLL_DELAY));

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      response = await session.sendAndWait(
        { prompt: "Has the background task finished? Show me the complete results." },
        remaining
      );
      content = response?.data.content ?? "";
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timeout after ${timeout}ms waiting for agent "${agentName}" to complete.`);
    }

    if (!content) {
      core.warning("⚠️  Agent returned empty response.");
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