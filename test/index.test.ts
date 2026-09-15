import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { join } from "node:path";
import type { OverlayOptions } from "@mariozechner/pi-tui";
import sideChatExtension from "../index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-side-chat-test-"));

test.before(() => {
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

test.after(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  rmSync(testAgentDir, { recursive: true, force: true });
});

for (const host of ["pi", "omp"]) {
test(`side chat keeps its draft while switching focus and display mode on ${host}`, async () => {
  const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
  const shortcuts = new Map<string, { handler: (context: unknown) => unknown }>();
  const mainEditor = { focused: true, render: () => ["main draft"] };
  let focused: { focused: boolean } = mainEditor;
  let visibleOverlay: { focused: boolean; ownsOverlayFocusTarget?: (component: unknown) => boolean } | undefined;
  const setFocus = (component: { focused: boolean }) => {
    if (host === "omp" && visibleOverlay && component !== visibleOverlay &&
        !visibleOverlay.ownsOverlayFocusTarget?.(component)) return;
    focused.focused = false;
    focused = component;
    component.focused = true;
  };

  const pi = {
    on: () => {},
    getThinkingLevel: () => "off",
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition as { handler: (args: string, context: unknown) => unknown });
    },
    registerShortcut: (name: string, definition: unknown) => {
      shortcuts.set(name, definition as { handler: (context: unknown) => unknown });
    },
  };

  sideChatExtension(pi as never);

  const command = commands.get("side");
  const fullscreenShortcut = shortcuts.get("alt+shift+m");
  assert.ok(command);
  assert.ok(shortcuts.get("alt+/"));
  assert.ok(fullscreenShortcut);

  const model = {
    id: "test",
    name: "test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const sessionManager = {
    getEntries: () => [],
    getLeafId: () => null,
  };
  const tui = {
    terminal: { rows: 40, columns: 120 },
    hasOverlay: () => false,
    requestRender: () => {},
    ...(host === "omp" ? { getFocused: () => focused, setFocus } : {}),
  };
  const theme = { fg: (_color: string, text: string) => text };
  const handle = host === "omp" ? {} : {
    focus: () => { assert.ok(visibleOverlay); setFocus(visibleOverlay); },
    unfocus: () => setFocus(mainEditor),
    isFocused: () => focused === visibleOverlay,
  };

  const context = {
    model,
    cwd: "/tmp",
    getSystemPrompt: () => "test",
    modelRegistry: { getApiKeyForProvider: async () => "test" },
    sessionManager,
    ui: {
      notify: () => {},
      confirm: async () => true,
      custom: async (
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: string) => void) => {
          focused: boolean;
          handleInput: (data: string) => void;
          render: (width: number) => string[];
          dispose: () => void;
        },
        options: { overlayOptions: OverlayOptions; onHandle: (overlayHandle: unknown) => void },
      ) => {
        let completed = false;
        const overlay = factory(tui, theme, {}, () => { completed = true; });
        visibleOverlay = overlay;
        setFocus(overlay);
        options.onHandle(handle);

        overlay.handleInput("side draft");
        assert.equal(focused, overlay);
        assert.match(overlay.render(100).join("\n"), /side draft/);

        await shortcuts.get("alt+/")!.handler(context);
        assert.equal(focused, mainEditor);
        assert.equal(overlay.focused, false);
        assert.match(overlay.render(100).join("\n"), /side draft/);

        await shortcuts.get("alt+/")!.handler(context);
        assert.equal(focused, overlay);
        assert.equal(overlay.focused, true);
        assert.doesNotMatch(overlay.render(100).join("\n"), /main draft/);

        fullscreenShortcut.handler(context);
        const expanded = overlay.render(100);
        assert.match(expanded.join("\n"), /side draft/);
        assert.equal(expanded.length, tui.terminal.rows);
        fullscreenShortcut.handler(context);
        assert.ok(overlay.render(100).length < expanded.length);
        assert.match(overlay.render(100).join("\n"), /side draft/);

        overlay.dispose();
        assert.equal(completed, true);
        return "close";
      },
    },
  };

  await command.handler("", context);
});
}

test("loads custom shortcuts from the agent dir config", () => {
  writeFileSync(
    join(testAgentDir, "pi-side-chat.json"),
    JSON.stringify({ shortcut: "ctrl+\\", fullscreenShortcut: "ctrl+space" }),
  );

  const shortcuts = new Map<string, unknown>();
  const pi = {
    on: () => {},
    registerCommand: () => {},
    registerShortcut: (name: string, definition: unknown) => {
      shortcuts.set(name, definition);
    },
  };

  sideChatExtension(pi as never);

  assert.ok(shortcuts.has("ctrl+\\"));
  assert.ok(shortcuts.has("ctrl+space"));
  assert.equal(shortcuts.has("alt+/"), false);
  assert.equal(shortcuts.has("alt+shift+m"), false);
});
