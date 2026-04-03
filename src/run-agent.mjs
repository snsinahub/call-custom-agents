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
    // Create a plain session. We'll select the remote agent via
    // session.rpc.agent.select() after it's discovered — this is the
    // same mechanism the CLI/UI uses natively. It activates the agent
    // INLINE in the session (not as a background sub-agent), so
    // sendAndWait properly waits for all work to finish.
    const session = await client.createSession({
      model,
      workingDirectory,
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Track events for hybrid wait ─────────────────────────────────
    let agentsDiscovered = false;
    let sessionIdle = false;
    let hasBackgroundTasks = false;
    let lastActivityTime = Date.now();

    session.on((event) => {
      switch (event.type) {
        case "session.custom_agents_updated":
          agentsDiscovered = true;
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;
        case "session.mcp_servers_loaded":
          core.info("🔌 MCP servers loaded");
          break;
        case "session.background_tasks_changed":
          hasBackgroundTasks = true;
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;
        case "subagent.started":
          lastActivityTime = Date.now();
          core.info(
            `▶  Sub-agent started: ${event.data.agentDisplayName} ` +
            `(${event.data.toolCallId})`
          );
          break;
        case "subagent.completed":
          lastActivityTime = Date.now();
          core.info(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
          break;
        case "subagent.failed":
          lastActivityTime = Date.now();
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
          core.error(`   Reason: ${event.data.error}`);
          break;
        case "assistant.message":
          lastActivityTime = Date.now();
          core.info(`💬 Assistant message received (${event.data.content?.length ?? 0} chars)`);
          break;
        case "assistant.turn_start":
          sessionIdle = false;  // new turn = no longer idle
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;
        case "tool.execution_start":
        case "tool.execution_complete":
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;
        case "permission.requested":
        case "permission.completed":
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;
        case "session.idle":
          sessionIdle = true;
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

    // ── Wait for agent discovery, then select the agent via RPC ────────
    // The CLI discovers remote agents from .github-private/agents/ and
    // fires session.custom_agents_updated. We wait for that, then use
    // session.rpc.agent.select() to activate the agent inline — matching
    // how the CLI/UI natively invokes agents.
    const DISCOVERY_TIMEOUT = 30000; // 30s max to discover agents
    const discoveryStart = Date.now();
    while (!agentsDiscovered && Date.now() - discoveryStart < DISCOVERY_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!agentsDiscovered) {
      throw new Error(
        `Agent discovery timed out after ${DISCOVERY_TIMEOUT / 1000}s. ` +
        `No custom agents were found.`
      );
    }

    // Verify the agent exists in the discovered list
    const agentListResult = await session.rpc.agent.list();
    const availableAgents = agentListResult.agents ?? [];
    const agentExists = availableAgents.some((a) => a.name === agentName);

    core.info(`📋 Available agents: [${availableAgents.map((a) => a.name).join(", ")}]`);

    if (!agentExists) {
      throw new Error(
        `Agent "${agentName}" not found in discovered agents. ` +
        `Available: [${availableAgents.map((a) => a.name).join(", ")}]. ` +
        `Ensure the agent file exists in your org's .github-private/agents/ directory.`
      );
    }

    // Select the agent — this activates it inline for the session,
    // same as CLI/UI does natively
    core.info(`🎯 Selecting agent: ${agentName}…`);
    const selectResult = await session.rpc.agent.select({ name: agentName });
    core.info(`✅ Agent selected: ${selectResult.agent.name} (${selectResult.agent.displayName})`);

    // Verify
    const current = await session.rpc.agent.getCurrent();
    core.info(`📌 Current agent: ${current.agent?.name ?? "none"}`);

    // ── Send prompt using send() — we manage the wait ourselves ──────
    // sendAndWait() resolves on session.idle, which is wrong when the
    // agent dispatches background tasks. We use send() + custom wait.
    core.info(`⏳ Sending prompt (timeout: ${timeout}ms)…`);
    sessionIdle = false;
    await session.send({ prompt: userPrompt });

    // ── Hybrid wait: handles both inline and background agents ──────
    // Phase 1: Wait for initial session.idle (agent processes prompt).
    // Phase 2: If background tasks were dispatched, keep waiting until
    //          ALL activity stops for STABILIZATION period.
    // This handles:
    //   - repo-analyzer-mcp: works inline, idle = done (Phase 1 only)
    //   - repo-analyzer: dispatches to background, needs Phase 2
    //   - DiscoverApp: long inline work, idle fires when truly done
    const POLL_DELAY = 5000;
    const STABILIZATION = 30000;  // 30s of no activity after idle = done
    const deadline = Date.now() + timeout;

    // Phase 1: wait for first session.idle
    core.info("📍 Phase 1: Waiting for initial session.idle…");
    while (!sessionIdle && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_DELAY));
      const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
      core.info(`⏳ Waiting for session.idle… (${elapsed}s elapsed)`);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timeout after ${timeout}ms waiting for agent "${agentName}".`);
    }

    // Phase 2: if background tasks were detected, wait for them
    if (hasBackgroundTasks) {
      core.info("📍 Phase 2: Background tasks detected. Waiting for all activity to settle…");

      // Reset — the agent might produce more activity
      lastActivityTime = Date.now();

      while (Date.now() < deadline) {
        const idleTime = Date.now() - lastActivityTime;

        // Done when: session is idle AND no activity for STABILIZATION period
        if (sessionIdle && idleTime >= STABILIZATION) {
          core.info(`🏁 All activity settled (idle for ${Math.round(idleTime / 1000)}s). Proceeding.`);
          break;
        }

        // If session went non-idle (new turn started), reset
        if (!sessionIdle) {
          // Session is actively processing — just wait
        }

        const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
        core.info(
          `⏳ Phase 2: [idle: ${sessionIdle}, quiet: ${Math.round(idleTime / 1000)}s/${STABILIZATION / 1000}s, elapsed: ${elapsed}s]`
        );
        await new Promise((r) => setTimeout(r, POLL_DELAY));
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timeout after ${timeout}ms waiting for background tasks of agent "${agentName}".`);
      }
    } else {
      core.info("📍 No background tasks detected — agent worked inline. Done.");
    }

    // ── Get the final messages to extract content ──────────────────────
    const messages = await session.getMessages();
    const assistantMessages = messages.filter(
      (m) => m.type === "assistant.message" && m.data?.content
    );
    const content = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1].data.content
      : "";

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