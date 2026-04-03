// tests/run-agent.test.mjs
// Run with: npm test

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, buildAgentConfig, buildPrompt, parseInputs } from "../src/run-agent.mjs";

describe("SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    assert.ok(typeof SYSTEM_PROMPT === "string");
    assert.ok(SYSTEM_PROMPT.length > 0);
  });

  test("forbids background/deferred work", () => {
    assert.ok(SYSTEM_PROMPT.includes("NEVER"));
    assert.ok(SYSTEM_PROMPT.includes("background"));
  });

  test("forbids sub-agent delegation", () => {
    assert.ok(SYSTEM_PROMPT.includes("sub-agent"));
    assert.ok(SYSTEM_PROMPT.includes("Do NOT delegate"));
  });
});

describe("buildAgentConfig()", () => {
  test("returns config with the given agent name", () => {
    const cfg = buildAgentConfig("my-agent");
    assert.equal(cfg.name, "my-agent");
    assert.equal(cfg.displayName, "my-agent");
  });

  test("has required fields", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.ok(cfg.prompt.length > 0);
    assert.ok(cfg.description.length > 0);
    assert.ok(cfg.mcpServers.github);
    assert.equal(cfg.mcpServers.github.type, "http");
  });

  test("allows all tools", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.equal(cfg.tools, null);
  });

  test("disables inference", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.equal(cfg.infer, false);
  });

  test("agent prompt forbids delegation", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.ok(cfg.prompt.includes("NEVER delegate"));
  });
});

describe("buildPrompt()", () => {
  test("includes user prompt", () => {
    const result = buildPrompt("check for security issues");
    assert.ok(result.includes("check for security issues"));
  });

  test("forbids sub-agent delegation in prompt", () => {
    const result = buildPrompt("test");
    assert.ok(result.includes("do NOT delegate"));
  });
});

describe("MCP_SERVERS (in agent config)", () => {
  test("has github server with issue toolset", () => {
    const cfg = buildAgentConfig("test");
    assert.ok(cfg.mcpServers.github);
    assert.ok(cfg.mcpServers.github.headers["X-MCP-Toolsets"].includes("issues"));
  });
});

describe("parseInputs() — CLI mode", () => {
  const originalArgv = process.argv;
  const originalModel = process.env.MODEL;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalTimeout = process.env.TIMEOUT;

  afterEach(() => {
    process.argv = originalArgv;
    if (originalModel === undefined) {
      delete process.env.MODEL;
    } else {
      process.env.MODEL = originalModel;
    }
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
    if (originalTimeout === undefined) {
      delete process.env.TIMEOUT;
    } else {
      process.env.TIMEOUT = originalTimeout;
    }
  });

  test("reads agentName and userPrompt from process.argv", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "How does auth work?"];
    const inputs = parseInputs(false);
    assert.equal(inputs.agentName, "researcher");
    assert.equal(inputs.userPrompt, "How does auth work?");
  });

  test("joins multiple argv words into prompt", () => {
    process.argv = ["node", "run-agent.mjs", "editor", "Fix", "the", "bug"];
    const inputs = parseInputs(false);
    assert.equal(inputs.userPrompt, "Fix the bug");
  });

  test("uses MODEL env var when set", () => {
    process.argv = ["node", "run-agent.mjs", "editor", "Fix the bug"];
    process.env.MODEL = "gpt-4o";
    const inputs = parseInputs(false);
    assert.equal(inputs.model, "gpt-4o");
  });

  test("defaults to gpt-4.1 when MODEL env var is not set", () => {
    process.argv = ["node", "run-agent.mjs", "editor", "Fix the bug"];
    delete process.env.MODEL;
    const inputs = parseInputs(false);
    assert.equal(inputs.model, "gpt-4.1");
  });

  test("reads githubToken from GITHUB_TOKEN env var", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "Hello"];
    process.env.GITHUB_TOKEN = "ghs_testtoken123";
    const inputs = parseInputs(false);
    assert.equal(inputs.githubToken, "ghs_testtoken123");
  });

  test("githubToken is undefined when GITHUB_TOKEN env var is not set", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "Hello"];
    delete process.env.GITHUB_TOKEN;
    const inputs = parseInputs(false);
    assert.equal(inputs.githubToken, undefined);
  });

  test("defaults timeout to 600000ms", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "Hello"];
    delete process.env.TIMEOUT;
    const inputs = parseInputs(false);
    assert.equal(inputs.timeout, 600000);
  });

  test("reads TIMEOUT env var", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "Hello"];
    process.env.TIMEOUT = "300000";
    const inputs = parseInputs(false);
    assert.equal(inputs.timeout, 300000);
  });

  test("sets workingDirectory to cwd in CLI mode", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "Hello"];
    const inputs = parseInputs(false);
    assert.equal(inputs.workingDirectory, process.cwd());
  });
});
