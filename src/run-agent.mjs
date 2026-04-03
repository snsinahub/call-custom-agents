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
    core.info(`⏳ Sending prompt (timeout: ${timeout}ms)…`);
    sessionIdle = false;
    await session.send({ prompt: userPrompt });

    // ── Auto-continue loop ──────────────────────────────────────────
    // Agents in CI often pause to ask for confirmation ("Let me know
    // if you want to proceed", "shall I create issues?"). In an
    // interactive session a human replies; here we auto-continue.
    //
    // Loop:
    //   1. Wait for session.idle
    //   2. Get the last assistant message
    //   3. If it looks like a question / pause → send "yes, continue"
    //   4. If it looks like a final summary → done
    //   5. If background tasks are active → wait for stabilization
    //
    const POLL_DELAY = 5000;
    const STABILIZATION = 30000;
    const MAX_CONTINUES = 10;  // safety: max auto-continue prompts
    const deadline = Date.now() + timeout;
    let continueCount = 0;

    while (Date.now() < deadline) {
      // Wait for session.idle
      while (!sessionIdle && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_DELAY));
        const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
        core.info(`⏳ Waiting for session.idle… (${elapsed}s elapsed)`);
      }

      if (Date.now() >= deadline) break;

      // Session is idle — check the last message
      const messages = await session.getMessages();
      const assistantMsgs = messages.filter(
        (m) => m.type === "assistant.message" && m.data?.content
      );
      const lastMsg = assistantMsgs.length > 0
        ? assistantMsgs[assistantMsgs.length - 1].data.content
        : "";

      core.info(`📝 Last response (${lastMsg.length} chars): "${lastMsg.substring(0, 200)}…"`);

      // Check if the agent is asking for confirmation / pausing
      const lower = lastMsg.toLowerCase();

      // First: check if agent says work is STILL IN PROGRESS — never
      // exit or auto-continue when the agent says it's still working
      const isStillWorking =
        lower.includes("still running") ||
        lower.includes("still in progress") ||
        lower.includes("analysis is still") ||
        lower.includes("not yet complete") ||
        lower.includes("hasn't completed") ||
        lower.includes("has not completed") ||
        lower.includes("will complete without interruption") ||
        lower.includes("no further input is required");

      if (isStillWorking) {
        // Agent is working — reset activity timer and keep waiting
        core.info("🔄 Agent says work is still in progress. Continuing to wait…");
        lastActivityTime = Date.now();
        sessionIdle = false; // force re-wait for next idle
        await new Promise((r) => setTimeout(r, POLL_DELAY));
        continue;
      }

      // Second: check if the agent stated intent to do more work but
      // then went idle without doing it (common with sub-agent dispatch)
      const isIncompleteWork =
        lower.includes("let me create") ||
        lower.includes("let me write") ||
        lower.includes("let me generate") ||
        lower.includes("let me verify") ||
        lower.includes("let me compile") ||
        lower.includes("let me build") ||
        lower.includes("let me produce") ||
        lower.includes("now i'll create") ||
        lower.includes("now i'll write") ||
        lower.includes("now i'll generate") ||
        lower.includes("i will create") ||
        lower.includes("i will write") ||
        lower.includes("i will generate");

      if (isIncompleteWork && continueCount < MAX_CONTINUES) {
        continueCount++;
        core.info(`🔄 Agent stated intent to continue but went idle (${continueCount}/${MAX_CONTINUES}). Auto-continuing…`);
        sessionIdle = false;
        lastActivityTime = Date.now();
        await session.send({
          prompt: "Continue. Write all output files now. Do not stop until the report is fully written and saved to disk.",
        });
        continue;
      }

      // Third: check if asking for confirmation
      const isAskingToContinue =
        lower.includes("let me know") ||
        lower.includes("shall i") ||
        lower.includes("would you like") ||
        lower.includes("do you want") ||
        lower.includes("want me to") ||
        lower.includes("proceed with") ||
        lower.includes("if you want to review") ||
        lower.includes("if you'd like");

      if (isAskingToContinue && continueCount < MAX_CONTINUES) {
        continueCount++;
        core.info(`🔄 Agent paused for confirmation (${continueCount}/${MAX_CONTINUES}). Auto-continuing…`);
        sessionIdle = false;
        lastActivityTime = Date.now();
        await session.send({
          prompt: "Yes, proceed with all remaining steps. Complete everything without asking for confirmation. This is a non-interactive CI environment.",
        });
        continue; // back to waiting for idle
      }

      // Not asking a question — check if background tasks need settling
      if (hasBackgroundTasks) {
        const idleTime = Date.now() - lastActivityTime;
        if (idleTime < STABILIZATION) {
          core.info(`⏳ Background tasks settling… (${Math.round(idleTime / 1000)}s/${STABILIZATION / 1000}s)`);
          await new Promise((r) => setTimeout(r, POLL_DELAY));

          // Re-fetch last message to check if agent reported completion
          const freshMsgs = await session.getMessages();
          const freshAssistant = freshMsgs.filter(
            (m) => m.type === "assistant.message" && m.data?.content
          );
          const freshMsg = freshAssistant.length > 0
            ? freshAssistant[freshAssistant.length - 1].data.content.toLowerCase()
            : "";

          // If still says "in progress" — don't settle, keep waiting
          if (freshMsg.includes("still running") ||
              freshMsg.includes("still in progress") ||
              freshMsg.includes("analysis is still")) {
            core.info("🔄 Agent still reports work in progress. Resetting stabilization…");
            lastActivityTime = Date.now();
          }

          if (!sessionIdle) continue;
          continue;
        }
        core.info(`🏁 Background tasks settled (idle for ${Math.round(idleTime / 1000)}s).`);
      }

      // Done — agent finished and isn't asking questions
      core.info(`✅ Agent completed. Auto-continued ${continueCount} times.`);
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