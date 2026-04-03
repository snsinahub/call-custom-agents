import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

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
    // Track sub-agent lifecycle using toolCallId (per SDK docs).
    // A multi-phase agent fires multiple subagent.started/completed pairs.
    // We consider "all done" when: (a) at least one sub-agent was seen,
    // (b) all started sub-agents have completed/failed, and
    // (c) the session has been idle with no new sub-agent starts for
    //     a stabilization period.
    const runningSubagents = new Set();  // toolCallIds currently running
    let totalStarted = 0;
    let totalCompleted = 0;
    let lastSubagentActivity = Date.now();  // only reset by sub-agent events
    let sessionIsIdle = false;  // tracks session.idle state
    let subagentResultContent = "";  // Captures the sub-agent's actual output

    session.on((event) => {
      switch (event.type) {
        case "session.custom_agents_updated":
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;
        case "session.mcp_servers_loaded":
          core.info("🔌 MCP servers loaded");
          break;
        case "subagent.started": {
          const id = event.data.toolCallId;
          runningSubagents.add(id);
          totalStarted++;
          lastSubagentActivity = Date.now();
          sessionIsIdle = false;  // new work started
          core.info(
            `▶  Sub-agent started: ${event.data.agentDisplayName} ` +
            `(${id}) [running: ${runningSubagents.size}, total: ${totalStarted}]`
          );
          break;
        }
        case "subagent.completed": {
          const id = event.data.toolCallId;
          runningSubagents.delete(id);
          totalCompleted++;
          lastSubagentActivity = Date.now();
          core.info(
            `✅ Sub-agent completed: ${event.data.agentDisplayName} ` +
            `(${id}) [running: ${runningSubagents.size}, done: ${totalCompleted}/${totalStarted}]`
          );
          break;
        }
        case "subagent.failed": {
          const id = event.data.toolCallId;
          runningSubagents.delete(id);
          totalCompleted++;
          lastSubagentActivity = Date.now();
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
          core.error(`   Reason: ${event.data.error}`);
          break;
        }
        case "assistant.message": {
          const msgContent = event.data.content ?? "";
          core.info(`💬 Assistant message received (${msgContent.length} chars)`);
          // assistant.message resets timer — the model produces messages
          // between phases during orchestration
          lastSubagentActivity = Date.now();
          if (msgContent.length > subagentResultContent.length) {
            subagentResultContent = msgContent;
          }
          break;
        }
        case "tool.execution_start":
        case "tool.execution_complete":
        case "permission.requested":
        case "permission.completed":
          // Tool events logged but do NOT reset lastSubagentActivity.
          // This prevents stuck tool loops from keeping the timer alive.
          core.info(`📡 Event: ${event.type}`);
          break;
        case "session.idle":
          sessionIsIdle = true;
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

    // ── Wait for ALL sub-agent work to finish ─────────────────────────
    // Multi-phase agents fire multiple subagent.started/completed pairs.
    // We wait until: all started sub-agents have completed AND the session
    // has been stable (no new activity) for IDLE_STABILIZATION ms.
    const POLL_DELAY = 5000;         // 5s between checks
    const IDLE_STABILIZATION = 30000; // 30s of no activity = truly done
    const STARTUP_TIMEOUT = 60000;   // 60s max to see first subagent.started
    const deadline = Date.now() + timeout;
    const startTime = Date.now();

    while (Date.now() < deadline) {
      const allCompleted = totalStarted > 0 && runningSubagents.size === 0;
      const idleTime = Date.now() - lastSubagentActivity;
      const elapsed = Date.now() - startTime;

      // Fail fast: if no sub-agent started within STARTUP_TIMEOUT, the
      // agent was likely not found or the model didn't dispatch it.
      if (totalStarted === 0 && elapsed >= STARTUP_TIMEOUT) {
        throw new Error(
          `No sub-agent started within ${STARTUP_TIMEOUT / 1000}s. ` +
          `Agent "${agentName}" may not have been found or dispatched. ` +
          `Check that the agent file exists in your org's .github-private/agents/ directory.`
        );
      }

      if (allCompleted && sessionIsIdle && idleTime >= IDLE_STABILIZATION) {
        core.info(
          `🏁 All sub-agents done (${totalCompleted}/${totalStarted}) ` +
          `and idle for ${Math.round(idleTime / 1000)}s. Proceeding.`
        );
        break;
      }

      core.info(
        `⏳ Waiting… [running: ${runningSubagents.size}, done: ${totalCompleted}/${totalStarted}, ` +
        `idle: ${sessionIsIdle}, stableFor: ${Math.round(idleTime / 1000)}s, elapsed: ${Math.round((Date.now() - (deadline - timeout)) / 1000)}s]`
      );
      await new Promise((r) => setTimeout(r, POLL_DELAY));
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timeout after ${timeout}ms. Sub-agents: ${totalCompleted}/${totalStarted} completed, ` +
        `${runningSubagents.size} still running.`
      );
    }

    // ── All phases done — ask parent to write results to disk ──────────
    core.info(`✅ All sub-agents completed (${totalCompleted} total). Sending results to parent…`);
    core.info(`📄 Captured largest sub-agent result: ${subagentResultContent.length} chars`);

    const followUpPrompt = subagentResultContent
      ? `The background analysis task has completed. Here are the results:\n\n${subagentResultContent}\n\n` +
        `Now use the edit tool to write these results to reports/repo-analysis.md ` +
        `(create the reports directory first with the execute tool if needed). ` +
        `Then respond with a summary of what was written.`
      : `The background task has completed. Show me the full results and write them to reports/repo-analysis.md.`;

    const remaining = deadline - Date.now();
    response = await session.sendAndWait(
      { prompt: followUpPrompt },
      remaining > 0 ? remaining : 60000
    );
    content = response?.data.content ?? "";

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