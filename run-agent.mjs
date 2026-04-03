// run-agent.mjs
// Usage: node run-agent.mjs <agent-name> "<prompt>"
// Example: node run-agent.mjs researcher "How does auth work?"

import { CopilotClient } from "@github/copilot-sdk";

// --- Parse CLI arguments ---
const [, , agentName, userPrompt] = process.argv;

if (!agentName || !userPrompt) {
  console.error('Usage: node run-agent.mjs <agent-name> "<prompt>"');
  console.error("Available agents: researcher, editor, security-auditor");
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
  console.error(`❌ Unknown agent: "${agentName}"`);
  console.error(`Available agents: ${AGENTS.map((a) => a.name).join(", ")}`);
  process.exit(1);
}

// --- Main ---
try {
  const client = new CopilotClient();

  const session = await client.createSession({
    model: "gpt-4.1",
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
    console.error("❌ No response received from the agent.");
    await client.stop();
    process.exit(1);
  }

  console.log("\n--- Response ---");
  console.log(response.data.content);

  await client.stop();
  process.exit(0);
} catch (err) {
  console.error("Fatal error:", err.message ?? err);
  process.exit(1);
}
