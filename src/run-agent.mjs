import * as core from "@actions/core";
import { CopilotClient } from "@github/copilot-sdk";

async function run() {
  // ── Read action inputs ──────────────────────────────────────────────────
  const prompt    = core.getInput("prompt",  { required: true });
  const agentName = core.getInput("agent",   { required: true });
  const token     = core.getInput("token",   { required: true });
  const model     = core.getInput("model",   { required: false }) || "gpt-4.1";

  core.info(`🚀 Starting Copilot agent: ${agentName}`);
  core.info(`📝 Prompt: ${prompt}`);

  // ── Authenticate via env var (highest priority for CI/CD) ───────────────
  // The SDK automatically reads COPILOT_GITHUB_TOKEN
  process.env.COPILOT_GITHUB_TOKEN = token;

  const client = new CopilotClient();
  await client.start();

  try {
    // ── Mirror the repo-analyzer-mcp agent definition ───────────────────
    const session = await client.createSession({
      model,
      customAgents: [
        {
          name: agentName,
          displayName: "Repo Analyzer MCP",
          description:
            "Analyzes a repository for code patterns, dependencies, and structure. " +
            "Generates a summary report and creates GitHub issues for any concerns found.",
          tools: ["read", "search", "edit", "execute"],
          prompt:
            "You are a code analysis specialist. When assigned a task:\n" +
            "1. Map the repository structure\n" +
            "2. Analyze dependencies\n" +
            "3. Identify code patterns and CI/CD configuration\n" +
            "4. Run `mkdir -p reports` then write findings to `reports/repo-analysis.md` " +
            "   including all required Mermaid diagrams\n" +
            "5. Check for existing GitHub issues (github/list_issues) then create issues " +
            "   for each new finding (github/create_issue)",

          // GitHub MCP server — write access for issue creation
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

          // Disable auto-inference — always explicitly selected via `agent:`
          infer: false,
        },
      ],

      // Pre-select this agent from the first prompt
      agent: agentName,

      // Auto-approve all tool use — required for non-interactive CI execution
      onPermissionRequest: async () => ({ kind: "approved" }),
    });

    // ── Subscribe to sub-agent lifecycle events ──────────────────────────
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
      }
    });

    // ── Send the prompt and wait for completion ──────────────────────────
    const response = await session.sendAndWait({ prompt });
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