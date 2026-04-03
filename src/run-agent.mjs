import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

// ── Input parsing (works both in Actions and CLI mode) ──────────────────────
export function parseInputs(isActions = true) {
  if (isActions) {
    return {
      userPrompt: core.getInput("prompt", { required: true }),
      agentName:  core.getInput("agent",  { required: true }),
      githubToken: core.getInput("token", { required: true }),
      model:      core.getInput("model",  { required: false }) || "claude-sonnet-4.6",
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
    model:       process.env.MODEL || "claude-sonnet-4.6",
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

    // ── Dynamic state tracking via SDK events ──────────────────────
    // Instead of static phrase matching, we track the agent's actual
    // operational state through SDK events:
    //   - pending tools   → work is actively executing
    //   - active turns    → the LLM is generating a response
    //   - background tasks → sub-agents / shells running
    //   - task_complete   → agent explicitly signals it's done
    //   - user_input      → agent is blocked waiting for user input
    //   - idle + bg tasks → session paused but sub-agents still running

    let agentsDiscovered = false;
    let sessionIdle = false;
    let taskComplete = false;        // session.task_complete fired
    let taskCompleteSummary = "";
    let idleBackgroundTasks = null;   // from session.idle event data
    const pendingTools = new Set();   // track in-flight tool calls
    let activeTurnCount = 0;          // track nested assistant turns
    let pendingUserInput = false;     // agent waiting for user input
    let lastActivityTime = Date.now();

    session.on((event) => {
      switch (event.type) {
        // ── Discovery ─────────────────────────────────────────────
        case "session.custom_agents_updated":
          agentsDiscovered = true;
          core.info(`📋 Custom agents discovered: ${JSON.stringify(event.data)}`);
          break;

        // ── Session lifecycle ─────────────────────────────────────
        case "session.idle":
          sessionIdle = true;
          idleBackgroundTasks = event.data?.backgroundTasks ?? null;
          core.info(
            `⏸  Session idle` +
            (idleBackgroundTasks
              ? ` (bg: ${idleBackgroundTasks.agents?.length ?? 0} agents, ${idleBackgroundTasks.shells?.length ?? 0} shells)`
              : "")
          );
          break;
        case "session.task_complete":
          taskComplete = true;
          taskCompleteSummary = event.data?.summary ?? "";
          core.info(`🏁 Task complete signal: ${taskCompleteSummary}`);
          break;
        case "session.error":
          core.error(`🚨 Session error: ${event.data.message}`);
          break;
        case "session.background_tasks_changed":
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;

        // ── Assistant turns ───────────────────────────────────────
        case "assistant.turn_start":
          activeTurnCount++;
          sessionIdle = false;
          lastActivityTime = Date.now();
          core.info(`📡 Turn start (active: ${activeTurnCount})`);
          break;
        case "assistant.turn_end":
          activeTurnCount = Math.max(0, activeTurnCount - 1);
          lastActivityTime = Date.now();
          core.info(`📡 Turn end (active: ${activeTurnCount})`);
          break;
        case "assistant.message":
          lastActivityTime = Date.now();
          core.info(`💬 Assistant message (${event.data.content?.length ?? 0} chars)`);
          break;

        // ── Tool execution tracking ──────────────────────────────
        case "tool.execution_start":
          pendingTools.add(event.data.toolCallId ?? `tool-${Date.now()}`);
          lastActivityTime = Date.now();
          core.info(`🔧 Tool start: ${event.data.toolName ?? "unknown"} (pending: ${pendingTools.size})`);
          break;
        case "tool.execution_complete":
          pendingTools.delete(event.data.toolCallId ?? "");
          lastActivityTime = Date.now();
          core.info(`🔧 Tool done (pending: ${pendingTools.size})`);
          break;

        // ── Sub-agent lifecycle ──────────────────────────────────
        case "subagent.started":
          lastActivityTime = Date.now();
          core.info(`▶  Sub-agent started: ${event.data.agentDisplayName} (${event.data.toolCallId})`);
          break;
        case "subagent.completed":
          lastActivityTime = Date.now();
          core.info(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
          break;
        case "subagent.failed":
          lastActivityTime = Date.now();
          core.error(`❌ Sub-agent failed: ${event.data.agentDisplayName} — ${event.data.error}`);
          break;

        // ── Blocking states ──────────────────────────────────────
        case "user_input.requested":
          pendingUserInput = true;
          lastActivityTime = Date.now();
          core.info(`❓ User input requested: ${event.data.question ?? "(no question)"}`);
          break;
        case "user_input.completed":
          pendingUserInput = false;
          lastActivityTime = Date.now();
          break;
        case "permission.requested":
        case "permission.completed":
          lastActivityTime = Date.now();
          core.info(`📡 Event: ${event.type}`);
          break;

        // ── Notifications (sub-agent completion from server) ─────
        case "system.notification": {
          lastActivityTime = Date.now();
          const kind = event.data?.kind;
          if (kind?.type === "agent_completed") {
            core.info(`📣 Notification: agent ${kind.agentId} completed (${kind.status})`);
          } else if (kind?.type === "agent_idle") {
            core.info(`📣 Notification: agent ${kind.agentId} idle`);
          } else {
            core.info(`📣 Notification: ${JSON.stringify(kind)}`);
          }
          break;
        }

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
    core.info(`⏳ Sending prompt (timeout: ${timeout}ms)…`);
    sessionIdle = false;
    await session.send({ prompt: userPrompt });

    // ── Dynamic wait loop ───────────────────────────────────────────
    // Uses SDK event state (pending tools, active turns, background
    // tasks, task_complete signal) instead of static phrase matching.
    //
    // The agent is considered "done" when ALL of these are true:
    //   1. session.idle has fired
    //   2. No pending tool executions
    //   3. No active assistant turns
    //   4. No background tasks (agents/shells) reported by idle event
    //   5. Idle duration exceeds stabilization threshold
    //
    // OR: session.task_complete fires (explicit done signal)
    //
    // If the agent is blocked on user_input, we auto-reply.
    //
    const POLL_DELAY = 3000;
    const STABILIZATION = 15000;      // idle time before declaring done
    const MAX_AUTO_REPLIES = 15;      // safety cap
    const deadline = Date.now() + timeout;
    let autoReplyCount = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_DELAY));

      const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);

      // ── Explicit completion signal ──────────────────────────────
      if (taskComplete) {
        core.info(`🏁 Agent finished (task_complete). Auto-replied ${autoReplyCount} times.`);
        break;
      }

      // ── Still actively working? ─────────────────────────────────
      const hasActiveTurns = activeTurnCount > 0;
      const hasPendingTools = pendingTools.size > 0;
      const hasBgTasks =
        (idleBackgroundTasks?.agents?.length ?? 0) > 0 ||
        (idleBackgroundTasks?.shells?.length ?? 0) > 0;

      if (!sessionIdle || hasActiveTurns || hasPendingTools) {
        core.info(
          `⏳ Working… (${elapsed}s) ` +
          `[idle=${sessionIdle}, turns=${activeTurnCount}, tools=${pendingTools.size}]`
        );
        continue;
      }

      // ── Session is idle — handle blocking states ────────────────
      // If the agent requested user input, auto-reply
      if (pendingUserInput && autoReplyCount < MAX_AUTO_REPLIES) {
        autoReplyCount++;
        core.info(`🔄 Agent waiting for input (${autoReplyCount}/${MAX_AUTO_REPLIES}). Auto-replying…`);
        sessionIdle = false;
        lastActivityTime = Date.now();
        await session.send({
          prompt: "Yes, proceed. Complete all remaining steps without asking for confirmation. This is a non-interactive CI environment.",
        });
        continue;
      }

      // ── Background tasks still running? ─────────────────────────
      if (hasBgTasks) {
        const idleTime = Date.now() - lastActivityTime;
        core.info(
          `⏳ Background tasks active (${elapsed}s) ` +
          `[agents=${idleBackgroundTasks.agents?.length ?? 0}, ` +
          `shells=${idleBackgroundTasks.shells?.length ?? 0}, ` +
          `idle=${Math.round(idleTime / 1000)}s]`
        );
        // Keep waiting — background tasks will fire events when done
        continue;
      }

      // ── Idle with no background tasks — stabilization check ─────
      const idleTime = Date.now() - lastActivityTime;
      if (idleTime < STABILIZATION) {
        core.info(`⏳ Stabilizing… (${Math.round(idleTime / 1000)}s/${STABILIZATION / 1000}s)`);
        continue;
      }

      // ── Stabilized — check if agent intended more work ──────────
      // Get the last message to see if the agent stopped mid-thought.
      // This is a lightweight fallback — most cases are caught above.
      if (autoReplyCount < MAX_AUTO_REPLIES) {
        const messages = await session.getMessages();
        const lastAssistant = messages
          .filter((m) => m.type === "assistant.message" && m.data?.content)
          .pop();
        const lastMsg = lastAssistant?.data?.content ?? "";

        // Check for tool_requests in the last message (SDK-provided field
        // indicating the agent issued tool calls that weren't executed)
        const hasUnexecutedTools = (lastAssistant?.data?.toolRequests?.length ?? 0) > 0;

        if (hasUnexecutedTools) {
          autoReplyCount++;
          core.info(`🔄 Unexecuted tool requests detected (${autoReplyCount}/${MAX_AUTO_REPLIES}). Nudging…`);
          sessionIdle = false;
          lastActivityTime = Date.now();
          await session.send({ prompt: "Continue. Execute all pending operations and write output files." });
          continue;
        }

        // Last-resort: check if last message ends mid-sentence
        // (e.g., "Let me create…" with no following tool call)
        const trimmed = lastMsg.trim();
        const endsIncomplete = trimmed.endsWith("…") || trimmed.endsWith("...");
        if (endsIncomplete) {
          autoReplyCount++;
          core.info(`🔄 Response appears incomplete (${autoReplyCount}/${MAX_AUTO_REPLIES}). Continuing…`);
          sessionIdle = false;
          lastActivityTime = Date.now();
          await session.send({ prompt: "Continue. Complete the remaining work and write all files." });
          continue;
        }
      }

      // ── Done ────────────────────────────────────────────────────
      core.info(`✅ Agent completed (${elapsed}s). Auto-replied ${autoReplyCount} times.`);
      break;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timeout after ${timeout}ms waiting for agent "${agentName}".`);
    }

    // ── Extract final response ──────────────────────────────────────
    const allMessages = await session.getMessages();
    const finalAssistantMsgs = allMessages.filter(
      (m) => m.type === "assistant.message" && m.data?.content
    );
    const content = finalAssistantMsgs.length > 0
      ? finalAssistantMsgs[finalAssistantMsgs.length - 1].data.content
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