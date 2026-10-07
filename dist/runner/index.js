import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/runner/model-setup.ts
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  resolveModelScopeWithDiagnostics
} from "@earendil-works/pi-coding-agent";

// src/runner/harness-setup.ts
import {
  createRegistry
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  resolveCliModel
} from "@earendil-works/pi-coding-agent";

// src/runner/prompt.ts
import { existsSync, readFileSync } from "node:fs";
import { defineExtension, section } from "@earendil-works/pi-durable";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSkillsForPrompt
} from "@earendil-works/pi-coding-agent";
var CANONICAL_TOOL_DEFS = {
  read: createReadToolDefinition(),
  write: createWriteToolDefinition(),
  edit: createEditToolDefinition(),
  bash: createBashToolDefinition()
};
var KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"];
function resolveContextFiles(options) {
  if (options.contextFiles && options.contextFiles.length > 0) {
    return options.contextFiles;
  }
  if (options.resourceLoader?.getAgentsFiles) {
    return options.resourceLoader.getAgentsFiles()?.agentsFiles ?? [];
  }
  return [];
}
function resolveSkills(options) {
  if (options.resourceLoader?.getSkills) {
    return options.resourceLoader.getSkills() ?? [];
  }
  return [];
}
function buildRules(selectedTools) {
  const rules = [];
  const seen = /* @__PURE__ */ new Set();
  const addRule = (rule) => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };
  if (selectedTools.includes("bash")) {
    addRule("Use bash for file operations like ls, rg, find");
  }
  for (const name of selectedTools) {
    const def = CANONICAL_TOOL_DEFS[name];
    if (def?.promptGuidelines) {
      for (const guideline of def.promptGuidelines) {
        addRule(guideline);
      }
    }
  }
  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");
  return rules.map((r) => `- ${r}`).join("\n");
}
function tryReadPromptFile(path, label) {
  if (!path || !existsSync(path)) return void 0;
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    console.error(`Warning: failed to read ${label ?? "prompt"}: ${err}`);
    return void 0;
  }
}
function createPiPrompt(_settings, fallbackCwd, options = {}) {
  const systemPromptOverride = tryReadPromptFile(options.systemPromptPath, "system-prompt");
  const appendPrompt = tryReadPromptFile(options.appendSystemPromptPath, "append-system-prompt");
  const buildSections = (input) => {
    const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
    const contextFiles = resolveContextFiles(options);
    const skills = resolveSkills(options);
    const selectedTools = input.agent.tools.map((t) => t.name);
    const sections = {};
    if (systemPromptOverride) {
      sections.preamble = systemPromptOverride;
    } else {
      sections.preamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
      const visibleTools = selectedTools.filter((name) => name in CANONICAL_TOOL_DEFS).map((name) => `- ${name}: ${CANONICAL_TOOL_DEFS[name].promptSnippet}`);
      sections.tools = `<tools>
${visibleTools.join("\n")}

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>`;
      sections.rules = `<rules>
${buildRules(selectedTools)}
</rules>`;
    }
    if (appendPrompt) {
      sections.addendum = `<addendum>
${appendPrompt}
</addendum>`;
    }
    if (contextFiles.length > 0) {
      const rendered = contextFiles.map((cf) => `<project_instructions path="${cf.path}">
${cf.content}
</project_instructions>`).join("\n\n");
      sections.project_context = `<project_context>
Project-specific instructions and guidelines:

${rendered}
</project_context>`;
    }
    if (skills.length > 0) {
      sections.skills = `<skills>
${formatSkillsForPrompt(skills, "read")}
</skills>`;
    }
    sections.cwd = `<cwd>
${cwd.replace(/\\/g, "/")}
</cwd>`;
    return sections;
  };
  const built = /* @__PURE__ */ new WeakMap();
  const getOrBuild = (input) => {
    let sections = built.get(input);
    if (sections === void 0) {
      sections = buildSections(input);
      built.set(input, sections);
    }
    return sections;
  };
  return defineExtension({
    name: "pi-prompt",
    sections: KEYS.map((key) => section(key, (input) => getOrBuild(input)[key], { tag: false }))
  });
}

// src/runner/harness-setup.ts
function configureHarnessHttp(settingsManager) {
  const proxy = settingsManager.getGlobalSettings()?.httpProxy?.trim();
  if (proxy) {
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
  }
}
function createHarnessSettings(settingsManager, getActiveModel) {
  return {
    get stream() {
      const provider = settingsManager.getProviderRetrySettings?.() ?? {};
      const idle = settingsManager.getHttpIdleTimeoutMs?.() ?? 3e5;
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...provider.maxRetries === void 0 ? {} : { maxRetries: provider.maxRetries }
      };
    },
    get compaction() {
      const active = getActiveModel?.();
      const model = active ? { provider: active.provider, id: active.modelId } : (() => {
        const p = settingsManager.getDefaultProvider();
        const m = settingsManager.getDefaultModel();
        return p && m ? { provider: p, id: m } : void 0;
      })();
      return settingsManager.getCompactionSettings?.(model) ?? {};
    },
    get retry() {
      return settingsManager.getRetrySettings?.() ?? {};
    },
    get steeringMode() {
      return settingsManager.getSteeringMode?.() ?? "immediate";
    },
    get followUpMode() {
      return settingsManager.getFollowUpMode?.() ?? "queue";
    }
  };
}
function createCodingRegistry(settingsManager, cwd, promptOptions) {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
  return registry;
}
var ExecutionEnvs = class {
  #defaultCwd;
  #envs = /* @__PURE__ */ new Map();
  constructor(defaultCwd) {
    this.#defaultCwd = defaultCwd;
  }
  env = ({ cwd = this.#defaultCwd }) => {
    let env = this.#envs.get(cwd);
    if (env === void 0) {
      env = new NodeExecutionEnv({ cwd });
      this.#envs.set(cwd, env);
    }
    return env;
  };
  async cleanup(context) {
    const envs = [...this.#envs.values()];
    this.#envs.clear();
    for (const env of envs) await env.cleanup(context);
  }
};
async function findInitialAgentModel(settingsManager, modelRuntime, cli) {
  if (cli !== void 0) {
    const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
    if (resolved.error !== void 0 || resolved.model === void 0) {
      throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
    }
    return {
      model: { provider: resolved.model.provider, modelId: resolved.model.id },
      thinkingLevel: cli.thinking ?? resolved.thinkingLevel ?? "off"
    };
  }
  const defaultProvider = settingsManager.getDefaultProvider?.();
  const defaultModelId = settingsManager.getDefaultModel?.();
  const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel?.();
  if (defaultProvider && defaultModelId) {
    const models = modelRuntime.getAvailableSnapshot();
    const matched = models.find((m) => m.provider === defaultProvider && m.id === defaultModelId);
    if (matched) {
      return {
        model: { provider: matched.provider, modelId: matched.id },
        thinkingLevel: defaultThinkingLevel ?? "off"
      };
    }
  }
  const available = modelRuntime.getAvailableSnapshot();
  if (available.length > 0) {
    return {
      model: { provider: available[0].provider, modelId: available[0].id },
      thinkingLevel: "off"
    };
  }
  return {};
}

// src/runner/model-setup.ts
async function setupRunnerModels(cwd, args2) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch {
    }
  }
  for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch {
    }
  }
  for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch {
    }
  }
  const availableModels = modelRuntime.getAvailableSnapshot();
  const enabledPatterns = settingsManager.getEnabledModels();
  const scopedScope = enabledPatterns && enabledPatterns.length > 0 ? await resolveModelScopeWithDiagnostics(enabledPatterns, modelRuntime) : void 0;
  const scopedModelList = scopedScope && scopedScope.scopedModels.length > 0 ? scopedScope.scopedModels.map((sm) => sm.model) : availableModels;
  const scopedModelIds = scopedModelList.map((m) => `${m.provider}/${m.id}`);
  const initialAgent = await findInitialAgentModel(
    settingsManager,
    modelRuntime,
    args2.model ? { provider: args2.provider, model: args2.model, thinking: args2.thinking } : void 0
  );
  const defaultModel = initialAgent.model ? modelRuntime.getModel(initialAgent.model.provider, initialAgent.model.modelId) ?? scopedModelList[0] : scopedModelList[0];
  const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : void 0;
  const defaultThinkingLevel = initialAgent.thinkingLevel ?? "off";
  const modelScope = {
    scopedModelIds,
    defaultModelId
  };
  return {
    settingsManager,
    modelRuntime,
    scopedModelList,
    defaultModel,
    defaultThinkingLevel,
    modelScope
  };
}

// src/runner/jsonl.ts
import { StringDecoder } from "node:string_decoder";
function serializeJsonLine(value) {
  return `${JSON.stringify(value)}
`;
}
function attachJsonlLineReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emitLine = (line) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

// src/runner/runtime.ts
import { resolveModelScopeWithDiagnostics as resolveModelScopeWithDiagnostics2 } from "@earendil-works/pi-coding-agent";

// src/runner/upstream/session-storage.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
function getAgentDir2() {
  const override = process.env.PI_AGENT_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return join(homedir(), ".pi", "agent");
}
async function selectSession(cwdInput, continueSession, targetSession) {
  const cwd = await realpath(resolve(cwdInput));
  const root = join(
    getAgentDir2(),
    "experimental",
    "durable-sessions",
    createHash("sha256").update(cwd).digest("hex").slice(0, 24)
  );
  await mkdir(root, { recursive: true });
  let directory;
  let created = false;
  if (targetSession) {
    let cleanTarget = targetSession;
    if (cleanTarget.endsWith(".sqlite")) {
      cleanTarget = resolve(cleanTarget, "..");
    } else if (cleanTarget.endsWith(".jsonl")) {
      cleanTarget = cleanTarget.slice(0, -6);
    }
    if (cleanTarget.includes("/") || cleanTarget.includes("\\")) {
      directory = resolve(cleanTarget);
    } else {
      directory = join(root, cleanTarget);
    }
    try {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      if (!entries.includes("session.sqlite")) {
        const legacyDir = `${directory}.jsonl`;
        try {
          const legacyEntries = await readdir(legacyDir);
          if (legacyEntries.includes("session.sqlite")) {
            directory = legacyDir;
            created = false;
          } else {
            created = true;
          }
        } catch {
          created = true;
        }
      } else {
        created = false;
      }
    } catch {
      created = false;
    }
  } else if (continueSession) {
    const entries = await readdir(root, { withFileTypes: true });
    const newest = entries.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name)).map((entry) => entry.name).sort().at(-1);
    if (!newest) throw new Error(`No durable session exists for ${cwd}`);
    directory = join(root, newest);
  } else {
    directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
    await mkdir(directory);
    created = true;
  }
  let release;
  try {
    release = await lockfile.lock(directory, {
      realpath: false,
      retries: { retries: 12, minTimeout: 1e3, maxTimeout: 1e3 }
    });
  } catch (error) {
    throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
  }
  return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}

// src/runner/runtime-types.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID
} from "@earendil-works/pi-durable";
var runtimeContext = BACKGROUND_CONTEXT;
function agentOf(view) {
  return view.docs["pi.agent"] ?? {};
}
function titleOf(entry) {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
  return { title: text.replace(/\s+/g, " ").trim() };
}
async function firstInput(harness, id) {
  if (id === ROOT_CONVERSATION_ID) return {};
  const conversation = await harness.conversation(id, runtimeContext);
  let first;
  let cursor;
  do {
    const page = await conversation.entries({}, 256, cursor, runtimeContext);
    first = [...page.items].reverse().find((entry) => entry.kind === "pi.user") ?? first;
    cursor = page.next;
  } while (cursor !== void 0);
  return titleOf(first);
}

// src/runner/runtime-controller.ts
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
function createDurableController(ctx) {
  let queue = Promise.resolve();
  const command = (operation) => {
    queue = queue.then(operation).catch(ctx.fail);
    return queue;
  };
  const watchAnswer = (submission) => {
    void submission.wait(runtimeContext).then((settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        ctx.notice(
          "error",
          `No answer: ${settled.reason}${settled.detail === void 0 ? "" : ` ${JSON.stringify(settled.detail)}`}`
        );
      }
    }, ctx.fail);
  };
  const agentModel = () => {
    const ref = agentOf(ctx.getState().conversation).model;
    const model = ref === void 0 ? void 0 : ctx.modelRuntime.getModel(ref.provider, ref.modelId);
    if (model === void 0) {
      throw new Error(ref === void 0 ? "No model selected" : "Current model is unavailable");
    }
    return model;
  };
  return {
    submit: (text, whenBusy) => command(async () => watchAnswer(await ctx.getCurrent().submit({ type: "input", content: text, whenBusy }, runtimeContext))),
    compact: (instructions) => command(async () => {
      const id = await ctx.getCurrent().compact(instructions, runtimeContext);
      void ctx.opened.waitForTask(id, runtimeContext).then(async (receipt) => {
        const outcome = receipt.state.outcome;
        if (outcome.status === "completed") {
          const { entryId, submissionId } = outcome.result;
          const status = submissionId === void 0 ? void 0 : (await (await ctx.opened.submission(submissionId, runtimeContext))?.status(runtimeContext))?.status;
          ctx.notice(
            "info",
            entryId !== void 0 || status === "done" ? "Compacted." : status === "queued" ? "Compaction summary queued; it is placed at the next turn boundary." : status === "unanswered" ? "Compaction summary dropped: the context changed under it." : "Nothing to compact: the context fits in the recent window that is kept verbatim."
          );
        } else if (outcome.status === "aborted") {
          ctx.notice("info", "Compaction aborted.");
        } else {
          ctx.notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
        }
      }, ctx.fail);
    }),
    abort: () => ctx.getCurrent().abort(runtimeContext).catch(ctx.fail),
    cycleThinking: () => command(async () => {
      const model = agentModel();
      if (!model.reasoning) throw new Error("Current model does not support thinking");
      const levels = getSupportedThinkingLevels(model);
      const level = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
      await ctx.getCurrent().configure({ thinkingLevel: next }, runtimeContext);
    }),
    setThinkingLevel: (targetLevel) => command(async () => {
      const model = agentModel();
      if (!model.reasoning) throw new Error("Current model does not support thinking");
      await ctx.getCurrent().configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, runtimeContext);
    }),
    setModel: (ref) => command(async () => {
      const model = ctx.modelRuntime.getModel(ref.provider, ref.modelId);
      if (model === void 0) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
      ctx.setActiveModelRef(ref);
      const thinking = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      await ctx.getCurrent().configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, runtimeContext);
    }),
    toggleTasks: () => command(async () => {
      if (ctx.getTasks() !== void 0) {
        ctx.closeTasks();
        ctx.update({ tasks: void 0 });
        return;
      }
      const graph = await ctx.opened.taskGraph(runtimeContext);
      ctx.setTasks(graph);
      ctx.setUnsubscribeTasks(graph.subscribe((value) => ctx.update({ tasks: value })));
    }),
    switchConversation: (id) => command(async () => {
      const next = await ctx.opened.conversation(id, runtimeContext);
      if (next === void 0) throw new Error(`Conversation ${id} does not exist`);
      const nextState = await next.viewState(runtimeContext);
      ctx.getUnsubscribeConversation()();
      ctx.getConversationState().dispose();
      ctx.setCurrent(next);
      ctx.setConversationState(nextState);
      ctx.setUnsubscribeConversation(nextState.subscribe((value) => ctx.update({ conversation: value })));
    })
  };
}

// src/runner/runtime-loader.ts
import {
  DefaultResourceLoader as DefaultResourceLoader2,
  ModelRuntime as ModelRuntime2,
  SettingsManager as SettingsManager2
} from "@earendil-works/pi-coding-agent";

// src/runner/extension-bridge.ts
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  ExtensionRunner,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { defineExtension as defineExtension2, defineTool } from "@earendil-works/pi-durable";
function hasOutput(api) {
  return typeof api === "object" && api !== null && "output" in api && typeof api.output === "function";
}
function createStandardExtensionFactories() {
  return [createCodemodeExtension({ mode: "auto" }), createToolSearchExtension(), createMcpExtension()];
}
function adaptExtensionTool(toolDef, executeToolFn, createToolContext) {
  return defineTool({
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    async execute(args2, api) {
      const ctx = createToolContext ? createToolContext(api.callId) : {
        tools: [],
        executeTool: async (name, nestedArgs, options) => executeToolFn(api.callId, name, nestedArgs, options)
      };
      const result = await toolDef.execute(
        api.callId,
        args2,
        void 0,
        (update) => {
          if (update?.content && hasOutput(api)) {
            const textChunks = update.content.filter((c) => c.type === "text").map((c) => c.text).join("");
            if (textChunks.length > 0) api.output(textChunks);
          }
        },
        ctx
      );
      return {
        content: result.content,
        isError: result.isError,
        details: result.details ?? void 0
      };
    }
  });
}
function installExtensionTools(registry, tools) {
  if (tools.length === 0) return;
  registry.install(defineExtension2({ name: "extension-tools", tools }));
}
async function setupExtensionRunner(options) {
  const sessionManager = SessionManager.create(options.cwd);
  const modelRegistry = new ModelRegistry(options.modelRuntime);
  const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);
  runner.bindCore(
    {
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      refreshTools: () => {
        options.onToolsChanged?.();
      }
    },
    {
      isProjectTrusted: () => true,
      executeTool: (callerId, name, args2, opts) => options.executeToolFn(callerId, name, args2, opts),
      getCallableTools: () => options.getCallableTools ? options.getCallableTools() : runner.getAllRegisteredTools().map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.parameters
      })),
      getSystemPrompt: () => ""
    }
  );
  await runner.emit({ type: "session_start" });
  return runner;
}

// src/runner/extension-mount.ts
function createNestedToolExecutor(registry) {
  return async (callerId, name, args2) => {
    const target = registry.snapshot().tools().find((t) => t.tool.name === name);
    if (!target) {
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} },
        isError: true
      };
    }
    try {
      const res = await target.tool.execute(
        args2,
        { callId: `${callerId}/nested`, output: () => {
        } },
        runtimeContext
      );
      const rawContent = res.content;
      const content = Array.isArray(rawContent) ? rawContent : [{ type: "text", text: String(rawContent ?? "") }];
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content, details: res.details },
        isError: !!res.isError
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content: [{ type: "text", text: message }], details: {} },
        isError: true
      };
    }
  };
}
async function mountExtensionBridge(location, modelRuntime, extensionsResult, registry, executeToolFn, report) {
  let extensionRunner;
  try {
    const syncToolsToRegistry = () => {
      if (!extensionRunner) return;
      const createToolContext = (callId) => extensionRunner.createToolContext(callId, void 0);
      const adapted = extensionRunner.getAllRegisteredTools().map(
        (t) => adaptExtensionTool(t.definition, executeToolFn, createToolContext)
      );
      installExtensionTools(registry, adapted);
    };
    extensionRunner = await setupExtensionRunner({
      extensions: extensionsResult.extensions,
      runtime: extensionsResult.runtime,
      cwd: location.cwd,
      modelRuntime,
      executeToolFn,
      getCallableTools: () => registry.snapshot().tools().map((t) => ({
        name: t.tool.name,
        description: t.tool.description ?? "",
        parameters: t.tool.parameters
      })),
      onToolsChanged: syncToolsToRegistry
    });
    syncToolsToRegistry();
  } catch (error) {
    report(error);
  }
  return async () => {
    if (extensionRunner) {
      try {
        await extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
      } catch (err) {
        console.warn("[ExtensionBridge] Cleanup session_shutdown failed:", err);
      }
    }
  };
}

// src/runner/upstream/subagent-tool.ts
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension as defineExtension3,
  defineTool as defineTool2
} from "@earendil-works/pi-durable";
async function answerText(api, answer, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0];
  return message?.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("") ?? "";
}
var Subagent = defineExtension3({
  name: "subagent",
  tools: [
    defineTool2({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent with the same tools and get its answer back. Give it everything it needs to know; it does not see this conversation.",
      parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
      replay: "safe",
      execute: async (args2, api, context) => {
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== void 0) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { extensions: { remove: [Subagent] } });
          return created.id;
        }, context);
        await api.details({ conversationId: child }, context);
        const handle = await api.conversation(child, context);
        const request = { type: "input", content: args2.task, requestId: `subagent:${api.taskId}` };
        const settled = await (await handle.submit(request, context)).wait(context);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent ${child} failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, context);
        return { content: [{ type: "text", text }], details: { conversationId: child } };
      }
    })
  ]
});

// src/runner/runtime-loader.ts
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
function registerPendingProviders(modelRuntime, runtime) {
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch {
    }
  }
  for (const { provider } of runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch {
    }
  }
  for (const { definition } of runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch {
    }
  }
}
async function loadHarnessEnvironment(location, options, envs) {
  const modelRuntime = await ModelRuntime2.create();
  const settingsManager = SettingsManager2.create(location.cwd);
  const resourceLoader = new DefaultResourceLoader2({
    cwd: location.cwd,
    agentDir: getAgentDir2(),
    settingsManager,
    extensionFactories: createStandardExtensionFactories()
  });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  registerPendingProviders(modelRuntime, extensionsResult.runtime);
  configureHarnessHttp(settingsManager);
  let activeModelRef;
  const getActiveModel = () => {
    if (activeModelRef) return activeModelRef;
    const p = settingsManager.getDefaultProvider();
    const m = settingsManager.getDefaultModel();
    return p && m ? { provider: p, modelId: m } : void 0;
  };
  const settings = createHarnessSettings(settingsManager, getActiveModel);
  const registry = createCodingRegistry(settingsManager, location.cwd, {
    ...options.prompt,
    resourceLoader
  });
  registry.install(Subagent);
  const pendingReports = [];
  const report = (error) => pendingReports.push(error);
  const executeToolFn = createNestedToolExecutor(registry);
  const cleanup = await mountExtensionBridge(
    location,
    modelRuntime,
    extensionsResult,
    registry,
    executeToolFn,
    report
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(location.database),
    { models: modelRuntime, registry, settings, env: envs.env, onReport: report },
    runtimeContext
  );
  const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime, options.cli) : void 0;
  if (initial?.model) activeModelRef = initial.model;
  return {
    modelRuntime,
    settingsManager,
    harness,
    initialModelRef: initial?.model,
    fallbackMessage: initial?.fallbackMessage,
    pendingReports,
    getActiveModel,
    setActiveModelRef: (ref) => {
      activeModelRef = ref;
    },
    cleanup
  };
}

// src/runner/runtime.ts
async function loadSummaries(harness, rootId) {
  const label = (id) => id === rootId ? "main" : `subagent ${id}`;
  const summaries = [];
  let cursor;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
    for (const { id } of page.items) summaries.push({ id, label: label(id), ...await firstInput(harness, id) });
    cursor = page.next;
  } while (cursor !== void 0);
  return summaries;
}
async function openDurable(options = {}) {
  const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
  const envs = new ExecutionEnvs(location.cwd);
  let harness;
  try {
    const envState2 = await loadHarnessEnvironment(location, options, envs);
    const { modelRuntime, settingsManager } = envState2;
    harness = envState2.harness;
    const root = await harness.root(runtimeContext, {
      agent: { cwd: location.cwd, ...envState2.initialModelRef ? { model: envState2.initialModelRef } : {} }
    });
    if (!location.created) {
      const rootAgent = await root.agent(runtimeContext);
      if (rootAgent.model) envState2.setActiveModelRef(rootAgent.model);
      if (options.cli !== void 0) {
        const cli = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
        if (cli.model) {
          envState2.setActiveModelRef(cli.model);
          await root.configure({ model: cli.model, thinkingLevel: cli.thinkingLevel }, runtimeContext);
        }
      }
    }
    const summaries = await loadSummaries(harness, root.id);
    let current = root;
    let conversation = await root.viewState(runtimeContext);
    const enabled = settingsManager.getEnabledModels();
    const scoped = enabled?.length ? await resolveModelScopeWithDiagnostics2(enabled, modelRuntime) : void 0;
    const scopedList = scoped?.scopedModels?.length ? scoped.scopedModels.map((sm) => sm.model) : modelRuntime.getAvailableSnapshot();
    const models = () => scopedList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, contextWindow: m.contextWindow }));
    let state = {
      session: { id: location.id, directory: location.directory, cwd: location.cwd },
      conversation: conversation.value,
      conversations: summaries,
      models: models(),
      notices: []
    };
    const listeners = /* @__PURE__ */ new Set();
    let notifying = false;
    const update = (patch) => {
      state = { ...state, ...patch };
      if (notifying) return;
      notifying = true;
      setImmediate(() => {
        notifying = false;
        for (const listener of listeners) listener();
      });
    };
    let nextNotice = 1;
    const notice = (level, message) => {
      update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
    };
    const fail = (err) => notice("error", err instanceof Error ? err.message : String(err));
    for (const err of envState2.pendingReports) notice("warning", err instanceof Error ? err.message : String(err));
    let unsubscribeConversation = conversation.subscribe((val) => update({ conversation: val }));
    const unsubscribeCommits = harness.subscribeCommits((pub) => {
      let convs = state.conversations;
      for (const ch of pub.changes) {
        if (ch.type === "conversation") {
          convs = [...convs, { id: ch.value.id, label: ch.value.id === root.id ? "main" : `subagent ${ch.value.id}` }];
        } else if (ch.type === "entry" && ch.value.kind === "pi.user") {
          const id = ch.value.conversationId;
          convs = convs.map((s) => s.id === id && !s.title ? { ...s, ...titleOf(ch.value) } : s);
        }
      }
      if (convs !== state.conversations) update({ conversations: convs });
    });
    let tasks;
    let unsubscribeTasks = () => {
    };
    const closeTasks = () => {
      unsubscribeTasks();
      tasks?.dispose();
      tasks = void 0;
    };
    const opened = harness;
    const controller = createDurableController({
      getCurrent: () => current,
      setCurrent: (c) => {
        current = c;
      },
      getConversationState: () => conversation,
      setConversationState: (cs) => {
        conversation = cs;
      },
      getUnsubscribeConversation: () => unsubscribeConversation,
      setUnsubscribeConversation: (fn) => {
        unsubscribeConversation = fn;
      },
      opened,
      modelRuntime,
      getState: () => state,
      update,
      notice,
      fail,
      getTasks: () => tasks,
      setTasks: (t) => {
        tasks = t;
      },
      setUnsubscribeTasks: (fn) => {
        unsubscribeTasks = fn;
      },
      closeTasks,
      setActiveModelRef: (ref) => envState2.setActiveModelRef(ref)
    });
    const saved = agentOf(state.conversation).model;
    if (!saved) notice("warning", "No model configured; select one with /model.");
    else if (!modelRuntime.getModel(saved.provider, saved.modelId)) {
      notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
    }
    if (envState2.fallbackMessage) notice("info", envState2.fallbackMessage);
    await controller.toggleTasks();
    harness.resume();
    let closing;
    return {
      view: {
        current: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      },
      controller,
      settings: settingsManager,
      modelRuntime,
      harness,
      close() {
        return closing ??= (async () => {
          unsubscribeConversation();
          unsubscribeCommits();
          conversation.dispose();
          closeTasks();
          try {
            await opened.close(runtimeContext);
            await envs.cleanup(runtimeContext);
            await envState2.cleanup?.();
          } finally {
            await location.release();
          }
        })();
      }
    };
  } catch (error) {
    await envState?.cleanup?.().catch((err) => console.warn("[DurableRuntime] Cleanup extension runner:", err));
    await harness?.close(runtimeContext).catch((err) => console.warn("[DurableRuntime] Cleanup harness:", err));
    await location.release().catch((err) => console.warn("[DurableRuntime] Cleanup location:", err));
    throw error;
  }
}

// src/runner/index.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID3, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";

// src/runner/bridge/contracts.ts
function isAgentDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isUsageDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isConversationEntryRecord(entry) {
  return typeof entry === "object" && entry !== null;
}

// src/runner/bridge/assistant-message-builder.ts
function buildFinalAssistantMessage(current, lastGenerationText, lastThinkingText) {
  const entries = current.conversation.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find(
    (e) => isConversationEntryRecord(e) && e.kind === "pi.assistant"
  );
  const lastAssistantMsg = lastAssistantEntry?.model?.[0];
  if (lastAssistantMsg) {
    const content = Array.isArray(lastAssistantMsg.content) ? lastAssistantMsg.content : [{ type: "text", text: lastGenerationText }];
    const stopReason = typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : "stop";
    const usage = typeof lastAssistantMsg.usage === "object" && lastAssistantMsg.usage !== null ? lastAssistantMsg.usage : void 0;
    return {
      role: "assistant",
      content,
      stopReason,
      usage
    };
  }
  const finalContent = [];
  if (lastThinkingText) {
    finalContent.push({ type: "thinking", thinking: lastThinkingText });
  }
  if (lastGenerationText) {
    finalContent.push({ type: "text", text: lastGenerationText });
  }
  const rawUsageDoc = current.conversation.docs["pi.usage"];
  const usageDoc = isUsageDocument(rawUsageDoc) ? rawUsageDoc : {};
  return {
    role: "assistant",
    content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
    stopReason: "stop",
    usage: {
      input: usageDoc.input,
      output: usageDoc.output,
      cacheRead: usageDoc.cacheRead,
      cacheWrite: usageDoc.cacheWrite,
      totalTokens: usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0),
      cost: usageDoc.cost
    }
  };
}

// src/runner/bridge/bb-event-adapter.ts
function extractToolResult(modelItem) {
  const msg = typeof modelItem === "object" && modelItem !== null ? modelItem : void 0;
  const isError = msg?.isError ?? false;
  let result = "";
  if (Array.isArray(msg?.content)) {
    result = msg.content.map((b) => typeof b === "object" && b !== null && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
  } else if (typeof msg?.content === "string") {
    result = msg.content;
  }
  return { result, isError };
}
var BBEventAdapter = class {
  output;
  resolveContextWindow;
  lastAssistantMessage;
  currentText = "";
  currentThinking = "";
  constructor(output2, resolveContextWindow) {
    this.output = output2;
    this.resolveContextWindow = resolveContextWindow;
  }
  handleEvent(event, current) {
    switch (event.type) {
      case "run_start": {
        this.currentText = "";
        this.currentThinking = "";
        this.lastAssistantMessage = void 0;
        this.output({ type: "agent_start" });
        break;
      }
      case "turn_start": {
        this.output({ type: "turn_start" });
        break;
      }
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "thinking_delta") {
            this.currentThinking += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta }
            });
          } else if (change.type === "text_delta") {
            this.currentText += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta }
            });
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.output({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {}
        });
        break;
      }
      case "tool_execution_update": {
        let partialResult = "";
        if (event.output) {
          if ("set" in event.output) partialResult = event.output.set;
          else if ("append" in event.output) partialResult = event.output.append ?? "";
        }
        if (partialResult) {
          this.output({
            type: "tool_execution_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult
          });
        }
        break;
      }
      case "tool_execution_end": {
        const { result, isError } = extractToolResult(event.entry?.model?.[0]);
        this.output({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result,
          isError
        });
        break;
      }
      case "message_end": {
        const modelItem = event.entry?.model?.[0];
        const msg = typeof modelItem === "object" && modelItem !== null ? modelItem : void 0;
        if (msg?.role === "assistant") {
          this.lastAssistantMessage = {
            role: "assistant",
            content: msg.content ?? [{ type: "text", text: this.currentText }],
            stopReason: msg.stopReason ?? "stop",
            usage: msg.usage
          };
          this.output({ type: "message_end", message: this.lastAssistantMessage });
        }
        break;
      }
      case "compaction_start": {
        this.output({
          type: "compaction_start",
          reason: event.reason === "threshold" ? "threshold" : "manual"
        });
        break;
      }
      case "compaction_end": {
        this.output({
          type: "compaction_end",
          reason: event.reason === "threshold" ? "threshold" : "manual",
          aborted: false
        });
        break;
      }
      case "turn_end": {
        const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
          current,
          this.currentText,
          this.currentThinking
        );
        const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
        const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
        const cw = this.resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
        this.output({ type: "turn_end", message: finalMsg, contextWindow: cw });
        break;
      }
      case "run_end": {
        const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
          current,
          this.currentText,
          this.currentThinking
        );
        const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
        const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
        const cw = this.resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
        this.output({ type: "agent_end", messages: [finalMsg], contextWindow: cw });
        break;
      }
    }
  }
};

// src/runner/cli-args.ts
function parseCliArgs(argv2) {
  const args2 = {};
  for (let i = 0; i < argv2.length; i++) {
    const arg = argv2[i];
    if (arg === "--mode" && i + 1 < argv2.length) args2.mode = argv2[++i];
    else if (arg === "--session" && i + 1 < argv2.length) args2.session = argv2[++i];
    else if (arg === "--session-dir" && i + 1 < argv2.length) args2.sessionDir = argv2[++i];
    else if (arg === "--continue") args2.continueSession = true;
    else if (arg === "--no-session") args2.noSession = true;
    else if (arg === "--provider" && i + 1 < argv2.length) args2.provider = argv2[++i];
    else if (arg === "--model" && i + 1 < argv2.length) args2.model = argv2[++i];
    else if (arg === "--thinking" && i + 1 < argv2.length) args2.thinking = argv2[++i];
    else if (arg === "--system-prompt" && i + 1 < argv2.length) args2.systemPromptPath = argv2[++i];
    else if (arg === "--append-system-prompt" && i + 1 < argv2.length) args2.appendSystemPromptPath = argv2[++i];
    else if (arg === "--cwd" && i + 1 < argv2.length) args2.cwd = argv2[++i];
    else if (arg === "--extension" && i + 1 < argv2.length) args2.extension = argv2[++i];
    else if (arg.startsWith("-")) {
      if (i + 1 < argv2.length && !argv2[i + 1].startsWith("-")) {
        i++;
      }
    } else if (!args2.cwd) {
      args2.cwd = arg;
    }
  }
  return args2;
}

// src/runner/session-commands.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2 } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
async function handleActiveSessionCommand(cmd, durable, modelRuntime, args2, respond) {
  switch (cmd.type) {
    case "prompt": {
      if (!cmd.message) {
        respond.error(cmd.id, "prompt", "Missing message");
        return;
      }
      respond.success(cmd.id, "prompt");
      const behavior = cmd.streamingBehavior || "followUp";
      await durable.controller.submit(cmd.message, behavior);
      break;
    }
    case "steer": {
      if (!cmd.message) {
        respond.error(cmd.id, "steer", "Missing message");
        return;
      }
      respond.success(cmd.id, "steer");
      await durable.controller.submit(cmd.message, "steer");
      break;
    }
    case "abort": {
      await durable.controller.abort();
      respond.success(cmd.id, "abort");
      break;
    }
    case "compact": {
      await durable.controller.compact(cmd.instructions);
      respond.success(cmd.id, "compact");
      break;
    }
    case "get_state": {
      const current = durable.view.current();
      const agentDoc = current.conversation.docs["pi.agent"] ?? {};
      const modelObj = agentDoc.model ? {
        provider: agentDoc.model.provider,
        id: agentDoc.model.id ?? agentDoc.model.modelId,
        modelId: agentDoc.model.modelId ?? agentDoc.model.id
      } : null;
      respond.success(cmd.id, "get_state", {
        model: modelObj,
        thinkingLevel: agentDoc.thinkingLevel ?? "none",
        cwd: args2.cwd ?? process.cwd(),
        sessionId: args2.session ?? "default"
      });
      break;
    }
    case "get_available_models": {
      const currentModels = modelRuntime.getAvailableSnapshot();
      respond.success(cmd.id, "get_available_models", { models: currentModels });
      break;
    }
    case "set_model": {
      if (!cmd.provider || !cmd.modelId) {
        respond.error(cmd.id, "set_model", "Missing provider or modelId");
        return;
      }
      await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
      respond.success(cmd.id, "set_model");
      break;
    }
    case "set_thinking_level": {
      await durable.controller.setThinkingLevel(cmd.level);
      respond.success(cmd.id, "set_thinking_level");
      break;
    }
    case "get_session_stats": {
      const current = durable.view.current();
      const agentDoc = current.conversation.docs["pi.agent"] ?? {};
      let contextWindow = 128e3;
      const provider = agentDoc.model?.provider ?? args2.provider;
      const modelId = agentDoc.model?.modelId ?? args2.model;
      if (provider && modelId) {
        const m = modelRuntime.getModel(provider, modelId);
        if (m?.contextWindow) contextWindow = m.contextWindow;
      }
      let tokens = null;
      try {
        const conv = await durable.harness.conversation(ROOT_CONVERSATION_ID2, BACKGROUND_CONTEXT2);
        if (conv) {
          const ctxView = await conv.context(BACKGROUND_CONTEXT2);
          const estimate = estimateContextTokens(ctxView.messages);
          tokens = estimate.tokens;
        }
      } catch (err) {
        console.error(`Error estimating context tokens: ${err}`);
      }
      respond.success(cmd.id, "get_session_stats", {
        contextUsage: {
          tokens,
          contextWindow
        }
      });
      break;
    }
    default: {
      respond.error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
      break;
    }
  }
}

// src/runner/version.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
function getPiDurableVersion() {
  try {
    const durablePkg = __require.resolve("@earendil-works/pi-durable/package.json");
    if (existsSync2(durablePkg)) {
      const parsed = JSON.parse(readFileSync2(durablePkg, "utf8"));
      if (parsed.version) return parsed.version;
    }
  } catch {
  }
  try {
    const pluginPkg = join2(__dirname, "..", "..", "package.json");
    if (existsSync2(pluginPkg)) {
      const parsed = JSON.parse(readFileSync2(pluginPkg, "utf8"));
      const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
      if (dep) return dep;
    }
  } catch {
  }
  return "1.0.0";
}

// src/runner/bridge-channel.ts
import { Socket } from "node:net";
import { writeSync } from "node:fs";
var CHILD_TO_BRIDGE_FD = 3;
var BRIDGE_TO_CHILD_FD = 4;
function createBridgeSender() {
  return (msg) => {
    const str = `${JSON.stringify(msg)}
`;
    try {
      writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
    } catch {
    }
  };
}
function initBridgeInboundChannel(modelScope, sendToBridge2) {
  try {
    const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
    bridgeIn.on("error", () => {
    });
    bridgeIn.unref();
    attachJsonlLineReader(bridgeIn, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        if (req.kind === "request") {
          if (req.method === "model-scope") {
            sendToBridge2({ kind: "reply", id: req.id, result: modelScope });
          } else if (req.method === "refresh-models") {
            sendToBridge2({ kind: "reply", id: req.id, result: { refreshed: true } });
          } else if (req.method === "leaf") {
            sendToBridge2({ kind: "reply", id: req.id, result: { leafId: null } });
          } else {
            sendToBridge2({ kind: "reply", id: req.id, result: {} });
          }
        }
      } catch (err) {
        console.error("[Runner] Failed to parse or process bridge channel message:", err);
      }
    });
  } catch {
  }
}

// src/runner/index.ts
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(getPiDurableVersion());
  process.exit(0);
}
var args = parseCliArgs(argv);
function output(data) {
  process.stdout.write(serializeJsonLine(data));
}
var sendToBridge = createBridgeSender();
async function main() {
  let activeDurable = null;
  let isTerminating = false;
  const handleExit = async (signalOrReason) => {
    if (isTerminating) return;
    isTerminating = true;
    if (activeDurable) {
      try {
        await activeDurable.close();
      } catch (err) {
        console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void handleExit("SIGTERM");
  });
  process.on("SIGINT", () => {
    void handleExit("SIGINT");
  });
  process.stdin.on("end", () => {
    void handleExit("stdin.end");
  });
  const cwd = args.cwd ?? process.cwd();
  const {
    modelRuntime,
    scopedModelList,
    defaultModel,
    defaultThinkingLevel,
    modelScope
  } = await setupRunnerModels(cwd, args);
  sendToBridge({ kind: "model-scope", ...modelScope });
  initBridgeInboundChannel(modelScope, sendToBridge);
  const success = (id, command, data) => {
    output({ id, type: "response", command, success: true, data });
  };
  const error = (id, command, message) => {
    output({ id, type: "response", command, success: false, error: message });
  };
  if (args.noSession) {
    sendToBridge({ ready: true, kind: "ready" });
    attachJsonlLineReader(process.stdin, (line) => {
      if (!line.trim()) return;
      try {
        const cmd = JSON.parse(line);
        if (cmd.type === "get_available_models") {
          success(cmd.id, "get_available_models", { models: scopedModelList });
        } else if (cmd.type === "get_state") {
          success(cmd.id, "get_state", {
            model: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id, modelId: defaultModel.id } : null,
            thinkingLevel: defaultThinkingLevel,
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionId: "catalog",
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0
          });
        } else {
          success(cmd.id, cmd.type, {});
        }
      } catch (err) {
        error(void 0, "unknown", err instanceof Error ? err.message : String(err));
      }
    });
    return;
  }
  const durableOptions = {
    cwd: args.cwd,
    continueSession: args.continueSession,
    session: args.session,
    cli: args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : void 0,
    prompt: {
      systemPromptPath: args.systemPromptPath,
      appendSystemPromptPath: args.appendSystemPromptPath
    }
  };
  const durable = await openDurable(durableOptions);
  activeDurable = durable;
  const adapter = new BBEventAdapter(
    (evt) => output(evt),
    (provider, modelId) => {
      const p = provider ?? args.provider;
      const m = modelId ?? args.model;
      return p && m ? modelRuntime.getModel(p, m)?.contextWindow : void 0;
    }
  );
  const stream = await watchEvents(durable.harness, ROOT_CONVERSATION_ID3, BACKGROUND_CONTEXT3);
  stream.start(async (batch) => {
    try {
      for (const event of batch) {
        adapter.handleEvent(event, durable.view.current());
      }
    } catch (err) {
      console.error(`Adapter stream error: ${err}`);
    }
  });
  attachJsonlLineReader(process.stdin, async (line) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      error(void 0, "parse", `Invalid JSON: ${e}`);
      return;
    }
    try {
      await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
    } catch (err) {
      error(cmd.id, cmd.type, err instanceof Error ? err.message : String(err));
    }
  });
  sendToBridge({ ready: true, kind: "ready" });
}
main().catch((err) => {
  console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
//# sourceMappingURL=index.js.map
