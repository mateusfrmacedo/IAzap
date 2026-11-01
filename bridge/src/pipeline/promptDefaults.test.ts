import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defaultSystemPrompt } from "./replyEngine.js";

it("keeps native and bridge defaults aligned with the editable conversation preset", () => {
  const preset = fs.readFileSync(new URL("../../../prompts/conversa-natural.txt", import.meta.url), "utf8").trim();
  assert.equal(defaultSystemPrompt(), preset);
  const swift = fs.readFileSync(new URL("../../../ZapIA/ZapIA/Store/AppStore.swift", import.meta.url), "utf8");
  const block = swift.match(/static let defaultSystemPromptPT =\s*"""\n([\s\S]*?)\n\s*"""/);
  assert.ok(block, "native default prompt missing");
  assert.equal(block[1]!.split("\n").map(line => line.replace(/^ {8}/, "")).join("\n").trim(), preset);
});
