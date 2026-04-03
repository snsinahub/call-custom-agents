// tests/run-agent.test.mjs
// Run with: npm test

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildAgentConfig, parseInputs } from "../src/run-agent.mjs";

describe("buildAgentConfig()", () => {
  test("returns config with the given agent name", () => {
    const cfg = buildAgentConfig("my-agent");
    assert.equal(cfg.name, "my-agent");
  });

  test("has all required fields", () => {
    const cfg = buildAgentConfig("test-agent");
    const requiredFields = ["name", "displayName", "description", "tools", "prompt", "mcpServers"];
    for (const field of requiredFields) {
      assert.ok(field in cfg, `Missing field "${field}"`);
      assert.ok(cfg[field] !== undefined && cfg[field] !== null, `Field "${field}" must not be empty`);
    }
  });

  test("tools is a non-empty array", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.ok(Array.isArray(cfg.tools));
    assert.ok(cfg.tools.length > 0);
  });

  test("infer is disabled", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.equal(cfg.infer, false);
  });

  test("mcpServers includes github server", () => {
    const cfg = buildAgentConfig("test-agent");
    assert.ok(cfg.mcpServers.github);
    assert.equal(cfg.mcpServers.github.type, "http");
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
});
