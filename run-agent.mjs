// run-agent.mjs
// CLI usage:    node run-agent.mjs <agent-name> "<prompt>"
// Action usage: set INPUT_AGENT-NAME, INPUT_PROMPT, INPUT_MODEL env vars

import { CopilotClient } from "@github/copilot-sdk";
import * as core from "@actions/core";

const isGitHubActions = process.env.GITHUB_ACTIONS === "true";

// --- Parse inputs (action env vars or CLI arguments) ---
let agentName, userPrompt, model;

if (isGitHubActions) {
  agentName = core.getInput("agent-name", { required: true });
  userPrompt = core.getInput("prompt", { required: true });
  model = core.getInput("model") || "gpt-4.1";
} else {
  [, , agentName, userPrompt] = process.argv;
  model = process.env.MODEL || "gpt-4.1";
}

if (!agentName || !userPrompt) {
  const msg = 'Usage: node run-agent.mjs <agent-name> "<prompt>"';
  if (isGitHubActions) {
    core.setFailed(msg);
  } else {
    console.error(msg);
    console.error("Available agents: researcher, editor, security-auditor");
  }
  process.exit(1);
}

// --- Define all known custom agents ---
// Add or modify agents here to suit your use case.
const AGENTS = [
  {
    name: "researcher",
    displayName: "Research Agent",
    description: "Explores codebases and answers questions using read-only tools",
    tools: ["grep", "glob", "view"],
    prompt: "You are a research assistant. Analyze code and answer questions. Do not modify any files.",
    infer: false,
  },
  {
    name: "editor",
    displayName: "Editor Agent",
    description: "Makes targeted, minimal code changes",
    tools: ["view", "edit", "bash"],
    prompt: "You are a code editor. Make minimal, surgical changes to files as requested.",
    infer: false,
  },
  {
    name: "security-auditor",
    displayName: "Security Auditor",
    description: "Reviews code for security vulnerabilities and identifies potential issues",
    tools: ["grep", "glob", "view"],
    prompt: "You are a security expert. Identify potential vulnerabilities in code. Never modify files.",
    infer: false,
  },
];

// --- Validate the requested agent exists ---
const matchedAgent = AGENTS.find((a) => a.name === agentName);
if (!matchedAgent) {
  const msg = `❌ Unknown agent: "${agentName}"\nAvailable agents: ${AGENTS.map((a) => a.name).join(", ")}`;
  if (isGitHubActions) {
    core.setFailed(msg);
  } else {
    console.error(msg);
  }
  process.exit(1);
}

// --- Main ---
try {
  const client = new CopilotClient();

  const session = await client.createSession({
    model,
    customAgents: AGENTS,
    agent: agentName, // pre-select the named agent
    onPermissionRequest: async () => ({ kind: "approved" }),
  });

  // Listen for sub-agent lifecycle events
  session.on("subagent.selected", (event) => {
    console.log(`🎯 Agent selected: ${event.data.agentDisplayName}`);
  });

  session.on("subagent.started", (event) => {
    console.log(`▶  Sub-agent started: ${event.data.agentDisplayName}`);
  });

  session.on("subagent.completed", (event) => {
    console.log(`✅ Sub-agent completed: ${event.data.agentDisplayName}`);
  });

  session.on("subagent.failed", (event) => {
    console.error(`❌ Sub-agent failed: ${event.data.agentDisplayName}`);
    console.error(`   Error: ${event.data.error}`);
  });

  console.log(`\n🤖 Running agent: ${matchedAgent.displayName}`);
  console.log(`📝 Prompt: ${userPrompt}\n`);

  const response = await session.sendAndWait({ prompt: userPrompt });

  if (!response?.data?.content) {
    const msg = "❌ No response received from the agent.";
    if (isGitHubActions) {
      core.setFailed(msg);
    } else {
      console.error(msg);
    }
    await client.stop();
    process.exit(1);
  }

  const content = response.data.content;

  console.log("\n--- Response ---");
  console.log(content);

  if (isGitHubActions) {
    core.setOutput("response", content);
  }

  await client.stop();
  process.exit(0);
} catch (err) {
  const msg = `Fatal error: ${err.message ?? err}`;
  if (isGitHubActions) {
    core.setFailed(msg);
  } else {
    console.error(msg);
  }
  process.exit(1);
}
