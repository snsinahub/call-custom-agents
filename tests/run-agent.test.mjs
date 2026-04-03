// tests/run-agent.test.mjs
// Run with: npm test

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, findAgent, parseInputs } from "../src/run-agent.mjs";

describe("AGENTS registry", () => {
  test("contains exactly the three built-in agents", () => {
    const names = AGENTS.map((a) => a.name);
    assert.deepEqual(names, ["researcher", "editor", "security-auditor"]);
  });

  test("every agent has the required fields", () => {
    const requiredFields = ["name", "displayName", "description", "tools", "prompt"];
    for (const agent of AGENTS) {
      for (const field of requiredFields) {
        assert.ok(
          field in agent,
          `Agent "${agent.name}" is missing field "${field}"`
        );
        assert.ok(agent[field] !== undefined && agent[field] !== null && agent[field] !== "", `Agent "${agent.name}" field "${field}" must not be empty`);
      }
      assert.ok(Array.isArray(agent.tools), `Agent "${agent.name}" tools must be an array`);
      assert.ok(agent.tools.length > 0, `Agent "${agent.name}" must have at least one tool`);
    }
  });
});

describe("findAgent()", () => {
  test("returns the researcher agent", () => {
    const agent = findAgent("researcher");
    assert.ok(agent, "should return an agent");
    assert.equal(agent.name, "researcher");
    assert.equal(agent.displayName, "Research Agent");
  });

  test("returns the editor agent", () => {
    const agent = findAgent("editor");
    assert.ok(agent, "should return an agent");
    assert.equal(agent.name, "editor");
    assert.equal(agent.displayName, "Editor Agent");
  });

  test("returns the security-auditor agent", () => {
    const agent = findAgent("security-auditor");
    assert.ok(agent, "should return an agent");
    assert.equal(agent.name, "security-auditor");
  });

  test("returns null for an unknown agent name", () => {
    assert.equal(findAgent("unknown-agent"), null);
    assert.equal(findAgent(""), null);
    assert.equal(findAgent(undefined), null);
  });
});

describe("parseInputs() — CLI mode", () => {
  const originalArgv = process.argv;
  const originalModel = process.env.MODEL;
  const originalGithubToken = process.env.GITHUB_TOKEN;

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
  });

  test("reads agentName and userPrompt from process.argv", () => {
    process.argv = ["node", "run-agent.mjs", "researcher", "How does auth work?"];
    const inputs = parseInputs(false);
    assert.equal(inputs.agentName, "researcher");
    assert.equal(inputs.userPrompt, "How does auth work?");
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
});
