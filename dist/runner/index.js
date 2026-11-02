import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/runner/runtime.ts
import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";

// src/runner/harness-setup.ts
import {
  createRegistry
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
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
var DynamicPromptSections = class {
  sections = {};
  revision = 0;
  getSections() {
    return { ...this.sections };
  }
  updateSections(sections) {
    this.sections = { ...sections };
    this.revision++;
  }
  getRevision() {
    return this.revision;
  }
};
var CANONICAL_TOOL_DEFS = {
  read: createReadToolDefinition(process.cwd()),
  write: createWriteToolDefinition(process.cwd()),
  edit: createEditToolDefinition(process.cwd()),
  bash: createBashToolDefinition(process.cwd()),
  codemode: {
    promptSnippet: "Run JavaScript in a sandbox to call other tools. Use it to batch, chain, or loop tool calls without roundtrips.",
    promptGuidelines: [
      "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."
    ]
  },
  tool_search: {
    promptSnippet: "Search for deferred tools by keyword or concept and load matching tools for subsequent calls.",
    promptGuidelines: ["Use tool_search to discover and activate deferred tools before calling them."]
  },
  subagent: {
    promptSnippet: "Delegate a self-contained task to an async subagent. Uses the configured runtime subagent model policy (inherits parent model or uses provider-configured model). Runs in the background by default without blocking the conversation.",
    promptGuidelines: [
      "Use subagent to run background tasks asynchronously, or with background: false for immediate synchronous results."
    ]
  }
};
var KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd", "mcp_servers", "dynamic_sections"];
function resolveContextFiles(options) {
  return options.contextFiles && options.contextFiles.length > 0 ? options.contextFiles : options.resourceLoader?.getAgentsFiles?.()?.agentsFiles ?? [];
}
function resolveSkills(options) {
  return options.resourceLoader?.getSkills?.()?.skills ?? [];
}
function buildRules(tools) {
  const rules = [];
  const seen = /* @__PURE__ */ new Set();
  const addRule = (rule) => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };
  if (tools.some((t) => t.name === "bash")) {
    addRule("Use bash for file operations like ls, rg, find");
  }
  for (const tool of tools) {
    const def = CANONICAL_TOOL_DEFS[tool.name];
    if (def?.promptGuidelines) {
      for (const guideline of def.promptGuidelines) addRule(guideline);
    }
    if (tool.promptGuidelines) {
      for (const guideline of tool.promptGuidelines) addRule(guideline);
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
    const tools = input.agent.tools ?? [];
    const sections = {};
    if (systemPromptOverride) {
      sections.preamble = systemPromptOverride;
    } else {
      sections.preamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
      const visibleTools = tools.flatMap((t) => {
        const def = CANONICAL_TOOL_DEFS[t.name];
        const snippet = def?.promptSnippet ?? t.promptSnippet;
        return snippet ? [`- ${t.name}: ${snippet}`] : [];
      });
      const toolsText = visibleTools.length > 0 ? visibleTools.join("\n") : "(none)";
      sections.tools = `<tools>
${toolsText}

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>`;
      sections.rules = `<rules>
${buildRules(tools)}
</rules>`;
    }
    if (appendPrompt) sections.addendum = `<addendum>
${appendPrompt}
</addendum>`;
    if (contextFiles.length > 0) {
      const rendered = contextFiles.map((cf) => `<project_instructions path="${cf.path}">
${cf.content}
</project_instructions>`).join("\n\n");
      sections.project_context = `<project_context>
Project-specific instructions and guidelines:

${rendered}
</project_context>`;
    }
    if (skills.length > 0) sections.skills = `<skills>
${formatSkillsForPrompt(skills, "read")}
</skills>`;
    sections.cwd = `<cwd>
${cwd.replace(/\\/g, "/")}
</cwd>`;
    if (options.dynamicSections) {
      const extra = options.dynamicSections.getSections();
      if (extra.mcp_servers?.trim()) sections.mcp_servers = `<mcp_servers>
${extra.mcp_servers}
</mcp_servers>`;
      const otherEntries = Object.entries(extra).filter(([k, text]) => k !== "mcp_servers" && Boolean(text?.trim()));
      if (otherEntries.length > 0) {
        sections.dynamic_sections = otherEntries.map(([name, text]) => `<${name}>
${text}
</${name}>`).join("\n\n");
      }
    }
    return sections;
  };
  const built = /* @__PURE__ */ new WeakMap();
  const getOrBuild = (input) => {
    const currentRev = options.dynamicSections?.getRevision?.() ?? 0;
    const cached = built.get(input);
    if (cached === void 0 || cached.revision !== currentRev) {
      const sections = buildSections(input);
      built.set(input, { revision: currentRev, sections });
      return sections;
    }
    return cached.sections;
  };
  return defineExtension({
    name: "pi-prompt",
    sections: KEYS.map((key) => section(key, (input) => getOrBuild(input)[key], { tag: false }))
  });
}

// src/shared/errors.ts
var DurableHarnessError = class extends Error {
  code;
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
  }
};
var DurableStorageError = class extends DurableHarnessError {
  constructor(message, cause, code = "STORAGE_ERROR") {
    super(message, code, cause);
  }
};
var DurableCommandError = class extends DurableHarnessError {
  constructor(message, cause, code = "COMMAND_ERROR") {
    super(message, code, cause);
  }
};
var InvalidCommandPayloadError = class extends DurableCommandError {
  command;
  constructor(command, message, cause) {
    super(message ?? `Invalid payload for command: ${command}`, cause, "INVALID_COMMAND_PAYLOAD");
    this.command = command;
  }
};
var DurablePluginError = class extends DurableHarnessError {
  pluginId;
  constructor(pluginId, message, cause) {
    super(message ?? `Plugin failure: ${pluginId}`, "PLUGIN_ERROR", cause);
    this.pluginId = pluginId;
  }
};

// src/runner/plugins/registry.ts
var DurablePluginRegistry = class {
  #plugins = /* @__PURE__ */ new Map();
  register(plugin) {
    if (this.#plugins.has(plugin.id)) {
      throw new DurablePluginError(
        plugin.id,
        `Plugin with id '${plugin.id}' is already registered`
      );
    }
    this.#plugins.set(plugin.id, plugin);
  }
  get(id) {
    return this.#plugins.get(id);
  }
  list(category) {
    const all = Array.from(this.#plugins.values());
    if (!category) return all;
    return all.filter((p) => p.category === category);
  }
  async initAll(ctx) {
    for (const plugin of this.#plugins.values()) {
      try {
        await plugin.register(ctx);
      } catch (err) {
        if (err instanceof DurablePluginError) {
          throw err;
        }
        throw new DurablePluginError(
          plugin.id,
          `Failed to initialize plugin '${plugin.id}': ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }
    }
  }
  async teardownAll() {
    const plugins = Array.from(this.#plugins.values()).reverse();
    for (const plugin of plugins) {
      if (typeof plugin.teardown === "function") {
        try {
          await plugin.teardown();
        } catch {
        }
      }
    }
  }
};

// src/runner/plugins/built-in/coding-tools.ts
import { createCodingTools, CodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
var codingToolsPlugin = {
  id: "coding-tools",
  name: "Coding Tools",
  category: "built-in",
  version: "1.0.0",
  async register(ctx) {
    if (!ctx.registry) return;
    let tools = CodingTools;
    try {
      const images = await createNodePhotonImages();
      tools = createCodingTools({ images });
    } catch {
    }
    ctx.registry.install(tools);
  }
};

// src/runner/plugins/built-in/codemode.ts
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
var activeSandbox;
var codemodePlugin = {
  id: "codemode",
  name: "Codemode",
  category: "built-in",
  version: "1.0.0",
  register(ctx) {
    if (!ctx.registry) return;
    activeSandbox = new CodemodeSandbox();
    const ext = createCodemodeExtension({
      sandbox: activeSandbox,
      get namespaces() {
        return ctx.dynamicNamespaces?.getNamespaces?.() ?? [];
      }
    });
    ctx.registry.install(ext);
  },
  async teardown() {
    if (activeSandbox) {
      const sb = activeSandbox;
      if (typeof sb.close === "function") {
        await sb.close();
      } else if (typeof sb.dispose === "function") {
        await sb.dispose();
      }
      activeSandbox = void 0;
    }
  }
};

// src/runner/subagent.ts
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension as defineExtension2,
  defineTool
} from "@earendil-works/pi-durable";

// src/runner/subagent-docs.ts
import {
  AssistantEntry,
  defineDoc
} from "@earendil-works/pi-durable";
var SubagentsDoc = defineDoc({
  kind: "durable.subagents",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {} })
});
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function extractAssistantText(entry) {
  if (!isRecord(entry) || !Array.isArray(entry.model) || entry.model.length === 0) return "";
  const firstMessage = entry.model[0];
  if (!isRecord(firstMessage) || !Array.isArray(firstMessage.content)) return "";
  return firstMessage.content.flatMap((p) => isRecord(p) && p.type === "text" && typeof p.text === "string" ? [p.text] : []).join("");
}
async function answerText(api, answer, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  return extractAssistantText(entry);
}

// src/runner/subagent-delivery.ts
import {
  AssistantEntry as AssistantEntry2,
  defineTask as defineTask2
} from "@earendil-works/pi-durable";

// src/runner/subagent-courier.ts
import { defineTask } from "@earendil-works/pi-durable";
var GATHER_MS = 50;
var DEFAULT_HOLD_TIMEOUT_MS = 5e3;
function courierIsIdle(active) {
  return active === void 0 || active.state.status === "terminal";
}
function asExtensionTask(task, extensionName) {
  return Object.assign(task, { name: extensionName, tasks: [task] });
}
function courierFor(admit, holdTimeoutMs = DEFAULT_HOLD_TIMEOUT_MS) {
  const task = defineTask({
    name: "durable.subagent-courier",
    version: 1,
    initial: () => ({ phase: "gather" }),
    phases: {
      gather: (_task, runtime, context) => runtime.sleepUntil(runtime.now() + GATHER_MS, { phase: "next" }, context),
      next: async (task2, runtime, context) => runtime.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc, runtime.conversationId);
        if (state.deliveryHold !== void 0) return { status: "running", checkpoint: { phase: "hold" } };
        if (state.sending === void 0) {
          const reports = state.outbox ?? [];
          if (reports.length === 0) {
            if (state.courier === task2.id) delete state.courier;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          const batch = (state.batchNumber ?? 0) + 1;
          state.batchNumber = batch;
          state.outbox = [];
          state.sending = { requestId: `subagent-batch:${task2.id}:${batch}`, reports };
        } else {
          const attempt = (state.sending.attempt ?? 0) + 1;
          state.sending.attempt = attempt;
          const batch = state.batchNumber ?? 1;
          state.sending.requestId = `subagent-batch:${task2.id}:${batch}:r${attempt}`;
        }
        return { status: "running", checkpoint: { phase: "send" } };
      }, context),
      send: async (_task, runtime, context) => {
        const state = await runtime.snapshot(SubagentsDoc, runtime.conversationId, context);
        const sending = state?.sending;
        if (sending === void 0) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
          return;
        }
        const parent = await runtime.conversation(runtime.conversationId, context);
        try {
          await admit?.(parent, sending.requestId, context);
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          await runtime.commit(async (tx) => {
            const current = await tx.doc(SubagentsDoc, runtime.conversationId);
            if (current.sending?.requestId === sending.requestId) {
              current.deliveryHold = { kind: "admission", requestId: sending.requestId, reason };
            }
            return { status: "running", checkpoint: { phase: "hold" } };
          }, context);
          return;
        }
        const prompt = sending.reports.map((r) => r.text).join("\n\n---\n\n");
        const content = `[Subagent Reports Available]:

${prompt}`;
        const submission = await parent.submit({ type: "input", content, whenBusy: "followUp", requestId: sending.requestId }, context);
        const settled = await submission.wait(context);
        return runtime.commit(async (tx) => {
          const current = await tx.doc(SubagentsDoc, runtime.conversationId);
          if (current.sending?.requestId !== sending.requestId) return { status: "running", checkpoint: { phase: "next" } };
          if (settled.status === "done") delete current.sending;
          else current.deliveryHold = { kind: "uncertain", requestId: sending.requestId, reason: `Delivery outcome uncertain: ${settled.status}` };
          return { status: "running", checkpoint: { phase: settled.status === "done" ? "next" : "hold" } };
        }, context);
      },
      hold: async (_task, runtime, context) => {
        const watch2 = await runtime.watchDoc(SubagentsDoc, runtime.conversationId, context);
        if (watch2 === void 0 || watch2.value?.deliveryHold === void 0) {
          await watch2?.stop();
          return runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
        }
        try {
          await new Promise((resolve3) => {
            const timer = setTimeout(() => resolve3(), holdTimeoutMs);
            timer.unref?.();
            watch2.start((v) => {
              if (v?.deliveryHold === void 0) {
                clearTimeout(timer);
                resolve3();
              }
              return Promise.resolve();
            });
            void watch2.closed.then(() => {
              clearTimeout(timer);
              resolve3();
            });
          });
        } finally {
          await watch2.stop();
        }
        return runtime.commit(async (tx) => {
          const current = await tx.doc(SubagentsDoc, runtime.conversationId);
          delete current.deliveryHold;
          return { status: "running", checkpoint: { phase: "next" } };
        }, context);
      }
    },
    abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx)
  });
  return asExtensionTask(task, "durable.subagent-courier");
}

// src/runner/subagent-delivery.ts
var BACKGROUND = { ownership: { kind: "conversation" }, background: true };
var Anchor = asExtensionTask(
  defineTask2({
    name: "durable.subagent-anchor",
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: { done: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx) },
    abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx)
  }),
  "durable.subagent-anchor"
);
function reporterFor(courier, admit) {
  const task = defineTask2({
    name: "durable.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task2, runtime, context) => {
        const child = await runtime.conversation(task2.input.conversationId, context);
        await admit?.(child, task2.input.requestId, context);
        const submission = await child.submit({ type: "input", content: task2.input.task, requestId: task2.input.requestId }, context);
        const settled = await submission.wait(context);
        return runtime.commit(async (tx) => {
          const doc = await tx.doc(SubagentsDoc, runtime.conversationId);
          doc.agents ??= {};
          const record = doc.agents[task2.input.key] ?? {
            name: task2.input.task.trim(),
            conversationId: task2.input.conversationId,
            requestId: task2.input.requestId,
            task: task2.input.task,
            role: "worker",
            ownerTaskId: task2.id,
            background: true
          };
          doc.agents[task2.input.key] = record;
          let text = `Subagent ${record.name} failed: ${settled.status}`;
          if (settled.status === "unanswered") text += ` (${settled.reason ?? "unknown"})`;
          if (settled.status === "done" && settled.type === "input") {
            text = `Subagent ${record.name} answered: ` + extractAssistantText(await tx.entry(AssistantEntry2, settled.answer));
          }
          record.report = text;
          record.settled = true;
          return { status: "running", checkpoint: { phase: "report", text } };
        }, context);
      },
      report: async (task2, runtime, context) => runtime.commit(async (tx) => {
        const state = await tx.doc(SubagentsDoc, runtime.conversationId);
        const reportId = String(task2.id);
        if (!(state.outbox ?? []).some((report) => report.id === reportId)) {
          const name = state.agents[task2.input.key]?.name ?? task2.input.key;
          state.outbox = [...state.outbox ?? [], { id: reportId, name, text: task2.state.checkpoint.text }];
        }
        const active = state.courier === void 0 ? void 0 : await tx.task(state.courier);
        if (courierIsIdle(active)) state.courier = await tx.createTask(courier, null, BACKGROUND);
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context)
    },
    abort: (_t, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx)
  });
  return asExtensionTask(task, "durable.subagent-reporter");
}
var DefaultCourier = courierFor();
var DefaultReporter = reporterFor(DefaultCourier);

// src/runner/subagent-role.ts
function buildTechnicalWorkerRole() {
  return [
    "You are an isolated worker subagent.",
    "Your goal is to solve the delegated task using your available tools.",
    "Execute the assigned task thoroughly, verify your findings, and return your final answer concisely."
  ].join("\n");
}

// src/policy/resolver.ts
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

// src/shared/model-ref.ts
function normalizeModelReference(raw, defaultProvider) {
  if (!raw || typeof raw !== "object") return void 0;
  const r = raw;
  const provider = typeof r.provider === "string" && r.provider.trim() ? r.provider.trim() : defaultProvider?.trim();
  const rawId = typeof r.modelId === "string" && r.modelId.trim() ? r.modelId.trim() : typeof r.id === "string" && r.id.trim() ? r.id.trim() : void 0;
  if (!provider || !rawId) return void 0;
  const prefix = `${provider}/`;
  const cleanModelId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId;
  return { provider, modelId: cleanModelId };
}

// src/policy/errors.ts
var SubagentPolicyError = class extends Error {
  cause;
  constructor(message, options) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
  }
};
var SubagentPolicyInvalidError = class extends SubagentPolicyError {
  code = "SUBAGENT_POLICY_INVALID";
  constructor(message, options) {
    super(message, options);
  }
};
var SubagentModelUnavailableError = class extends SubagentPolicyError {
  code = "SUBAGENT_MODEL_UNAVAILABLE";
  constructor(message, options) {
    super(message, options);
  }
};
var SubagentPolicyLoadError = class extends SubagentPolicyError {
  code = "SUBAGENT_POLICY_LOAD_ERROR";
  constructor(message, options) {
    super(message, options);
  }
};
var SubagentRevisionConflictError = class extends SubagentPolicyError {
  code = "REVISION_CONFLICT";
  constructor(message, options) {
    super(message, options);
  }
};

// src/policy/resolver.ts
function mapBbReasoningToNativeThinking(level) {
  if (level === "none" || level === void 0) {
    return "off";
  }
  return level;
}
function resolveSubagentModelConfiguration(record, parentContext, availableModels) {
  if (record.policy.mode === "inherit") {
    const parentModel = normalizeModelReference(parentContext.model);
    if (!parentModel) {
      throw new SubagentPolicyInvalidError(
        "Parent model is required for inherit mode"
      );
    }
    return {
      model: {
        provider: parentModel.provider,
        modelId: parentModel.modelId
      },
      thinkingLevel: mapBbReasoningToNativeThinking(parentContext.thinkingLevel),
      source: "parent_inherited",
      policyRevision: record.revision
    };
  }
  const targetProfile = record.policy.configuredProfile;
  const targetModel = normalizeModelReference(targetProfile.model);
  const foundModel = targetModel ? availableModels.find((m) => {
    const availableNorm = normalizeModelReference(m, m.provider);
    return availableNorm && availableNorm.provider === targetModel.provider && availableNorm.modelId === targetModel.modelId;
  }) : void 0;
  if (!foundModel || !targetModel) {
    throw new SubagentModelUnavailableError(
      `Configured subagent model "${targetProfile.model.provider}/${targetProfile.model.modelId}" is unavailable or unauthenticated. Update the subagent model in Settings \u2192 Installed plugins \u2192 Pi Durable \u2192 Subagents.`
    );
  }
  const supportedLevels = getSupportedThinkingLevels(foundModel);
  if (!supportedLevels.includes(targetProfile.thinkingLevel)) {
    throw new SubagentPolicyInvalidError(
      `Thinking level "${targetProfile.thinkingLevel}" is not supported by model "${targetModel.provider}/${targetModel.modelId}". Supported levels: ${supportedLevels.join(", ")}.`
    );
  }
  return {
    model: {
      provider: targetModel.provider,
      modelId: targetModel.modelId
    },
    thinkingLevel: targetProfile.thinkingLevel,
    source: "user_configured",
    policyRevision: record.revision
  };
}

// src/runner/subagent.ts
function createSubagentExtension(getPolicy) {
  return defineExtension2({
    name: "subagent",
    tools: [
      defineTool({
        name: "subagent",
        description: "Delegate a self-contained task to an async subagent. Uses the configured runtime subagent model policy (inherits parent model or uses provider-configured model). Runs in the background by default without blocking the conversation.",
        parameters: Type.Object({
          task: Type.String({ description: "What the subagent should do" }),
          background: Type.Optional(
            Type.Boolean({
              description: "Run in background asynchronously (default: true). Set false only if an immediate synchronous answer is strictly required.",
              default: true
            })
          )
        }),
        replay: "safe",
        execute: async (args2, api, context) => {
          if (api.conversationId !== void 0 && Number(api.conversationId) > 1) {
            return {
              output: [
                {
                  type: "text",
                  text: "Subagent recursion blocked: nested subagents are not permitted to spawn further subagents (max depth 1 reached)."
                }
              ],
              isError: true,
              details: { error: "MAX_DEPTH_EXCEEDED", task: args2.task }
            };
          }
          const isBackground = args2.background !== false;
          const key = `subagent:${api.taskId}`;
          const requestId = `subagent:${api.taskId}`;
          const existingRecord = await api.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, api.conversationId);
            return state?.agents?.[key];
          }, context);
          let childRecord;
          if (existingRecord) {
            childRecord = existingRecord;
          } else {
            const parentAgent = await api.agent(context);
            const policySnapshot = getPolicy();
            const availableModels = policySnapshot.policy.mode === "configured" ? await api.models.getAvailable() : [];
            const resolved = resolveSubagentModelConfiguration(
              policySnapshot,
              {
                model: normalizeModelReference(parentAgent?.model),
                thinkingLevel: parentAgent?.thinkingLevel ?? "off"
              },
              availableModels
            );
            childRecord = await api.commit(async (tx) => {
              const state = await tx.doc(SubagentsDoc, api.conversationId);
              if (state?.agents?.[key]) {
                return state.agents[key];
              }
              const existingAnchorId = state?.agents?.[key]?.anchorTaskId;
              let existingConv = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
              if (!existingConv && existingAnchorId !== void 0) {
                existingConv = (await tx.scanConversations({ ownerTaskId: existingAnchorId }, 1)).items[0];
              }
              let childId = existingConv?.id ?? state?.agents?.[key]?.conversationId;
              let anchorId = existingAnchorId;
              if (childId === void 0) {
                if (isBackground) {
                  anchorId = await tx.createTask(Anchor, null, BACKGROUND);
                }
                const ownership = isBackground && anchorId !== void 0 ? { kind: "task", taskId: anchorId } : { kind: "task", taskId: api.taskId };
                const created = await tx.createConversation({ ownership });
                await configure(tx, created.id, {
                  model: resolved.model,
                  thinkingLevel: resolved.thinkingLevel,
                  instructions: buildTechnicalWorkerRole()
                });
                childId = created.id;
              }
              const record = {
                name: args2.task.trim(),
                conversationId: childId,
                requestId,
                task: args2.task,
                role: "worker",
                ownerTaskId: api.taskId,
                ...anchorId !== void 0 ? { anchorTaskId: anchorId } : {},
                background: isBackground,
                actualModel: resolved.model,
                thinkingLevel: resolved.thinkingLevel,
                source: resolved.source,
                policyRevision: resolved.policyRevision
              };
              if (isBackground) {
                record.reporter = await tx.createTask(
                  DefaultReporter,
                  { key, conversationId: childId, task: args2.task, requestId },
                  BACKGROUND
                );
              }
              if (state) {
                state.agents ??= {};
                state.agents[key] = record;
              }
              return record;
            }, context);
          }
          const detailsPayload = {
            conversationId: childRecord.conversationId,
            task: args2.task,
            background: isBackground
          };
          if (childRecord.actualModel) {
            detailsPayload.actualModel = childRecord.actualModel;
          }
          if (childRecord.thinkingLevel) {
            detailsPayload.thinkingLevel = childRecord.thinkingLevel;
          }
          if (childRecord.source) {
            detailsPayload.source = childRecord.source;
          }
          if (childRecord.policyRevision !== void 0) {
            detailsPayload.policyRevision = childRecord.policyRevision;
          }
          await api.details(detailsPayload, context);
          if (isBackground) {
            return {
              output: [
                {
                  type: "text",
                  text: `Subagent spawned in background (conversation ${childRecord.conversationId}). The task is running independently and will report upon completion.`
                }
              ],
              details: detailsPayload
            };
          }
          const handle = await api.conversation(childRecord.conversationId, context);
          if (!handle) throw new Error(`Failed to access subagent conversation: ${childRecord.conversationId}`);
          const submission = await handle.submit({ type: "input", content: args2.task, requestId }, context);
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(`Subagent ${childRecord.conversationId} failed: ${settled.status}`);
          }
          const text = await answerText(api, settled.answer, context);
          await api.commit(async (tx) => {
            const state = await tx.doc(SubagentsDoc, api.conversationId);
            if (state?.agents?.[key]) {
              state.agents[key].settled = true;
              state.agents[key].report = text;
            }
          }, context);
          return {
            output: [{ type: "text", text }],
            details: detailsPayload
          };
        }
      })
    ]
  });
}

// src/runner/plugins/built-in/subagents.ts
var subagentsPlugin = {
  id: "subagents",
  name: "Subagents",
  category: "built-in",
  version: "1.0.0",
  register(ctx) {
    if (!ctx.registry) return;
    if (typeof ctx.getSubagentPolicy === "function") {
      ctx.registry.install(createSubagentExtension(ctx.getSubagentPolicy));
    }
    ctx.registry.install(Anchor);
    ctx.registry.install(DefaultCourier);
    ctx.registry.install(DefaultReporter);
  },
  teardown() {
  }
};

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
async function createCodingRegistry(settingsManager, cwd, getSubagentPolicy, promptOptions, dynamicNamespaces, customPlugins = []) {
  const registry = createRegistry();
  const pluginRegistry = new DurablePluginRegistry();
  pluginRegistry.register(codingToolsPlugin);
  pluginRegistry.register(codemodePlugin);
  pluginRegistry.register(subagentsPlugin);
  for (const plugin of customPlugins) {
    pluginRegistry.register(plugin);
  }
  const ctx = {
    registry,
    settingsManager,
    cwd,
    storageDir: cwd,
    getSubagentPolicy,
    prompt: promptOptions,
    dynamicNamespaces
  };
  await pluginRegistry.initAll(ctx);
  registry.install(createToolSearchExtension());
  registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
  return Object.assign(registry, { pluginRegistry });
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
  if (cli?.model !== void 0) {
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

// src/runner/session-storage.ts
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join as join2, resolve as resolve2 } from "node:path";
import lockfile from "proper-lockfile";

// src/shared/agent-dir.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function getAgentDir(env = process.env) {
  const override = env.PI_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (override && override.length > 0) return resolve(override);
  return join(homedir(), ".pi", "agent");
}

// src/runner/session-storage.ts
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function isVerifiedRunnerProcess(owner) {
  if (!isProcessAlive(owner.pid)) return false;
  try {
    const output2 = execFileSync("ps", ["-p", String(owner.pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output2.includes("node") || output2.includes("runner") || output2.includes("durable") || output2.includes("bb");
  } catch {
    return false;
  }
}
function logUnexpectedErr(err, allowedCode, context) {
  if (err?.code !== allowedCode) {
    console.warn(`[SessionStorage] ${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function writeOwnerFile(directory, owner) {
  await writeFile(join2(directory, "session.owner.json"), JSON.stringify(owner, null, 2), "utf8");
}
async function readOwnerFile(directory) {
  try {
    const content = await readFile(join2(directory, "session.owner.json"), "utf8");
    return JSON.parse(content);
  } catch (err) {
    logUnexpectedErr(err, "ENOENT", `Corrupted or unreadable session.owner.json in ${directory}`);
    return null;
  }
}
async function removeOwnerFile(directory) {
  await rm(join2(directory, "session.owner.json"), { force: true }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `Failed to remove owner file in ${directory}`)
  );
}
async function forceUnlock(directory) {
  await lockfile.unlock(directory, { realpath: false }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `unlock warning for ${directory}`)
  );
  await rm(`${directory}.lock`, { recursive: true, force: true }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `lockfile cleanup warning for ${directory}`)
  );
}
async function acquireSessionLock(directory, cwd, id) {
  const lockOpts = { realpath: false, retries: { retries: 2, minTimeout: 100, maxTimeout: 200 } };
  let rawRelease;
  try {
    rawRelease = await lockfile.lock(directory, lockOpts);
  } catch (initialErr) {
    let owner = await readOwnerFile(directory);
    if (!owner) {
      await new Promise((r) => setTimeout(r, 100));
      owner = await readOwnerFile(directory);
    }
    if (!owner) {
      throw new Error(`Session is already open in another process: ${directory}`, { cause: initialErr });
    }
    const isAlive = isProcessAlive(owner.pid);
    const isRunner = isAlive && isVerifiedRunnerProcess(owner);
    if (!isAlive || !isRunner) {
      await forceUnlock(directory);
      await removeOwnerFile(directory);
      try {
        rawRelease = await lockfile.lock(directory, lockOpts);
      } catch (retryErr) {
        throw new DurableStorageError(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, retryErr);
      }
    } else {
      throw new DurableStorageError(
        `Session is already open in another live process (PID: ${owner.pid}): ${directory}`,
        initialErr
      );
    }
  }
  await writeOwnerFile(directory, { pid: process.pid, id, cwd, startedAt: Date.now() });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await removeOwnerFile(directory);
    } finally {
      await rawRelease();
    }
  };
}
async function selectSession(cwdInput, continueSession, targetSession) {
  const cwd = await realpath(resolve2(cwdInput));
  const root = join2(getAgentDir(), "experimental", "durable-sessions", createHash("sha256").update(cwd).digest("hex").slice(0, 24));
  await mkdir(root, { recursive: true });
  let directory;
  let created = false;
  if (targetSession) {
    const clean = targetSession.endsWith(".sqlite") ? resolve2(targetSession, "..") : targetSession;
    directory = clean.includes("/") || clean.includes("\\") ? resolve2(clean) : join2(root, clean);
    try {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      if (!entries.includes("session.sqlite")) {
        created = true;
      }
    } catch (err) {
      logUnexpectedErr(err, "ENOENT", `Directory inspection failed in ${directory}`);
    }
  } else if (continueSession) {
    const entries = await readdir(root, { withFileTypes: true });
    const newest = entries.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name)).map((entry) => entry.name).sort().at(-1);
    if (!newest) throw new Error(`No durable session exists for ${cwd}`);
    directory = join2(root, newest);
  } else {
    directory = join2(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
    await mkdir(directory);
    created = true;
  }
  const id = basename(directory);
  const release = await acquireSessionLock(directory, cwd, id);
  return { id, directory, database: join2(directory, "session.sqlite"), cwd, created, release };
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

// src/runner/compaction-hooks.ts
var CompactionSideEffectError = class extends Error {
  code;
  operation;
  constructor(operation, cause) {
    const code = operation === "compact_context" ? "CONTEXT_RETRIEVAL_FAILED" : "COMPACTION_HOOK_FAILED";
    super(`${operation} failed (${code})`, { cause });
    this.name = "CompactionSideEffectError";
    this.operation = operation;
    this.code = code;
  }
};
async function runCompactionSideEffect(operation, action, notice) {
  try {
    return { status: "succeeded", value: await action() };
  } catch (cause) {
    const error = new CompactionSideEffectError(operation, cause);
    notice("warning", error.message);
    return { status: "failed", error };
  }
}

// src/runner/runtime-controller.ts
import { clampThinkingLevel, getSupportedThinkingLevels as getSupportedThinkingLevels2 } from "@earendil-works/pi-ai";
function createDurableController(ctx) {
  let queue = Promise.resolve();
  const command = (operation) => {
    queue = queue.then(operation).catch(ctx.fail);
    return queue;
  };
  const watchAnswer = (submission) => {
    void submission.wait(runtimeContext).then(async (settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        ctx.notice(
          "error",
          `No answer: ${settled.reason}${settled.detail === void 0 ? "" : ` ${JSON.stringify(settled.detail)}`}`
        );
      }
      if (ctx.extensionRunner) {
        try {
          await ctx.extensionRunner.emit({ type: "agent_end", messages: [] });
          await ctx.extensionRunner.emit({ type: "agent_settled", aborted: settled.status === "unanswered" && settled.reason === "aborted" });
        } catch (err) {
          ctx.notice("warning", `agent lifecycle hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
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
    submit: (input, whenBusy) => command(async () => {
      const isStr = typeof input === "string";
      const prompt = isStr ? input : input.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const images = isStr ? void 0 : input.filter((c) => c.type === "image");
      if (ctx.extensionRunner) {
        try {
          const currentAgent = await ctx.bindings.current.agent(runtimeContext);
          const activeTools = currentAgent.tools.map((t) => t.name);
          const hookRes = await ctx.extensionRunner.emitBeforeAgentStart(
            { messageType: "user", prompt, images: images?.length ? images : void 0 },
            {
              cwd: ctx.cwd ?? process.cwd(),
              selectedTools: activeTools,
              sections: ctx.dynamicSections?.getSections() ?? {}
            }
          );
          if (hookRes?.systemPromptOptions?.sections && ctx.dynamicSections) {
            ctx.dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
          }
          const selectedTools = hookRes?.systemPromptOptions?.selectedTools;
          const handlerEdited = selectedTools && (selectedTools.length !== activeTools.length || selectedTools.some((name, i) => name !== activeTools[i]));
          const nextActiveTools = handlerEdited ? selectedTools : ctx.getActiveTools?.() ?? ctx.extensionRunner?.getActiveTools?.() ?? activeTools;
          if (handlerEdited && ctx.setActiveTools) ctx.setActiveTools(selectedTools);
          if (nextActiveTools && (nextActiveTools.length !== activeTools.length || nextActiveTools.some((name, i) => name !== activeTools[i]))) {
            await ctx.bindings.current.configure({ modelTools: nextActiveTools.map((name) => ({ name })) }, runtimeContext);
          }
        } catch (err) {
          ctx.notice(
            "warning",
            `before_agent_start error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return watchAnswer(await ctx.bindings.current.submit({ type: "input", content: input, whenBusy }, runtimeContext));
    }),
    compact: (instructions) => command(async () => {
      const extensionRunner = ctx.extensionRunner;
      if (extensionRunner) {
        const context = await runCompactionSideEffect("compact_context", () => ctx.bindings.current.context(runtimeContext), ctx.notice);
        if (context.status === "succeeded") {
          const ctxView = context.value;
          const msgs = [...ctxView.messages], entries = [...ctxView.entries];
          await runCompactionSideEffect("session_before_compact", () => extensionRunner.emit({
            type: "session_before_compact",
            preparation: { firstKeptEntryId: ctxView.head?.id !== void 0 ? String(ctxView.head.id) : "", messagesToSummarize: msgs, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 0, fileOps: { read: /* @__PURE__ */ new Set(), written: /* @__PURE__ */ new Set(), edited: /* @__PURE__ */ new Set() }, settings: {} },
            branchEntries: entries,
            customInstructions: instructions,
            reason: "manual",
            willRetry: false,
            signal: new AbortController().signal
          }), ctx.notice);
        }
      }
      const id = await ctx.bindings.current.compact(instructions, runtimeContext);
      void ctx.opened.waitForTask(id, runtimeContext).then(async (receipt) => {
        const outcome = receipt.state.outcome;
        if (outcome.status === "completed") {
          if (extensionRunner) {
            void runCompactionSideEffect("session_compact", () => extensionRunner.emit({
              type: "session_compact",
              compactionEntry: { id: outcome.result?.entryId ?? "", type: "compaction", summary: "", tokensBefore: 0, tokensAfter: 0 },
              fromExtension: false,
              reason: "manual",
              willRetry: false
            }), ctx.notice).catch(ctx.fail);
          }
          const { entryId, submissionId } = outcome.result;
          const status = submissionId === void 0 ? void 0 : (await (await ctx.opened.submission(submissionId, runtimeContext))?.status(runtimeContext))?.status;
          const msg = entryId !== void 0 || status === "done" ? "Compacted." : status === "queued" ? "Compaction summary queued; it is placed at the next turn boundary." : status === "unanswered" ? "Compaction summary dropped: the context changed under it." : "Nothing to compact: the context fits in the recent window that is kept verbatim.";
          ctx.notice("info", msg);
        } else if (outcome.status === "aborted") {
          ctx.notice("info", "Compaction aborted.");
        } else {
          ctx.notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
        }
      }).catch(ctx.fail);
    }),
    abort: () => command(async () => {
      await ctx.bindings.current.abort(runtimeContext, { background: true });
      const childConversationIds = [];
      await ctx.bindings.current.commit(async (tx) => {
        const doc = await tx.doc(SubagentsDoc, ctx.bindings.current.id);
        for (const agent of Object.values(doc?.agents ?? {})) {
          if (!agent.settled && agent.conversationId) {
            childConversationIds.push(agent.conversationId);
          }
        }
      }, runtimeContext).catch((err) => {
        ctx.notice("warning", `Cascade abort read error: ${err}`);
      });
      for (const childId of childConversationIds) {
        const child = await ctx.opened.conversation(childId, runtimeContext).catch((err) => {
          ctx.notice("warning", `Failed to access subagent: ${err}`);
          return void 0;
        });
        if (child) {
          await child.abort(runtimeContext, { background: true }).catch((err) => {
            ctx.notice("warning", `Failed to abort subagent: ${err}`);
          });
        }
      }
    }),
    cycleThinking: () => command(async () => {
      const model = agentModel();
      if (!model.reasoning) throw new Error("Current model does not support thinking");
      const levels = getSupportedThinkingLevels2(model), level = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      await ctx.bindings.current.configure({ thinkingLevel: levels[(levels.indexOf(level) + 1) % levels.length] ?? "off" }, runtimeContext);
    }),
    setThinkingLevel: (targetLevel) => command(async () => {
      const model = agentModel();
      if (!model.reasoning) {
        if (targetLevel === "off" || targetLevel === "none") {
          return void await ctx.bindings.current.configure({ thinkingLevel: "off" }, runtimeContext);
        }
        throw new Error("Current model does not support thinking");
      }
      await ctx.bindings.current.configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, runtimeContext);
    }),
    setModel: (ref) => command(async () => {
      const model = ctx.modelRuntime.getModel(ref.provider, ref.modelId);
      if (model === void 0) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
      ctx.setActiveModelRef(ref);
      const thinking = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      await ctx.bindings.current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, runtimeContext);
    }),
    toggleTasks: () => command(async () => {
      if (ctx.bindings.tasksOpen) return ctx.bindings.closeTasks();
      ctx.bindings.attachTasks(await ctx.opened.taskGraph(runtimeContext));
    }),
    switchConversation: (id) => command(async () => {
      const next = await ctx.opened.conversation(id, runtimeContext);
      if (next === void 0) throw new Error(`Conversation ${id} does not exist`);
      ctx.bindings.bindConversation(next, await next.viewState(runtimeContext));
    })
  };
}

// src/runner/runtime-bindings.ts
var RuntimeBindings = class {
  conversation;
  view;
  unsubscribe;
  tasks;
  unsubscribeTasks;
  epoch = 0;
  taskEpoch = 0;
  closed = false;
  update;
  constructor(conversation, view, update) {
    this.conversation = conversation;
    this.view = view;
    this.update = update;
    try {
      this.unsubscribe = view.subscribe((value) => {
        if (!this.closed && this.epoch === 0) this.update({ conversation: value });
      });
    } catch (cause) {
      try {
        view.dispose();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], "SUBSCRIBE_FAILED");
      }
      throw new Error("SUBSCRIBE_FAILED", { cause });
    }
  }
  get current() {
    return this.conversation;
  }
  get tasksOpen() {
    return this.tasks !== void 0;
  }
  bindConversation(conversation, view) {
    if (this.closed) {
      view.dispose();
      throw new Error("BINDING_CLOSED");
    }
    if (this.view === view) return;
    const epoch = this.epoch + 1;
    let unsubscribe;
    try {
      unsubscribe = view.subscribe((value) => {
        if (!this.closed && this.epoch === epoch) this.update({ conversation: value });
      });
    } catch (cause) {
      view.dispose();
      throw new Error("SUBSCRIBE_FAILED", { cause });
    }
    const previous = this.view, previousUnsubscribe = this.unsubscribe;
    this.view = view;
    this.conversation = conversation;
    this.unsubscribe = unsubscribe;
    this.epoch = epoch;
    try {
      previousUnsubscribe();
    } finally {
      previous.dispose();
    }
    this.update({ conversation: view.value });
  }
  attachTasks(view) {
    if (this.closed) {
      view.dispose();
      throw new Error("BINDING_CLOSED");
    }
    if (this.tasks === view) return;
    const epoch = this.taskEpoch + 1;
    let unsubscribe;
    try {
      unsubscribe = view.subscribe((value) => {
        if (!this.closed && this.taskEpoch === epoch) this.update({ tasks: value });
      });
    } catch (cause) {
      view.dispose();
      throw new Error("SUBSCRIBE_FAILED", { cause });
    }
    const previous = this.tasks, previousUnsubscribe = this.unsubscribeTasks;
    this.tasks = view;
    this.unsubscribeTasks = unsubscribe;
    this.taskEpoch = epoch;
    try {
      previousUnsubscribe?.();
    } finally {
      previous?.dispose();
    }
    this.update({ tasks: view.value });
  }
  closeTasks() {
    if (!this.tasks) return;
    this.taskEpoch++;
    const previous = this.tasks, unsubscribe = this.unsubscribeTasks;
    this.tasks = void 0;
    this.unsubscribeTasks = void 0;
    try {
      unsubscribe?.();
    } finally {
      previous.dispose();
    }
    if (!this.closed) this.update({ tasks: void 0 });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    try {
      this.unsubscribe();
    } finally {
      try {
        this.view.dispose();
      } finally {
        this.closeTasks();
      }
    }
  }
};

// src/runner/runtime-cleanup.ts
async function closeRuntimeResources(operations) {
  const failures = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new AggregateError(failures, "RUNTIME_CLEANUP_FAILED");
}

// src/runner/runtime-loader.ts
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  initTheme
} from "@earendil-works/pi-coding-agent";

// src/shared/extension-runner.ts
import {
  createMcpExtension,
  ExtensionRunner,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";

// src/shared/extension-ui-context.ts
function createExtensionUIContext(onNotice, requestInteraction) {
  return {
    select: async (title, options, dialogOptions) => {
      if (requestInteraction) {
        const res = await requestInteraction("select", { title, data: { options, dialogOptions } });
        if (typeof res === "string") return res;
        if (res && typeof res === "object" && "selected" in res) return res.selected;
      }
      return void 0;
    },
    confirm: async (title, message, dialogOptions) => {
      if (requestInteraction) {
        const res = await requestInteraction("confirm", { title, message, data: { dialogOptions } });
        if (typeof res === "boolean") return res;
        if (res && typeof res === "object" && "confirmed" in res) return Boolean(res.confirmed);
      }
      return false;
    },
    input: async (title, placeholder, dialogOptions) => {
      if (requestInteraction) {
        const res = await requestInteraction("input", { title, data: { placeholder, dialogOptions } });
        if (typeof res === "string") return res;
        if (res && typeof res === "object" && "value" in res) return res.value;
      }
      return void 0;
    },
    notify: (message, type = "info") => {
      onNotice?.(type, message);
    },
    onTerminalInput: () => () => {
    },
    setStatus: () => {
    },
    setWorkingMessage: () => {
    },
    setWorkingVisible: () => {
    },
    setWorkingIndicator: () => {
    },
    setHiddenThinkingLabel: () => {
    },
    setWidget: () => {
    },
    setFooter: () => {
    },
    setHeader: () => {
    },
    setTitle: () => {
    },
    custom: async () => void 0,
    pasteToEditor: () => {
    },
    setEditorText: () => {
    },
    getEditorText: () => "",
    editor: async (title, content, dialogOptions) => {
      if (requestInteraction) {
        const res = await requestInteraction("editor", { title, data: { content, dialogOptions } });
        if (typeof res === "string") return res;
        if (res && typeof res === "object" && "content" in res) return res.content;
      }
      return void 0;
    },
    addAutocompleteProvider: () => {
    },
    setEditorComponent: () => {
    },
    getEditorComponent: () => void 0,
    theme: {},
    getAllThemes: () => [],
    getTheme: () => void 0,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {
    }
  };
}

// src/shared/extension-runner.ts
function createStandardExtensionFactories() {
  return [createMcpExtension()];
}
function createExtensionActions(options, initialActiveTools = []) {
  let activeToolNames = [...initialActiveTools];
  let sessionName;
  const sendMessage = (message, sendOptions) => {
    if (sendOptions?.triggerTurn && message?.content) {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      void options.onSubmitUserMessage?.(text, sendOptions.deliverAs === "steer" ? "steer" : "followUp");
    }
  };
  const sendUserMessage = (content, sendOptions) => {
    void options.onSubmitUserMessage?.(content, sendOptions?.deliverAs);
  };
  return {
    getActiveTools: () => activeToolNames,
    getAllTools: () => {
      const map = /* @__PURE__ */ new Map();
      if (options.getCallableTools) {
        for (const t of options.getCallableTools()) {
          map.set(t.name, {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            exposure: "direct",
            reachesTools: t.name === "codemode" || t.name === "tool_search"
          });
        }
      }
      if (options.getRegisteredTools) {
        for (const t of options.getRegisteredTools()) {
          map.set(t.definition.name, {
            name: t.definition.name,
            description: t.definition.description,
            parameters: t.definition.parameters,
            promptGuidelines: t.definition.promptGuidelines,
            exposure: t.definition.exposure ?? "direct",
            namespace: t.definition.namespace,
            annotations: t.definition.annotations,
            sourceInfo: t.sourceInfo
          });
        }
      }
      return Array.from(map.values());
    },
    getSettings: () => ({
      ...options.settingsManager?.getGlobalSettings() ?? {},
      ...options.settingsManager?.getProjectSettings() ?? {}
    }),
    setActiveTools: (toolNames) => {
      activeToolNames = [...toolNames];
      options.onActiveToolsChanged?.(activeToolNames);
    },
    refreshTools: () => {
      options.onToolsChanged?.();
    },
    getThinkingLevel: () => options.settingsManager?.getDefaultThinkingLevel?.() ?? "high",
    setThinkingLevel: () => {
    },
    setModel: async () => false,
    getCommands: () => [],
    sendMessage,
    sendUserMessage,
    appendEntry: (customType, data) => {
      options.sessionManager?.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      sessionName = name;
    },
    getSessionName: () => sessionName,
    setLabel: () => {
    }
  };
}
async function setupExtensionRunner(options) {
  const sessionManager = SessionManager.create(options.cwd);
  const modelRegistry = new ModelRegistry(options.modelRuntime);
  const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);
  runner.setUIContext(createExtensionUIContext(options.onNotice));
  const initialActive = options.initialActiveTools ? [...options.initialActiveTools] : options.getCallableTools ? options.getCallableTools().map((t) => t.name) : [];
  const actions = createExtensionActions({
    getRegisteredTools: () => runner.getAllRegisteredTools(),
    getCallableTools: options.getCallableTools,
    settingsManager: options.settingsManager,
    onActiveToolsChanged: options.onActiveToolsChanged,
    onToolsChanged: options.onToolsChanged,
    sessionManager,
    onSubmitUserMessage: options.onSubmitUserMessage
  }, initialActive);
  const contextActions = {
    getModel: () => {
      const active = options.settingsManager?.getDefaultModel?.();
      const provider = options.settingsManager?.getDefaultProvider?.();
      if (active && provider) {
        const found = options.modelRuntime.getModel(provider, active);
        if (found) return found;
      }
      return options.modelRuntime.getAvailableSnapshot()[0];
    },
    getScopedModels: () => options.modelRuntime.getAvailableSnapshot().map((model) => ({ model })),
    isIdle: () => options.isIdle ? options.isIdle() : true,
    isProjectTrusted: () => true,
    getSignal: () => void 0,
    abort: () => {
      options.onAbort?.();
    },
    hasPendingMessages: () => false,
    shutdown: () => {
    },
    getContextUsage: () => {
      const u = options.getContextUsage?.();
      if (!u) return void 0;
      const pct = typeof u.tokens === "number" && u.contextWindow > 0 ? u.tokens / u.contextWindow * 100 : null;
      return { tokens: u.tokens, contextWindow: u.contextWindow, percent: pct };
    },
    compact: (opts) => {
      options.onCompact?.(typeof opts === "string" ? opts : opts?.customInstructions);
    },
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: options.cwd }),
    executeTool: (callerId, name, args2, opts) => options.executeToolFn(callerId, name, args2, opts),
    getCallableTools: () => options.getCallableTools ? options.getCallableTools() : runner.getAllRegisteredTools().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
      promptGuidelines: t.definition.promptGuidelines,
      exposure: t.definition.exposure,
      namespace: t.definition.namespace,
      annotations: t.definition.annotations,
      sourceInfo: t.sourceInfo
    }))
  };
  runner.bindCore(actions, contextActions);
  await runner.emit({ type: "session_start", reason: "startup" });
  return runner;
}

// src/runner/tool-adapter.ts
import {
  createMcpExtension as createMcpExtension2
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension as defineExtension3,
  defineTool as defineTool2
} from "@earendil-works/pi-durable";
function hasOutput(api) {
  return typeof api === "object" && api !== null && "output" in api && typeof api.output === "function";
}
function adaptExtensionTool(toolDef, executeToolFn, createToolContext, getExtensionRunner) {
  const exposure = toolDef.exposure;
  const isDeferred = exposure === "deferred";
  const callers = exposure === "model-only" ? ["model"] : exposure === "codemode" || exposure === "codemode-deferred" ? ["tools"] : exposure === "hidden" ? [] : ["model", "tools"];
  return defineTool2({
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    callers,
    ...toolDef.promptSnippet ? { promptSnippet: toolDef.promptSnippet } : {},
    ...toolDef.promptGuidelines?.length ? { promptGuidelines: toolDef.promptGuidelines } : {},
    ...isDeferred ? { deferred: true } : {},
    ...toolDef.outputSchema ? {
      outputSchema: toolDef.outputSchema,
      structuredOutputSchema: toolDef.outputSchema
    } : {},
    async execute(args2, api, runtimeContext2) {
      const runner = getExtensionRunner?.();
      const abortSignal = runtimeContext2?.abortSignal;
      if (runner?.hasHandlers("tool_call")) {
        const hookResult = await runner.emitToolCall({
          type: "tool_call",
          toolName: toolDef.name,
          toolCallId: api.callId,
          input: args2 ?? {}
        });
        if (hookResult?.block) {
          const blockContent = [{ type: "text", text: `Tool execution blocked: ${hookResult.reason ?? "policy"}` }];
          return {
            output: blockContent,
            isError: true
          };
        }
      }
      const base = createToolContext?.(api.callId);
      const descriptors = {
        ...Object.getOwnPropertyDescriptors(base ?? {}),
        tools: {
          get: () => base?.tools ?? [],
          configurable: true,
          enumerable: true
        },
        executeTool: {
          value: async (name, nestedArgs, options) => base?.executeTool ? base.executeTool(name, nestedArgs, options) : executeToolFn(api.callId, name, nestedArgs, options),
          configurable: true,
          enumerable: true,
          writable: true
        }
      };
      const ctx = Object.defineProperties({}, descriptors);
      try {
        const result = await toolDef.execute(
          api.callId,
          args2,
          abortSignal,
          (update) => {
            if (update?.content && hasOutput(api)) {
              const textChunks = update.content.filter((c) => c.type === "text").map((c) => c.text).join("");
              if (textChunks.length > 0) api.output(textChunks);
            }
          },
          ctx
        );
        if (runner?.hasHandlers("tool_result")) {
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolDef.name,
            toolCallId: api.callId,
            input: args2 ?? {},
            content: result.content,
            details: result.details ?? void 0,
            isError: result.isError ?? false
          });
        }
        const structuredOutput = result.structuredContent !== void 0 ? result.structuredContent : result.structuredOutput;
        return {
          output: result.content,
          isError: result.isError,
          details: result.details ?? void 0,
          ...structuredOutput !== void 0 ? { structuredOutput } : {}
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorContent = [{ type: "text", text: message }];
        if (runner?.hasHandlers("tool_result")) {
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolDef.name,
            toolCallId: api.callId,
            input: args2 ?? {},
            content: errorContent,
            details: void 0,
            isError: true
          });
        }
        return {
          output: errorContent,
          isError: true
        };
      }
    }
  });
}
function installExtensionTools(registry, tools) {
  if (tools.length === 0) return;
  registry.install(defineExtension3({ name: "extension-tools", tools }));
}

// src/runner/extension-mount.ts
function createNestedToolExecutor(registry, getExtensionRunner, getEnv) {
  return async (callerId, name, args2, options) => {
    const runner = getExtensionRunner?.();
    let target = registry.snapshot().tools().find((t) => t.tool.name === name);
    if (!target && runner) {
      const toolDef = runner.getAllRegisteredTools().find((t) => t.definition.name === name);
      if (toolDef) {
        const ctx = (callId) => runner.createToolContext(callId, options?.signal);
        const adapted = adaptExtensionTool(toolDef.definition, createNestedToolExecutor(registry, getExtensionRunner, getEnv), ctx, () => runner);
        installExtensionTools(registry, [adapted]);
        target = registry.snapshot().tools().find((t) => t.tool.name === name);
      }
    }
    if (!target) {
      return { toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 }, result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} }, isError: true };
    }
    if (runner?.hasHandlers("tool_call")) {
      const hook = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: `${callerId}/nested`,
        parentToolCallId: callerId,
        input: args2 ?? {}
      });
      if (hook?.block) {
        return {
          toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
          result: { content: [{ type: "text", text: `Tool execution blocked: ${hook.reason ?? "policy"}` }], details: {} },
          isError: true
        };
      }
    }
    try {
      const executor = target.tool.execute;
      let outputText = "";
      const api = {
        callId: `${callerId}/nested`,
        output: (chunk) => {
          outputText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        },
        retainedOutput: () => ({ text: outputText, truncated: false }),
        outputWindow: void 0,
        env: getEnv?.(),
        diagnostic: () => {
        }
      };
      const res = await executor(args2, api, runtimeContext);
      const rawBlocks = res?.output;
      const content = Array.isArray(rawBlocks) ? rawBlocks : rawBlocks !== void 0 ? [{ type: "text", text: String(rawBlocks) }] : [{ type: "text", text: outputText }];
      if (runner?.hasHandlers("tool_result")) {
        await runner.emitToolResult({
          type: "tool_result",
          toolName: name,
          toolCallId: `${callerId}/nested`,
          parentToolCallId: callerId,
          input: args2 ?? {},
          content,
          details: res?.details,
          isError: !!res?.isError
        });
      }
      const structuredOutput = res?.structuredContent !== void 0 ? res.structuredContent : res?.structuredOutput;
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: {
          content,
          details: res?.details,
          ...structuredOutput !== void 0 ? { structuredOutput } : {}
        },
        isError: !!res?.isError
      };
    } catch (err) {
      const errorContent = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
      if (runner?.hasHandlers("tool_result")) {
        await runner.emitToolResult({
          type: "tool_result",
          toolName: name,
          toolCallId: `${callerId}/nested`,
          parentToolCallId: callerId,
          input: args2 ?? {},
          content: errorContent,
          details: {},
          isError: true
        });
      }
      return { toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 }, result: { content: errorContent, details: {} }, isError: true };
    }
  };
}
async function mountExtensionBridge(location, modelRuntime, extensionsResult, registry, executeToolFn, report, dynamicSections, onNotice, settingsManager, dynamicNamespaces, actionsDelegate) {
  let extensionRunner;
  try {
    const syncToolsToRegistry = () => {
      if (!extensionRunner) return;
      const all = extensionRunner.getAllRegisteredTools();
      dynamicNamespaces?.registerFromToolDefinitions(all.map((t) => t.definition));
      const adapted = all.map(
        (t) => adaptExtensionTool(t.definition, executeToolFn, (callId) => extensionRunner.createToolContext(callId, void 0), () => extensionRunner)
      );
      installExtensionTools(registry, adapted);
    };
    extensionRunner = await setupExtensionRunner({
      extensions: extensionsResult.extensions,
      runtime: extensionsResult.runtime,
      cwd: location.cwd,
      modelRuntime,
      executeToolFn,
      getCallableTools: () => {
        const map = /* @__PURE__ */ new Map();
        for (const t of registry.snapshot().tools()) {
          map.set(t.tool.name, { name: t.tool.name, description: t.tool.description ?? "", parameters: t.tool.parameters });
        }
        for (const t of extensionRunner?.getAllRegisteredTools() ?? []) {
          map.set(t.definition.name, { ...t.definition, sourceInfo: t.sourceInfo });
        }
        return Array.from(map.values());
      },
      onToolsChanged: syncToolsToRegistry,
      onActiveToolsChanged: (tools) => {
        try {
          void actionsDelegate?.onConfigureModelTools?.(tools)?.catch((err) => console.warn("[ExtensionMount] Configure model tools error:", err));
        } catch (err) {
          console.warn("[ExtensionMount] Synchronous error configuring model tools:", err);
        }
      },
      onNotice,
      settingsManager,
      onAbort: () => actionsDelegate?.onAbort?.(),
      onCompact: (i) => actionsDelegate?.onCompact?.(i),
      getContextUsage: () => actionsDelegate?.getContextUsage?.(),
      isIdle: () => actionsDelegate?.isIdle ? actionsDelegate.isIdle() : true,
      onSubmitUserMessage: (c, d) => actionsDelegate?.onSubmitUserMessage?.(c, d)
    });
    if (extensionRunner) {
      extensionRunner.onError((err) => {
        report(err);
        onNotice?.("error", `[Extension Error] ${err.extensionPath} (${err.event}): ${err.error}`);
      });
      syncToolsToRegistry();
      try {
        await new Promise((r) => setImmediate(r));
        const currentTools = extensionRunner.getActiveTools?.() ?? registry.snapshot().tools().map((t) => t.tool.name);
        const beforeStart = await extensionRunner.emitBeforeAgentStart(
          { messageType: "user", prompt: "", images: void 0 },
          { cwd: location.cwd, selectedTools: currentTools, sections: dynamicSections?.getSections() ?? {} }
        );
        if (beforeStart?.systemPromptOptions?.sections && dynamicSections) {
          dynamicSections.updateSections(beforeStart.systemPromptOptions.sections);
        }
        const selected = beforeStart?.systemPromptOptions?.selectedTools;
        if (selected && (selected.length !== currentTools.length || selected.some((t, i) => t !== currentTools[i]))) {
          extensionsResult.runtime.setActiveTools?.(selected);
        }
      } catch (err) {
        report(err);
      }
    }
  } catch (error) {
    report(error);
  }
  return {
    extensionRunner,
    cleanup: () => extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }).catch((err) => console.warn("[ExtensionBridge] Cleanup session_shutdown:", err)) ?? Promise.resolve(),
    setActiveTools: (tools) => extensionsResult.runtime.setActiveTools?.(tools),
    getActiveTools: () => extensionsResult.runtime.getActiveTools?.() ?? []
  };
}

// src/runner/extensions/bb-tools-extension.ts
import fs from "node:fs";

// node_modules/typebox/build/system/memory/memory.mjs
var memory_exports = {};
__export(memory_exports, {
  Assign: () => Assign,
  Clone: () => Clone,
  Create: () => Create,
  Discard: () => Discard,
  Metrics: () => Metrics,
  Update: () => Update
});

// node_modules/typebox/build/system/memory/metrics.mjs
var Metrics = {
  assign: 0,
  create: 0,
  clone: 0,
  discard: 0,
  update: 0
};

// node_modules/typebox/build/system/settings/settings.mjs
var settings_exports = {};
__export(settings_exports, {
  Get: () => Get,
  Reset: () => Reset,
  Set: () => Set2
});

// node_modules/typebox/build/guard/guard.mjs
var guard_exports = {};
__export(guard_exports, {
  Counted: () => Counted,
  Entries: () => Entries,
  EntriesRegExp: () => EntriesRegExp,
  Every: () => Every,
  EveryAll: () => EveryAll,
  GraphemeCount: () => GraphemeCount2,
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsClassInstance: () => IsClassInstance,
  IsConstructor: () => IsConstructor,
  IsDeepEqual: () => IsDeepEqual,
  IsEqual: () => IsEqual,
  IsFunction: () => IsFunction,
  IsGreaterEqualThan: () => IsGreaterEqualThan,
  IsGreaterThan: () => IsGreaterThan,
  IsInteger: () => IsInteger,
  IsLessEqualThan: () => IsLessEqualThan,
  IsLessThan: () => IsLessThan,
  IsMaxLength: () => IsMaxLength2,
  IsMinLength: () => IsMinLength2,
  IsMultipleOf: () => IsMultipleOf,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsObjectNotArray: () => IsObjectNotArray,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUndefined: () => IsUndefined,
  IsUnsafePropertyKey: () => IsUnsafePropertyKey,
  IsValueLike: () => IsValueLike,
  Keys: () => Keys,
  ShiftLeft: () => ShiftLeft,
  Some: () => Some,
  SomeAll: () => SomeAll,
  Symbols: () => Symbols,
  Values: () => Values
});

// node_modules/typebox/build/guard/string.mjs
function IsBetween(value, min, max) {
  return value >= min && value <= max;
}
function IsZeroWidthJoiner(value) {
  return value === 8205;
}
function IsHighSurrogate(value) {
  return IsBetween(value, 55296, 56319);
}
function IsRegionalIndicator(value) {
  return IsBetween(value, 127462, 127487);
}
function IsVariationSelector(value) {
  return IsBetween(value, 65024, 65039);
}
function IsCombiningMark(value) {
  return IsBetween(value, 768, 879) || IsBetween(value, 6832, 6911) || IsBetween(value, 7616, 7679) || IsBetween(value, 65056, 65071);
}
function CodePointLength(value) {
  return value > 65535 ? 2 : 1;
}
function ConsumeModifiers(value, index) {
  while (index < value.length) {
    const point = value.codePointAt(index);
    if (IsCombiningMark(point) || IsVariationSelector(point)) {
      index += CodePointLength(point);
    } else {
      break;
    }
  }
  return index;
}
function NextGraphemeClusterIndex(value, clusterStart) {
  const startCP = value.codePointAt(clusterStart);
  let clusterEnd = clusterStart + CodePointLength(startCP);
  clusterEnd = ConsumeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && IsZeroWidthJoiner(value.codePointAt(clusterEnd))) {
    const nextCP = value.codePointAt(clusterEnd + 1);
    clusterEnd += 1 + CodePointLength(nextCP);
    clusterEnd = ConsumeModifiers(value, clusterEnd);
  }
  if (IsRegionalIndicator(startCP) && clusterEnd < value.length && IsRegionalIndicator(value.codePointAt(clusterEnd))) {
    clusterEnd += CodePointLength(value.codePointAt(clusterEnd));
  }
  return clusterEnd;
}
function IsGraphemeCodePoint(value) {
  return value >= 768 && // above special range
  (IsHighSurrogate(value) || IsCombiningMark(value) || IsVariationSelector(value) || IsZeroWidthJoiner(value));
}
function GraphemeCount(value) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
  }
  return count;
}
function IsMinLengthSegmented(value, minLength) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    if (++count >= minLength)
      return true;
  }
  return false;
}
function IsMaxLengthSegmented(value, maxLength) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    if (++count > maxLength)
      return false;
  }
  return true;
}
function IsMinLength(value, minLength) {
  if (minLength === 0)
    return true;
  if (value.length < minLength)
    return false;
  let index = 0;
  while (true) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMinLengthSegmented(value, minLength);
    }
    if (++index >= minLength)
      return true;
  }
}
function IsMaxLength(value, maxLength) {
  if (value.length <= maxLength)
    return true;
  let index = 0;
  while (true) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMaxLengthSegmented(value, maxLength);
    }
    if (++index > maxLength)
      return false;
  }
}

// node_modules/typebox/build/guard/guard.mjs
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return IsEqual(typeof value, "bigint");
}
function IsBoolean(value) {
  return IsEqual(typeof value, "boolean");
}
function IsConstructor(value) {
  if (IsUndefined(value) || !IsFunction(value))
    return false;
  const result = Function.prototype.toString.call(value);
  if (/^class\s/.test(result))
    return true;
  if (/\[native code\]/.test(result))
    return true;
  return false;
}
function IsFunction(value) {
  return IsEqual(typeof value, "function");
}
function IsInteger(value) {
  return Number.isInteger(value);
}
function IsNull(value) {
  return IsEqual(value, null);
}
function IsNumber(value) {
  return Number.isFinite(value);
}
function IsObjectNotArray(value) {
  return IsObject(value) && !IsArray(value);
}
function IsObject(value) {
  return IsEqual(typeof value, "object") && !IsNull(value);
}
function IsString(value) {
  return IsEqual(typeof value, "string");
}
function IsSymbol(value) {
  return IsEqual(typeof value, "symbol");
}
function IsUndefined(value) {
  return IsEqual(value, void 0);
}
function IsEqual(left, right) {
  return left === right;
}
function IsGreaterThan(left, right) {
  return left > right;
}
function IsLessThan(left, right) {
  return left < right;
}
function IsLessEqualThan(left, right) {
  return left <= right;
}
function IsGreaterEqualThan(left, right) {
  return left >= right;
}
function IsMultipleOf(dividend, divisor) {
  if (IsBigInt(dividend) || IsBigInt(divisor)) {
    return BigInt(dividend) % BigInt(divisor) === 0n;
  }
  const tolerance = 1e-10;
  if (!IsNumber(dividend))
    return true;
  if (IsInteger(dividend) && 1 / divisor % 1 === 0)
    return true;
  const mod = dividend % divisor;
  return Math.min(Math.abs(mod), Math.abs(mod - divisor), Math.abs(mod + divisor)) < tolerance;
}
function IsClassInstance(value) {
  if (!IsObject(value))
    return false;
  const proto = globalThis.Object.getPrototypeOf(value);
  if (IsNull(proto))
    return false;
  return IsEqual(typeof proto.constructor, "function") && !(IsEqual(proto.constructor, globalThis.Object) || IsEqual(proto.constructor.name, "Object"));
}
function IsValueLike(value) {
  return IsBigInt(value) || IsBoolean(value) || IsNull(value) || IsNumber(value) || IsString(value) || IsUndefined(value);
}
function GraphemeCount2(value) {
  return GraphemeCount(value);
}
function IsMaxLength2(value, length) {
  return IsMaxLength(value, length);
}
function IsMinLength2(value, length) {
  return IsMinLength(value, length);
}
function Every(value, offset, callback) {
  return value.every((item, index) => index < offset || callback(item, index));
}
function EveryAll(value, offset, callback) {
  let result = true;
  value.forEach((item, index) => {
    if (index >= offset && !callback(item, index))
      result = false;
  });
  return result;
}
function Some(value, callback) {
  return value.some((value2, index) => callback(value2, index));
}
function SomeAll(value, callback) {
  let result = false;
  value.forEach((item, index) => {
    if (callback(item, index))
      result = true;
  });
  return result;
}
function Counted(value, callback) {
  return value.reduce((result, value2, index) => callback(value2, index) ? ++result : result, 0);
}
function ShiftLeft(array, true_, false_) {
  return IsEqual(array.length, 0) ? false_() : true_(array[0], array.slice(1));
}
function IsUnsafePropertyKey(key) {
  return IsEqual(key, "__proto__") || IsEqual(key, "constructor") || IsEqual(key, "prototype");
}
function HasPropertyKey(value, key) {
  return IsUnsafePropertyKey(key) ? Object.prototype.hasOwnProperty.call(value, key) : key in value;
}
function EntriesRegExp(value) {
  return Keys(value).map((key) => [new RegExp(`^${key}$`), value[key]]);
}
function Entries(value) {
  return Object.entries(value);
}
function Keys(value) {
  return Object.getOwnPropertyNames(value);
}
function Symbols(value) {
  return Object.getOwnPropertySymbols(value);
}
function Values(value) {
  return Object.values(value);
}
function DeepEqualObject(left, right) {
  if (!IsObject(right))
    return false;
  const keys = Keys(left);
  return IsEqual(keys.length, Keys(right).length) && keys.every((key) => IsDeepEqual(left[key], right[key]));
}
function DeepEqualArray(left, right) {
  return IsArray(right) && IsEqual(left.length, right.length) && left.every((_, index) => IsDeepEqual(left[index], right[index]));
}
function IsDeepEqual(left, right) {
  return IsArray(left) ? DeepEqualArray(left, right) : IsObject(left) ? DeepEqualObject(left, right) : IsEqual(left, right);
}

// node_modules/typebox/build/guard/globals.mjs
var globals_exports = {};
__export(globals_exports, {
  IsBigInt64Array: () => IsBigInt64Array,
  IsBigUint64Array: () => IsBigUint64Array,
  IsBoolean: () => IsBoolean2,
  IsDate: () => IsDate,
  IsFloat32Array: () => IsFloat32Array,
  IsFloat64Array: () => IsFloat64Array,
  IsInt16Array: () => IsInt16Array,
  IsInt32Array: () => IsInt32Array,
  IsInt8Array: () => IsInt8Array,
  IsMap: () => IsMap,
  IsNumber: () => IsNumber2,
  IsRegExp: () => IsRegExp,
  IsSet: () => IsSet,
  IsString: () => IsString2,
  IsTypeArray: () => IsTypeArray,
  IsUint16Array: () => IsUint16Array,
  IsUint32Array: () => IsUint32Array,
  IsUint8Array: () => IsUint8Array,
  IsUint8ClampedArray: () => IsUint8ClampedArray
});
function IsBoolean2(value) {
  return value instanceof Boolean;
}
function IsNumber2(value) {
  return value instanceof Number;
}
function IsString2(value) {
  return value instanceof String;
}
function IsTypeArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsInt8Array(value) {
  return value instanceof globalThis.Int8Array;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUint8ClampedArray(value) {
  return value instanceof globalThis.Uint8ClampedArray;
}
function IsInt16Array(value) {
  return value instanceof globalThis.Int16Array;
}
function IsUint16Array(value) {
  return value instanceof globalThis.Uint16Array;
}
function IsInt32Array(value) {
  return value instanceof globalThis.Int32Array;
}
function IsUint32Array(value) {
  return value instanceof globalThis.Uint32Array;
}
function IsFloat32Array(value) {
  return value instanceof globalThis.Float32Array;
}
function IsFloat64Array(value) {
  return value instanceof globalThis.Float64Array;
}
function IsBigInt64Array(value) {
  return value instanceof globalThis.BigInt64Array;
}
function IsBigUint64Array(value) {
  return value instanceof globalThis.BigUint64Array;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}

// node_modules/typebox/build/system/settings/settings.mjs
var settings = {
  immutableTypes: false,
  maxErrors: 8,
  maxInstantiationCount: 128,
  useAcceleration: true,
  exactOptionalPropertyTypes: false,
  enumerableKind: false,
  correctiveParse: false,
  unionPrioritySort: true
};
function Reset() {
  settings.immutableTypes = false;
  settings.maxErrors = 8;
  settings.maxInstantiationCount = 128;
  settings.useAcceleration = true;
  settings.exactOptionalPropertyTypes = false;
  settings.enumerableKind = false;
  settings.correctiveParse = false;
  settings.unionPrioritySort = true;
}
function Set2(options) {
  for (const key of guard_exports.Keys(options)) {
    const value = options[key];
    if (value !== void 0) {
      Object.defineProperty(settings, key, { value });
    }
  }
}
function Get() {
  return settings;
}

// node_modules/typebox/build/system/memory/freeze.mjs
function Freeze(value) {
  return settings_exports.Get().immutableTypes ? Object.freeze(value) : value;
}

// node_modules/typebox/build/system/memory/assign.mjs
function Assign(left, right) {
  Metrics.assign += 1;
  return Freeze({ ...left, ...right });
}

// node_modules/typebox/build/system/memory/clone.mjs
function FromClassInstance(value) {
  return value;
}
function IsSchemaObject(value) {
  return guard_exports.HasPropertyKey(value, "~kind") || guard_exports.HasPropertyKey(value, "~unsafe");
}
function FromSchemaObject(value) {
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    descriptor.value = FromValue(descriptor.value);
    if (guard_exports.IsEqual(descriptor.enumerable, true)) {
      result[key] = descriptor.value;
    } else {
      Object.defineProperty(result, key, descriptor);
    }
  }
  return result;
}
function FromPlainObject(value) {
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    result[key] = FromValue(value[key]);
  }
  for (const key of guard_exports.Symbols(value)) {
    result[key] = FromValue(value[key]);
  }
  return result;
}
function FromObject(value) {
  return guard_exports.IsClassInstance(value) ? FromClassInstance(value) : IsSchemaObject(value) ? FromSchemaObject(value) : FromPlainObject(value);
}
function FromArray(value) {
  return value.map((element) => FromValue(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromRegExp(value) {
  return new RegExp(value.source, value.flags);
}
function FromMap(value) {
  return new Map(FromValue([...value.entries()]));
}
function FromSet(value) {
  return new Set(FromValue([...value.values()]));
}
function FromValue(value) {
  return globals_exports.IsTypeArray(value) ? FromTypedArray(value) : globals_exports.IsRegExp(value) ? FromRegExp(value) : globals_exports.IsMap(value) ? FromMap(value) : globals_exports.IsSet(value) ? FromSet(value) : guard_exports.IsArray(value) ? FromArray(value) : guard_exports.IsObject(value) ? FromObject(value) : value;
}
function Clone(value) {
  Metrics.clone += 1;
  return FromValue(value);
}

// node_modules/typebox/build/system/memory/create.mjs
function MergeHidden(left, right) {
  for (const key of Object.keys(right)) {
    Object.defineProperty(left, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: right[key]
    });
  }
  return left;
}
function Merge(left, right) {
  return { ...left, ...right };
}
function Create(hidden, enumerable, options = {}) {
  Metrics.create += 1;
  const withOptions = Merge(enumerable, options);
  const withHidden = settings_exports.Get().enumerableKind ? Merge(withOptions, hidden) : MergeHidden(withOptions, hidden);
  return Freeze(withHidden);
}

// node_modules/typebox/build/system/memory/discard.mjs
function Discard(value, propertyKeys) {
  Metrics.discard += 1;
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (propertyKeys.includes(key))
      continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    descriptor.value = Clone(descriptor.value);
    Object.defineProperty(result, key, descriptor);
  }
  return Freeze(result);
}

// node_modules/typebox/build/system/memory/update.mjs
function Update(current, hidden, enumerable) {
  Metrics.update += 1;
  const settings2 = settings_exports.Get();
  const result = Clone(current);
  for (const key of Object.keys(hidden)) {
    Object.defineProperty(result, key, {
      configurable: true,
      writable: true,
      enumerable: settings2.enumerableKind,
      value: hidden[key]
    });
  }
  for (const key of Object.keys(enumerable)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: enumerable[key]
    });
  }
  return Freeze(result);
}

// node_modules/typebox/build/type/types/schema.mjs
function IsKind(value, kind) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], kind);
}
function IsSchema(value) {
  return guard_exports.IsObject(value);
}

// node_modules/typebox/build/type/types/deferred.mjs
function Deferred(action, parameters, options) {
  return memory_exports.Create({ "~kind": "Deferred" }, { type: "deferred", action, parameters, options }, {});
}
function IsDeferred(value) {
  return IsKind(value, "Deferred");
}

// node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs
function AddReadonlyOperation(type) {
  return memory_exports.Update(type, { "~readonly": true }, {});
}
function AddReadonlyAction(type, options) {
  const result = memory_exports.Update(AddReadonlyOperation(type), {}, options);
  return result;
}
function AddReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_add.mjs
function AddOptionalOperation(type) {
  return memory_exports.Update(type, { "~optional": true }, {});
}
function AddOptionalAction(type, options) {
  const result = memory_exports.Update(AddOptionalOperation(type), {}, options);
  return result;
}
function AddOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/types/array.mjs
function _Array_(items, options) {
  return memory_exports.Create({ "~kind": "Array" }, { type: "array", items }, options);
}
function IsArray2(value) {
  return IsKind(value, "Array");
}
function ArrayOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items"]);
}

// node_modules/typebox/build/type/types/constructor.mjs
function Constructor(parameters, instanceType, options = {}) {
  return memory_exports.Create({ "~kind": "Constructor" }, { type: "constructor", parameters, instanceType }, options);
}
function IsConstructor2(value) {
  return IsKind(value, "Constructor");
}
function ConstructorOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "instanceType"]);
}

// node_modules/typebox/build/type/types/function.mjs
function _Function_(parameters, returnType, options = {}) {
  return memory_exports.Create({ ["~kind"]: "Function" }, { type: "function", parameters, returnType }, options);
}
function IsFunction2(value) {
  return IsKind(value, "Function");
}
function FunctionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "returnType"]);
}

// node_modules/typebox/build/type/types/ref.mjs
function Ref(ref, options) {
  return memory_exports.Create({ ["~kind"]: "Ref" }, { $ref: ref }, options);
}
function IsRef(value) {
  return IsKind(value, "Ref");
}

// node_modules/typebox/build/type/types/generic.mjs
function Generic(parameters, expression) {
  return memory_exports.Create({ "~kind": "Generic" }, { type: "generic", parameters, expression });
}
function IsGeneric(value) {
  return IsKind(value, "Generic");
}

// node_modules/typebox/build/type/types/any.mjs
function Any(options) {
  return memory_exports.Create({ ["~kind"]: "Any" }, {}, options);
}
function IsAny(value) {
  return IsKind(value, "Any");
}

// node_modules/typebox/build/type/types/never.mjs
var NeverPattern = "(?!)";
function Never(options) {
  return memory_exports.Create({ "~kind": "Never" }, { not: {} }, options);
}
function IsNever(value) {
  return IsKind(value, "Never");
}

// node_modules/typebox/build/type/action/_add_optional.mjs
function AddOptionalDeferred(type, options = {}) {
  return Deferred("AddOptional", [type], options);
}
function AddOptional(type, options = {}) {
  return AddOptionalAction(type, options);
}

// node_modules/typebox/build/type/types/_optional.mjs
function Optional(type) {
  return AddOptional(type);
}
function IsOptional(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~optional");
}

// node_modules/typebox/build/type/types/properties.mjs
function RequiredArray(properties) {
  return guard_exports.Keys(properties).filter((key) => !IsOptional(properties[key]));
}
function PropertyKeys(properties) {
  return guard_exports.Keys(properties);
}
function PropertyValues(properties) {
  return guard_exports.Values(properties);
}

// node_modules/typebox/build/type/types/object.mjs
function _Object_(properties, options = {}) {
  const requiredKeys = RequiredArray(properties);
  const required = requiredKeys.length > 0 ? { required: requiredKeys } : {};
  return memory_exports.Create({ "~kind": "Object" }, { type: "object", ...required, properties }, options);
}
function IsObject2(value) {
  return IsKind(value, "Object");
}
function ObjectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "properties", "required"]);
}

// node_modules/typebox/build/type/types/unknown.mjs
function Unknown(options) {
  return memory_exports.Create({ ["~kind"]: "Unknown" }, {}, options);
}
function IsUnknown(value) {
  return IsKind(value, "Unknown");
}

// node_modules/typebox/build/type/types/cyclic.mjs
function Cyclic($defs, $ref, options) {
  const defs = guard_exports.Keys($defs).reduce((result, key) => {
    return { ...result, [key]: memory_exports.Update($defs[key], {}, { $id: key }) };
  }, {});
  return memory_exports.Create({ ["~kind"]: "Cyclic" }, { $defs: defs, $ref }, options);
}
function IsCyclic(value) {
  return IsKind(value, "Cyclic");
}

// node_modules/typebox/build/type/types/unsafe.mjs
function Unsafe(schema) {
  return memory_exports.Update(schema, { ["~unsafe"]: null }, {});
}
function IsUnsafe(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "~unsafe") && guard_exports.IsNull(value["~unsafe"]);
}

// node_modules/typebox/build/system/arguments/arguments.mjs
var arguments_exports = {};
__export(arguments_exports, {
  Match: () => Match
});
function Match(args2, match) {
  return match[args2.length]?.(...args2) ?? (() => {
    throw Error("Invalid Arguments");
  })();
}

// node_modules/typebox/build/type/types/infer.mjs
function Infer(...args2) {
  const [name, extends_] = arguments_exports.Match(args2, {
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ ["~kind"]: "Infer" }, { type: "infer", name, extends: extends_ }, {});
}
function IsInfer(value) {
  return IsKind(value, "Infer");
}

// node_modules/typebox/build/type/types/dependent.mjs
function Dependent(if_, then_, else_, options = {}) {
  return memory_exports.Create({ "~kind": "Dependent" }, { if: if_, then: then_, else: else_ }, options);
}
function IsDependent(value) {
  return IsKind(value, "Dependent");
}
function DependentOptions(type) {
  return memory_exports.Discard(type, ["~kind", "if", "then", "else"]);
}

// node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs
function IsTypeScriptEnumLike(value) {
  return guard_exports.IsObjectNotArray(value);
}
function TypeScriptEnumToEnumValues(type) {
  const keys = guard_exports.Keys(type).filter((key) => isNaN(key));
  return keys.reduce((result, key) => [...result, type[key]], []);
}

// node_modules/typebox/build/type/types/enum.mjs
function IsEnumValue(value) {
  return guard_exports.IsString(value) || guard_exports.IsNumber(value);
}
function Enum(value, options) {
  const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
  return memory_exports.Create({ "~kind": "Enum" }, { enum: values }, options);
}
function IsEnum(value) {
  return IsKind(value, "Enum");
}

// node_modules/typebox/build/type/types/intersect.mjs
function Intersect(types, options = {}) {
  return memory_exports.Create({ "~kind": "Intersect" }, { allOf: types }, options);
}
function IsIntersect(value) {
  return IsKind(value, "Intersect");
}
function IntersectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "allOf"]);
}

// node_modules/typebox/build/system/unreachable/unreachable.mjs
function Unreachable() {
  throw new Error("Unreachable");
}

// node_modules/typebox/build/system/hashing/hash.mjs
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
  ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
  ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
  ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
  ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
  ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
  ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
  ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
  ByteMarker2[ByteMarker2["String"] = 10] = "String";
  ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
  ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
  ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt(
  "18446744073709551616"
  /* 2 ^ 64 */
)];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
var encoder = new TextEncoder();

// node_modules/typebox/build/type/types/_codec.mjs
var EncodeBuilder = class {
  constructor(type, decode) {
    this.type = type;
    this.decode = decode;
  }
  Encode(callback) {
    const type = this.type;
    const decode = IsCodec(type) ? (value) => this.decode(type["~codec"].decode(value)) : this.decode;
    const encode = IsCodec(type) ? (value) => type["~codec"].encode(callback(value)) : callback;
    const codec = { decode, encode };
    return memory_exports.Update(this.type, { "~codec": codec }, {});
  }
};
var DecodeBuilder = class {
  constructor(type) {
    this.type = type;
  }
  Decode(callback) {
    return new EncodeBuilder(this.type, callback);
  }
};
function Codec(type) {
  return new DecodeBuilder(type);
}
function Decode(type, callback) {
  return Codec(type).Decode(callback).Encode(() => {
    throw Error("Encode not implemented");
  });
}
function Encode(type, callback) {
  return Codec(type).Decode(() => {
    throw Error("Decode not implemented");
  }).Encode(callback);
}
function IsCodec(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~codec") && guard_exports.IsObject(value["~codec"]) && guard_exports.HasPropertyKey(value["~codec"], "encode") && guard_exports.HasPropertyKey(value["~codec"], "decode");
}

// node_modules/typebox/build/type/types/_immutable.mjs
function Immutable(type) {
  return AddImmutable(type);
}
function IsImmutable(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~immutable");
}

// node_modules/typebox/build/type/action/_add_readonly.mjs
function AddReadonlyDeferred(type, options = {}) {
  return Deferred("AddReadonly", [type], options);
}
function AddReadonly(type, options = {}) {
  return AddReadonlyAction(type, options);
}

// node_modules/typebox/build/type/types/_readonly.mjs
function Readonly(type) {
  return AddReadonly(type);
}
function IsReadonly(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~readonly");
}

// node_modules/typebox/build/type/types/_refine.mjs
function RefineAdd(type, refinement) {
  const refinements = IsRefine(type) ? [...type["~refine"], refinement] : [refinement];
  return memory_exports.Update(type, { "~refine": refinements }, {});
}
function Refine(...args2) {
  const [type, check, error] = arguments_exports.Match(args2, {
    3: (type2, check2, error2) => [type2, check2, error2],
    2: (type2, check2) => [type2, check2, () => "Refine Error"]
  });
  return RefineAdd(type, { check, error });
}
function IsRefinement(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "check") && guard_exports.HasPropertyKey(value, "error") && guard_exports.IsFunction(value.check) && guard_exports.IsFunction(value.error);
}
function IsRefine(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => IsRefinement(value2));
}

// node_modules/typebox/build/type/types/bigint.mjs
var BigIntPattern = "-?(?:0|[1-9][0-9]*)n";
function BigInt2(options) {
  return memory_exports.Create({ "~kind": "BigInt" }, { type: "bigint" }, options);
}
function IsBigInt2(value) {
  return IsKind(value, "BigInt");
}

// node_modules/typebox/build/type/types/boolean.mjs
function Boolean2(options) {
  return memory_exports.Create({ "~kind": "Boolean" }, { type: "boolean" }, options);
}
function IsBoolean3(value) {
  return IsKind(value, "Boolean");
}

// node_modules/typebox/build/type/types/identifier.mjs
function Identifier(name) {
  return memory_exports.Create({ "~kind": "Identifier" }, { name });
}
function IsIdentifier(value) {
  return IsKind(value, "Identifier");
}

// node_modules/typebox/build/type/types/integer.mjs
var IntegerPattern = "-?(?:0|[1-9][0-9]*)";
function Integer(options) {
  return memory_exports.Create({ "~kind": "Integer" }, { type: "integer" }, options);
}
function IsInteger2(value) {
  return IsKind(value, "Integer");
}

// node_modules/typebox/build/type/types/literal.mjs
var InvalidLiteralValue = class extends Error {
  constructor(value) {
    super(`Invalid Literal value`);
    Object.defineProperty(this, "cause", {
      value: { value },
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
};
function LiteralTypeName(value) {
  return guard_exports.IsBigInt(value) ? "bigint" : guard_exports.IsBoolean(value) ? "boolean" : guard_exports.IsNumber(value) ? "number" : guard_exports.IsString(value) ? "string" : (() => {
    throw new InvalidLiteralValue(value);
  })();
}
function Literal(value, options) {
  return memory_exports.Create({ "~kind": "Literal" }, { type: LiteralTypeName(value), const: value }, options);
}
function IsLiteralValue(value) {
  return guard_exports.IsBigInt(value) || guard_exports.IsBoolean(value) || guard_exports.IsNumber(value) || guard_exports.IsString(value);
}
function IsLiteralNumber(value) {
  return IsLiteral(value) && guard_exports.IsNumber(value.const);
}
function IsLiteralString(value) {
  return IsLiteral(value) && guard_exports.IsString(value.const);
}
function IsLiteral(value) {
  return IsKind(value, "Literal");
}

// node_modules/typebox/build/type/types/null.mjs
function Null(options) {
  return memory_exports.Create({ "~kind": "Null" }, { type: "null" }, options);
}
function IsNull2(value) {
  return IsKind(value, "Null");
}

// node_modules/typebox/build/type/types/number.mjs
var NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
function Number2(options) {
  return memory_exports.Create({ "~kind": "Number" }, { type: "number" }, options);
}
function IsNumber3(value) {
  return IsKind(value, "Number");
}

// node_modules/typebox/build/type/types/symbol.mjs
function Symbol2(options) {
  return memory_exports.Create({ "~kind": "Symbol" }, { type: "symbol" }, options);
}
function IsSymbol2(value) {
  return IsKind(value, "Symbol");
}

// node_modules/typebox/build/type/types/parameter.mjs
function Parameter(...args2) {
  const [name, extends_, equals] = arguments_exports.Match(args2, {
    3: (name2, extends_2, equals2) => [name2, extends_2, equals2],
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ "~kind": "Parameter" }, { name, extends: extends_, equals }, {});
}
function IsParameter(value) {
  return IsKind(value, "Parameter");
}

// node_modules/typebox/build/type/types/string.mjs
var StringPattern = ".*";
function String2(options) {
  return memory_exports.Create({ "~kind": "String" }, { type: "string" }, options);
}
function IsString3(value) {
  return IsKind(value, "String");
}

// node_modules/typebox/build/type/types/union.mjs
function Union(anyOf, options = {}) {
  return memory_exports.Create({ "~kind": "Union" }, { anyOf }, options);
}
function IsUnion(value) {
  return IsKind(value, "Union");
}
function UnionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "anyOf"]);
}

// node_modules/typebox/build/type/engine/patterns/pattern.mjs
function ParsePatternIntoTypes(pattern) {
  const parsed = Pattern(pattern);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : [];
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/is_finite.mjs
function FromLiteral(_value) {
  return true;
}
function FromTypesReduce(types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType(left) ? FromTypesReduce(right) : false, () => true);
}
function FromTypes(types) {
  const result = guard_exports.IsEqual(types.length, 0) ? false : FromTypesReduce(types);
  return result;
}
function FromType(type) {
  return IsUnion(type) ? FromTypes(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : false;
}
function IsTemplateLiteralFinite(types) {
  const result = FromTypes(types);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/create.mjs
function TemplateLiteralCreate(pattern) {
  return memory_exports.Create({ ["~kind"]: "TemplateLiteral" }, { type: "string", pattern }, {});
}

// node_modules/typebox/build/type/engine/template_literal/decode.mjs
function FromLiteralPush(variants, value, result = []) {
  return guard_exports.ShiftLeft(variants, (left, right) => FromLiteralPush(right, value, [...result, `${left}${value}`]), () => result);
}
function FromLiteral2(variants, value) {
  return guard_exports.IsEqual(variants.length, 0) ? [`${value}`] : FromLiteralPush(variants, value);
}
function FromUnion(variants, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => FromUnion(variants, right, [...result, ...FromType2(variants, left)]), () => result);
}
function FromType2(variants, type) {
  const result = IsUnion(type) ? FromUnion(variants, type.anyOf) : IsLiteral(type) ? FromLiteral2(variants, type.const) : Unreachable();
  return result;
}
function DecodeFromSpan(variants, types) {
  return guard_exports.ShiftLeft(types, (left, right) => DecodeFromSpan(FromType2(variants, left), right), () => variants);
}
function VariantsToLiterals(variants) {
  return variants.map((variant) => Literal(variant));
}
function DecodeTypesAsUnion(types) {
  const variants = DecodeFromSpan([], types);
  const literals = VariantsToLiterals(variants);
  const result = Union(literals);
  return result;
}
function DecodeTypes(types) {
  return guard_exports.IsEqual(types.length, 0) ? Unreachable() : (
    // Literal('') :
    guard_exports.IsEqual(types.length, 1) && IsLiteral(types[0]) ? types[0] : DecodeTypesAsUnion(types)
  );
}
function TemplateLiteralDecodeUnsafe(pattern) {
  const types = ParsePatternIntoTypes(pattern);
  const result = guard_exports.IsEqual(types.length, 0) ? String2() : IsTemplateLiteralFinite(types) ? DecodeTypes(types) : TemplateLiteralCreate(pattern);
  return result;
}
function TemplateLiteralDecode(pattern) {
  const decoded = TemplateLiteralDecodeUnsafe(pattern);
  const result = IsTemplateLiteral(decoded) ? String2() : decoded;
  return result;
}

// node_modules/typebox/build/type/engine/record/record_create.mjs
function CreateRecord(key, value) {
  const type = "object";
  const patternProperties = { [key]: value };
  return memory_exports.Create({ ["~kind"]: "Record" }, { type, patternProperties });
}

// node_modules/typebox/build/type/engine/record/from_key_any.mjs
function FromAnyKey(value) {
  return CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_boolean.mjs
function FromBooleanKey(value) {
  return _Object_({ true: value, false: value });
}

// node_modules/typebox/build/type/types/tuple.mjs
function Tuple(types, options = {}) {
  const [items, minItems, additionalItems] = [types, types.length, false];
  return memory_exports.Create({ ["~kind"]: "Tuple" }, { type: "array", additionalItems, items, minItems }, options);
}
function IsTuple(value) {
  return IsKind(value, "Tuple");
}
function TupleOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items", "minItems", "additionalItems"]);
}

// node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs
function RemoveReadonlyOperation(type) {
  return memory_exports.Discard(type, ["~readonly"]);
}
function RemoveReadonlyAction(type, options) {
  const result = memory_exports.Update(RemoveReadonlyOperation(type), {}, options);
  return result;
}
function RemoveReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_readonly.mjs
function RemoveReadonlyDeferred(type, options = {}) {
  return Deferred("RemoveReadonly", [type], options);
}
function RemoveReadonly(type, options = {}) {
  return RemoveReadonlyAction(type, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs
function RemoveOptionalOperation(type) {
  return memory_exports.Discard(type, ["~optional"]);
}
function RemoveOptionalAction(type, options) {
  const result = memory_exports.Update(RemoveOptionalOperation(type), {}, options);
  return result;
}
function RemoveOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_optional.mjs
function RemoveOptionalDeferred(type, options = {}) {
  return Deferred("RemoveOptional", [type], options);
}
function RemoveOptional(type, options = {}) {
  return RemoveOptionalAction(type, options);
}

// node_modules/typebox/build/type/engine/tuple/to_object.mjs
function TupleElementsToProperties(types) {
  const result = types.reduceRight((result2, right, index) => {
    return { [index]: right, ...result2 };
  }, {});
  return result;
}
function TupleToObject(type) {
  const properties = TupleElementsToProperties(type.items);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/composite.mjs
function CanComposite(type) {
  return IsObject2(type) || IsTuple(type);
}
function IsReadonlyProperty(left, right) {
  return IsReadonly(left) ? IsReadonly(right) ? true : false : false;
}
function IsOptionalProperty(left, right) {
  return IsOptional(left) ? IsOptional(right) ? true : false : false;
}
function CompositeProperty(left, right) {
  const isReadonly = IsReadonlyProperty(left, right);
  const isOptional = IsOptionalProperty(left, right);
  const evaluated = EvaluateIntersect([left, right]);
  const property = RemoveReadonly(RemoveOptional(evaluated));
  return isReadonly && isOptional ? AddReadonly(AddOptional(property)) : isReadonly && !isOptional ? AddReadonly(property) : !isReadonly && isOptional ? AddOptional(property) : property;
}
function CompositePropertyKey(left, right, key) {
  return key in left ? key in right ? CompositeProperty(left[key], right[key]) : left[key] : key in right ? right[key] : Never();
}
function CompositeProperties(left, right) {
  const keys = /* @__PURE__ */ new Set([...guard_exports.Keys(left), ...guard_exports.Keys(right)]);
  const result = [...keys].reduce((result2, key) => {
    return { ...result2, [key]: CompositePropertyKey(left, right, key) };
  }, {});
  return result;
}
function GetProperties(type) {
  const result = IsObject2(type) ? type.properties : IsTuple(type) ? TupleElementsToProperties(type.items) : {};
  return result;
}
function Composite(left, right) {
  const leftProperties = GetProperties(left);
  const rightProperties = GetProperties(right);
  const properties = CompositeProperties(leftProperties, rightProperties);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/narrow.mjs
function NarrowCompareRule(left, right) {
  const result = Compare(left, right);
  return guard_exports.IsEqual(result, CompareResultLeftInside) ? left : guard_exports.IsEqual(result, CompareResultRightInside) ? right : guard_exports.IsEqual(result, CompareResultEqual) ? right : Never();
}
function NarrowCompositeRule(left, right) {
  const canCompositeLeft = CanComposite(left);
  const canCompositeRight = CanComposite(right);
  return canCompositeLeft && canCompositeRight ? Composite(left, right) : canCompositeLeft && !canCompositeRight ? left : !canCompositeLeft && canCompositeRight ? right : NarrowCompareRule(left, right);
}
function Narrow(left, right) {
  return IsNever(left) ? left : IsAny(left) ? left : IsUnknown(left) ? right : IsNever(right) ? right : IsAny(right) ? right : IsUnknown(right) ? left : NarrowCompositeRule(left, right);
}

// node_modules/typebox/build/type/engine/evaluate/distribute.mjs
function ShouldEvaluate(left, right) {
  const result = IsUnion(left) || IsUnion(right);
  return result;
}
function DistributeOperation(left, right) {
  const evaluatedLeft = EvaluateType(left);
  const evaluatedRight = EvaluateType(right);
  const shouldEvaluate = ShouldEvaluate(evaluatedLeft, evaluatedRight);
  const result = shouldEvaluate ? EvaluateIntersect([evaluatedLeft, evaluatedRight]) : Narrow(evaluatedLeft, evaluatedRight);
  return result;
}
function DistributeType(type, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeType(type, right, [...result, DistributeOperation(left, type)]), () => guard_exports.IsEqual(result.length, 0) ? [type] : result);
}
function DistributeUnion(types, distribution, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeUnion(right, distribution, [...result, ...Distribute([left], distribution)]), () => result);
}
function Distribute(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => IsUnion(left) ? Distribute(right, DistributeUnion(left.anyOf, result)) : Distribute(right, DistributeType(left, result)), () => result);
}

// node_modules/typebox/build/type/engine/exclude/operation.mjs
function ExcludeType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [] : [left];
  return result;
}
function ExcludeUnion(left, right, result = []) {
  return guard_exports.ShiftLeft(left, (head, tail) => ExcludeUnion(tail, right, [...result, ...ExcludeType(head, right)]), () => result);
}
function ExcludeOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExcludeUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/evaluate.mjs
function EvaluateDependent(if_, then_, else_) {
  const intersected = EvaluateIntersect([if_, then_]);
  const excluded = ExcludeOperation(else_, if_);
  const result = EvaluateUnion([intersected, excluded]);
  return result;
}
function EvaluateEnum(values, result = []) {
  return guard_exports.ShiftLeft(values, (left, right) => EvaluateEnum(right, [...result, Literal(left)]), () => EvaluateUnion(result));
}
function EvaluateIntersect(types) {
  const distribution = Distribute(types);
  const broadend = Broaden(distribution);
  const result = EvaluateUnion(broadend);
  return result;
}
function EvaluateTemplateLiteral(pattern) {
  const evaluated = TemplateLiteralDecode(pattern);
  const result = EvaluateType(evaluated);
  return result;
}
function EvaluateUnion(types) {
  const broadend = Broaden(types);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateType(type) {
  const result = IsDependent(type) ? EvaluateDependent(type.if, type.then, type.else) : IsEnum(type) ? EvaluateEnum(type.enum) : IsIntersect(type) ? EvaluateIntersect(type.allOf) : IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsUnion(type) ? EvaluateUnion(type.anyOf) : type;
  return result;
}
function EvaluateUnionFast(types) {
  const result = guard_exports.IsEqual(types.length, 1) ? types[0] : guard_exports.IsEqual(types.length, 0) ? Never() : Union(types);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_enum.mjs
function FromEnumKey(values, value) {
  const unionKey = EvaluateEnum(values);
  const result = FromKey(unionKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_integer.mjs
function FromIntegerKey(_key, value) {
  const result = CreateRecord(IntegerKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_intersect.mjs
function FromIntersectKey(types, value) {
  const evaluatedKey = EvaluateIntersect(types);
  const result = FromKey(evaluatedKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_literal.mjs
function FromLiteralKey(key, value) {
  return guard_exports.IsString(key) || guard_exports.IsNumber(key) ? _Object_({ [key]: value }) : guard_exports.IsEqual(key, false) ? _Object_({ false: value }) : guard_exports.IsEqual(key, true) ? _Object_({ true: value }) : _Object_({});
}

// node_modules/typebox/build/type/engine/record/from_key_number.mjs
function FromNumberKey(_key, value) {
  const result = CreateRecord(NumberKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_string.mjs
function FromStringKey(key, value) {
  return guard_exports.HasPropertyKey(key, "pattern") && (guard_exports.IsString(key.pattern) || key.pattern instanceof RegExp) ? CreateRecord(key.pattern.toString(), value) : CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs
function FromTemplateKey(pattern, value) {
  const types = ParsePatternIntoTypes(pattern);
  const finite = IsTemplateLiteralFinite(types);
  const result = finite ? FromKey(EvaluateTemplateLiteral(pattern), value) : CreateRecord(pattern, value);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/flatten.mjs
function FlattenType(type) {
  const result = IsUnion(type) ? Flatten(type.anyOf) : [type];
  return result;
}
function Flatten(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => Flatten(right, [...result, ...FlattenType(left)]), () => result);
}

// node_modules/typebox/build/type/engine/record/from_key_union.mjs
function StringOrNumberCheck(types) {
  return types.some((type) => IsString3(type) || IsNumber3(type) || IsInteger2(type));
}
function TryBuildRecord(types, value) {
  return guard_exports.IsEqual(StringOrNumberCheck(types), true) ? CreateRecord(StringKey, value) : void 0;
}
function CreateProperties(types, value) {
  return types.reduce((result, left) => {
    return IsLiteral(left) && (guard_exports.IsString(left.const) || guard_exports.IsNumber(left.const)) ? { ...result, [left.const]: value } : result;
  }, {});
}
function CreateObject(types, value) {
  const properties = CreateProperties(types, value);
  const result = _Object_(properties);
  return result;
}
function FromUnionKey(types, value) {
  const flattened = Flatten(types);
  const record = TryBuildRecord(flattened, value);
  return IsSchema(record) ? record : CreateObject(flattened, value);
}

// node_modules/typebox/build/type/engine/record/from_key.mjs
function FromKey(key, value) {
  const result = IsAny(key) ? FromAnyKey(value) : IsBoolean3(key) ? FromBooleanKey(value) : IsEnum(key) ? FromEnumKey(key.enum, value) : IsInteger2(key) ? FromIntegerKey(key, value) : IsIntersect(key) ? FromIntersectKey(key.allOf, value) : IsLiteral(key) ? FromLiteralKey(key.const, value) : IsNumber3(key) ? FromNumberKey(key, value) : IsUnion(key) ? FromUnionKey(key.anyOf, value) : IsString3(key) ? FromStringKey(key, value) : IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) : _Object_({});
  return result;
}

// node_modules/typebox/build/type/engine/record/instantiate.mjs
function RecordAction(key, value, options) {
  const result = CanInstantiate([key]) ? memory_exports.Update(FromKey(key, value), {}, options) : RecordDeferred(key, value, options);
  return result;
}
function RecordInstantiate(context, state, key, value, options) {
  const instantiatedKey = InstantiateType(context, state, key);
  const instantiatedValue = InstantiateType(context, state, value);
  return RecordAction(instantiatedKey, instantiatedValue, options);
}

// node_modules/typebox/build/type/types/record.mjs
var IntegerKey = `^${IntegerPattern}$`;
var NumberKey = `^${NumberPattern}$`;
var StringKey = `^${StringPattern}$`;
function RecordDeferred(key, value, options = {}) {
  return Deferred("Record", [key, value], options);
}
function Record(key, value, options = {}) {
  return RecordAction(key, value, options);
}
function RecordFromPattern(pattern, value) {
  return CreateRecord(pattern, value);
}
function RecordPatternToType(pattern) {
  const result = guard_exports.IsEqual(pattern, StringKey) ? String2() : guard_exports.IsEqual(pattern, IntegerKey) ? Integer() : guard_exports.IsEqual(pattern, NumberKey) ? Number2() : TemplateLiteralDecodeUnsafe(pattern);
  return result;
}
function RecordPattern(type) {
  return guard_exports.Keys(type.patternProperties)[0];
}
function RecordKey(type) {
  const pattern = RecordPattern(type);
  const result = RecordPatternToType(pattern);
  return result;
}
function RecordValue(type) {
  return type.patternProperties[RecordPattern(type)];
}
function IsRecord(value) {
  return IsKind(value, "Record");
}

// node_modules/typebox/build/type/types/rest.mjs
function Rest(type) {
  return memory_exports.Create({ "~kind": "Rest" }, { type: "rest", items: type }, {});
}
function IsRest(value) {
  return IsKind(value, "Rest");
}

// node_modules/typebox/build/type/types/this.mjs
function This(options) {
  return memory_exports.Create({ ["~kind"]: "This" }, { $ref: "#" }, options);
}
function IsThis(value) {
  return IsKind(value, "This");
}

// node_modules/typebox/build/type/types/undefined.mjs
function Undefined(options) {
  return memory_exports.Create({ "~kind": "Undefined" }, { type: "undefined" }, options);
}
function IsUndefined2(value) {
  return IsKind(value, "Undefined");
}

// node_modules/typebox/build/type/types/void.mjs
function Void(options) {
  return memory_exports.Create({ "~kind": "Void" }, { type: "void" }, options);
}
function IsVoid(value) {
  return IsKind(value, "Void");
}

// node_modules/typebox/build/type/script/mapping.mjs
function IntrinsicOrCall(ref, parameters) {
  return guard_exports.IsEqual(ref, "Array") ? _Array_(parameters[0]) : guard_exports.IsEqual(ref, "Capitalize") ? CapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ConstructorParameters") ? ConstructorParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Evaluate") ? EvaluateDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Exclude") ? ExcludeDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Extract") ? ExtractDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Index") ? IndexDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "InstanceType") ? InstanceTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Lowercase") ? LowercaseDeferred(parameters[0]) : guard_exports.IsEqual(ref, "NonNullable") ? NonNullableDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Omit") ? OmitDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Parameters") ? ParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Partial") ? PartialDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Pick") ? PickDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Readonly") ? ReadonlyObjectDeferred(parameters[0]) : guard_exports.IsEqual(ref, "KeyOf") ? KeyOfDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Record") ? RecordDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Required") ? RequiredDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ReturnType") ? ReturnTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uncapitalize") ? UncapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uppercase") ? UppercaseDeferred(parameters[0]) : CallConstruct(Ref(ref), parameters);
}
function Unreachable2() {
  throw Error("Unreachable");
}
function DelimitedDecode(input, result = []) {
  return guard_exports.ShiftLeft(input, (left, right) => DelimitedDecode(right, [...result, left[1]]), () => result);
}
function Delimited(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], ...DelimitedDecode(input[1])] : [];
}
function GenericParameterExtendsEqualsMapping(input) {
  return Parameter(input[0], input[2], input[4]);
}
function GenericParameterExtendsMapping(input) {
  return Parameter(input[0], input[2], input[2]);
}
function GenericParameterEqualsMapping(input) {
  return Parameter(input[0], Unknown(), input[2]);
}
function GenericParameterIdentifierMapping(input) {
  return Parameter(input, Unknown(), Unknown());
}
function GenericParameterMapping(input) {
  return input;
}
function GenericParameterListMapping(input) {
  return Delimited(input);
}
function GenericParametersMapping(input) {
  return input[1];
}
function GenericCallArgumentListMapping(input) {
  return Delimited(input);
}
function GenericCallArgumentsMapping(input) {
  return input[1];
}
function GenericCallMapping(input) {
  return IntrinsicOrCall(input[0], input[1]);
}
function OptionalSemiColonMapping(input) {
  return null;
}
function KeywordStringMapping(input) {
  return String2();
}
function KeywordNumberMapping(input) {
  return Number2();
}
function KeywordBooleanMapping(input) {
  return Boolean2();
}
function KeywordUndefinedMapping(input) {
  return Undefined();
}
function KeywordNullMapping(input) {
  return Null();
}
function KeywordIntegerMapping(input) {
  return Integer();
}
function KeywordBigIntMapping(input) {
  return BigInt2();
}
function KeywordUnknownMapping(input) {
  return Unknown();
}
function KeywordAnyMapping(input) {
  return Any();
}
function KeywordObjectMapping(input) {
  return _Object_({});
}
function KeywordNeverMapping(input) {
  return Never();
}
function KeywordSymbolMapping(input) {
  return Symbol2();
}
function KeywordVoidMapping(input) {
  return Void();
}
function KeywordThisMapping(input) {
  return This();
}
function LiteralBigIntMapping(input) {
  return Literal(BigInt(input));
}
function LiteralBooleanMapping(input) {
  return Literal(guard_exports.IsEqual(input, "true"));
}
function LiteralNumberMapping(input) {
  return Literal(parseFloat(input));
}
function LiteralStringMapping(input) {
  return Literal(input);
}
function TemplateInterpolateMapping(input) {
  return input[1];
}
function TemplateSpanMapping(input) {
  return Literal(input);
}
function TemplateBodyMapping(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], input[1], ...input[2]] : [input[0]];
}
function TemplateLiteralTypesMapping(input) {
  return input[1];
}
function TemplateLiteralMapping(input) {
  return TemplateLiteralDeferred(input);
}
function DependentMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? Dependent(input[1], input[3], input[5]) : Dependent(input[1], input[3], Unknown());
}
function KeyOfMapping(input) {
  return input.length > 0;
}
function IndexArrayMapping(input) {
  return input.reduce((result, current) => {
    return guard_exports.IsEqual(current.length, 3) ? [...result, [current[1]]] : [...result, []];
  }, []);
}
function ExtendsMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? [input[1], input[3], input[5]] : [];
}
function BaseMapping(input) {
  return guard_exports.IsArray(input) && guard_exports.IsEqual(input.length, 3) ? input[1] : input;
}
function WithMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function FactorIndexArray(Type3, indexArray) {
  return indexArray.reduce((result, left) => {
    const _left = left;
    return guard_exports.IsEqual(_left.length, 1) ? IndexDeferred(result, _left[0]) : guard_exports.IsEqual(_left.length, 0) ? _Array_(result) : Unreachable2();
  }, Type3);
}
function FactorExtends(type, extend) {
  return guard_exports.IsEqual(extend.length, 3) ? ConditionalDeferred(type, extend[0], extend[1], extend[2]) : type;
}
function FactorWith(type, withClause) {
  return guard_exports.IsArray(withClause) && guard_exports.IsEqual(withClause.length, 0) ? type : WithDeferred(type, withClause);
}
function FactorMapping(input) {
  const [keyOf, type, indexArray, extend, withClause] = input;
  return FactorWith(keyOf ? FactorExtends(KeyOfDeferred(FactorIndexArray(type, indexArray)), extend) : FactorExtends(FactorIndexArray(type, indexArray), extend), withClause);
}
function ExprBinaryMapping(left, rest) {
  return guard_exports.IsEqual(rest.length, 3) ? (() => {
    const [operator, right, next] = rest;
    const Schema = ExprBinaryMapping(right, next);
    if (guard_exports.IsEqual(operator, "&")) {
      return IsIntersect(Schema) ? Intersect([left, ...Schema.allOf]) : Intersect([left, Schema]);
    }
    if (guard_exports.IsEqual(operator, "|")) {
      return IsUnion(Schema) ? Union([left, ...Schema.anyOf]) : Union([left, Schema]);
    }
    Unreachable2();
  })() : left;
}
function ExprTermTailMapping(input) {
  return input;
}
function ExprTermMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprTailMapping(input) {
  return input;
}
function ExprMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprReadonlyMapping(input) {
  return AddImmutableDeferred(input[1]);
}
function ExprPipeMapping(input) {
  return input[1];
}
function GenericTypeMapping(input) {
  return Generic(input[0], input[2]);
}
function InferTypeMapping(input) {
  return guard_exports.IsEqual(input.length, 4) ? Infer(input[1], input[3]) : guard_exports.IsEqual(input.length, 2) ? Infer(input[1], Unknown()) : Unreachable2();
}
function TypeMapping(input) {
  return input;
}
function PropertyKeyNumberMapping(input) {
  return `${input}`;
}
function PropertyKeyIdentMapping(input) {
  return input;
}
function PropertyKeyQuotedMapping(input) {
  return input;
}
function PropertyKeyIndexMapping(input) {
  return IsInteger2(input[3]) ? IntegerKey : IsNumber3(input[3]) ? NumberKey : IsSymbol2(input[3]) ? StringKey : IsString3(input[3]) ? StringKey : Unreachable2();
}
function PropertyKeyMapping(input) {
  return input;
}
function ReadonlyMapping(input) {
  return input.length > 0;
}
function OptionalMapping(input) {
  return input.length > 0;
}
function PropertyMapping(input) {
  const [isReadonly, key, isOptional, _colon, type] = input;
  return {
    [key]: isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type
  };
}
function PropertyDelimiterMapping(input) {
  return input;
}
function PropertyListMapping(input) {
  return Delimited(input);
}
function PropertiesReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    const isPatternProperties = guard_exports.HasPropertyKey(left, IntegerKey) || guard_exports.HasPropertyKey(left, NumberKey) || guard_exports.HasPropertyKey(left, StringKey);
    return isPatternProperties ? [result[0], memory_exports.Assign(result[1], left)] : [memory_exports.Assign(result[0], left), result[1]];
  }, [{}, {}]);
}
function PropertiesMapping(input) {
  return PropertiesReduce(input[1]);
}
function _Object_Mapping(input) {
  const [properties, patternProperties] = input;
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return _Object_(properties, options);
}
function ElementNamedMapping(input) {
  return guard_exports.IsEqual(input.length, 5) ? AddReadonlyDeferred(AddOptionalDeferred(input[4])) : guard_exports.IsEqual(input.length, 3) ? input[2] : guard_exports.IsEqual(input.length, 4) ? guard_exports.IsEqual(input[2], "readonly") ? AddReadonlyDeferred(input[3]) : AddOptionalDeferred(input[3]) : Unreachable2();
}
function ElementBaseMapping(input) {
  if (!guard_exports.IsArray(input) || !guard_exports.IsEqual(input.length, 3))
    return input;
  const [isReadonly, type, isOptional] = input;
  return isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type;
}
function ElementMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ElementListMapping(input) {
  return Delimited(input);
}
function _Tuple_Mapping(input) {
  return Tuple(input[1]);
}
function ParameterReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[4]));
}
function ParameterReadonlyMapping(input) {
  return AddReadonlyDeferred(input[3]);
}
function ParameterOptionalMapping(input) {
  return AddOptionalDeferred(input[3]);
}
function ParameterTypeMapping(input) {
  return input[2];
}
function ParameterBaseMapping(input) {
  return input;
}
function ParameterMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ParameterListMapping(input) {
  return Delimited(input);
}
function _Function_Mapping(input) {
  return _Function_(input[1], input[4]);
}
function _Constructor_Mapping(input) {
  return Constructor(input[2], input[5]);
}
function ApplyReadonly(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveReadonlyDeferred(type) : guard_exports.IsEqual(state, "add") ? AddReadonlyDeferred(type) : type;
}
function MappedReadonlyMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function ApplyOptional(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveOptionalDeferred(type) : guard_exports.IsEqual(state, "add") ? AddOptionalDeferred(type) : type;
}
function MappedOptionalMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function MappedAsMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? [input[1]] : [];
}
function _Mapped_Mapping(input) {
  return guard_exports.IsArray(input[6]) && guard_exports.IsEqual(input[6].length, 1) ? MappedDeferred(Identifier(input[3]), input[5], input[6][0], ApplyReadonly(input[1], ApplyOptional(input[8], input[10]))) : MappedDeferred(Identifier(input[3]), input[5], Ref(input[3]), ApplyReadonly(input[1], ApplyOptional(input[8], input[10])));
}
function ReferenceMapping(input) {
  return Ref(input);
}
function WithBigIntMapping(input) {
  return BigInt(input);
}
function WithNumberMapping(input) {
  return parseFloat(input);
}
function WithBooleanMapping(input) {
  return guard_exports.IsEqual(input, "true");
}
function WithStringMapping(input) {
  return input;
}
function WithNullMapping(input) {
  return null;
}
function WithUndefinedMapping(input) {
  return void 0;
}
function WithPropertyMapping(input) {
  return { [input[0]]: input[2] };
}
function WithPropertyListMapping(input) {
  return Delimited(input);
}
function WithObjectMappingReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    return memory_exports.Assign(result, left);
  }, {});
}
function WithObjectMapping(input) {
  return WithObjectMappingReduce(input[1]);
}
function WithElementListMapping(input) {
  return Delimited(input);
}
function WithArrayMapping(input) {
  return input[1];
}
function WithValueMapping(input) {
  return input;
}
function PatternBigIntMapping(input) {
  return BigInt2();
}
function PatternStringMapping(input) {
  return String2();
}
function PatternNumberMapping(input) {
  return Number2();
}
function PatternIntegerMapping(input) {
  return Integer();
}
function PatternNeverMapping(input) {
  return Never();
}
function PatternTextMapping(input) {
  return Literal(input);
}
function PatternBaseMapping(input) {
  return input;
}
function PatternGroupMapping(input) {
  return Union(input[1]);
}
function PatternUnionMapping(input) {
  return input.length === 3 ? [...input[0], ...input[2]] : input.length === 1 ? [...input[0]] : [];
}
function PatternTermMapping(input) {
  return [input[0], ...input[1]];
}
function PatternBodyMapping(input) {
  return input;
}
function PatternMapping(input) {
  return input[1];
}
function InterfaceDeclarationHeritageListMapping(input) {
  return Delimited(input);
}
function InterfaceDeclarationHeritageMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function InterfaceDeclarationGenericMapping(input) {
  const parameters = input[2];
  const heritage = input[3];
  const [properties, patternProperties] = input[4];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: Generic(parameters, InterfaceDeferred(heritage, properties, options)) };
}
function InterfaceDeclarationMapping(input) {
  const heritage = input[2];
  const [properties, patternProperties] = input[3];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: InterfaceDeferred(heritage, properties, options) };
}
function TypeAliasDeclarationGenericMapping(input) {
  return { [input[1]]: Generic(input[2], input[4]) };
}
function TypeAliasDeclarationMapping(input) {
  return { [input[1]]: input[3] };
}
function ExportKeywordMapping(input) {
  return null;
}
function ModuleDeclarationDelimiterMapping(input) {
  return input;
}
function ModuleDeclarationListMapping(input) {
  return Delimited(input);
}
function ModuleDeclarationMapping(input) {
  return input[1];
}
function ModuleMapping(input) {
  const [moduleDeclaration, moduleDeclarationList] = [input[0], input[1]];
  return ModuleDeferred(memory_exports.Assign(moduleDeclaration, PropertiesReduce(moduleDeclarationList)[0]));
}
function ScriptMapping(input) {
  return input;
}

// node_modules/typebox/build/type/script/token/internal/match.mjs
function IsMatch(value) {
  return IsEqual(value.length, 2);
}
function Match2(input, ok, fail) {
  return IsMatch(input) ? ok(input[0], input[1]) : fail();
}

// node_modules/typebox/build/type/script/token/internal/take.mjs
function TakeVariant(variant, input) {
  return IsEqual(input.indexOf(variant), 0) ? [variant, input.slice(variant.length)] : [];
}
function Take(variants, input) {
  for (let i = 0; i < variants.length; i++) {
    const result = TakeVariant(variants[i], input);
    if (IsMatch(result))
      return result;
  }
  return [];
}

// node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha = [
  ...Range(97, 122),
  // Lowercase
  ...Range(65, 90)
  // Uppercase
];
var Zero = "0";
var NonZero = Range(49, 57);
var Digit = [Zero, ...NonZero];
var WhiteSpace = " ";
var NewLine = "\n";
var UnderScore = "_";
var Dot = ".";
var DollarSign = "$";
var Hyphen = "-";

// node_modules/typebox/build/type/script/token/internal/trim.mjs
var LineComment = "//";
var OpenComment = "/*";
var CloseComment = "*/";
function DiscardMultilineComment(input) {
  const index = input.indexOf(CloseComment);
  const result = IsEqual(index, -1) ? "" : input.slice(index + 2);
  return result;
}
function DiscardLineComment(input) {
  const index = input.indexOf(NewLine);
  const result = IsEqual(index, -1) ? "" : input.slice(index);
  return result;
}
function TrimStartUntilNewline(input) {
  return input.replace(/^[ \t\r\f\v]+/, "");
}
function TrimWhitespace(input) {
  const trimmed = TrimStartUntilNewline(input);
  return trimmed.startsWith(OpenComment) ? TrimWhitespace(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? TrimWhitespace(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
function Trim(input) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(OpenComment) ? Trim(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? Trim(DiscardLineComment(trimmed.slice(2))) : trimmed;
}

// node_modules/typebox/build/type/script/token/internal/optional.mjs
function Optional2(value, input) {
  return Match2(Take([value], input), (Optional4, Rest2) => [Optional4, Rest2], () => ["", input]);
}

// node_modules/typebox/build/type/script/token/internal/many.mjs
function IsDiscard(discard, input) {
  return discard.includes(input);
}
function Many(allowed, discard, input, result = "") {
  return Match2(Take(allowed, input), (Char, Rest2) => IsDiscard(discard, Char) ? Many(allowed, discard, Rest2, result) : Many(allowed, discard, Rest2, `${result}${Char}`), () => [result, input]);
}

// node_modules/typebox/build/type/script/token/unsigned_integer.mjs
function TakeNonZero(input) {
  return Take(NonZero, input);
}
var AllowedDigits = [...Digit, UnderScore];
function TakeDigits(input) {
  return Many(AllowedDigits, [UnderScore], input);
}
function TakeUnsignedInteger(input) {
  return Match2(Take([Zero], input), (Zero2, ZeroRest) => [Zero2, ZeroRest], () => Match2(
    TakeNonZero(input),
    (NonZero2, NonZeroRest) => Match2(TakeDigits(NonZeroRest), (Digits, DigitsRest) => [`${NonZero2}${Digits}`, DigitsRest], () => []),
    // fail: did not match Digits
    () => []
  ));
}
function UnsignedInteger(input) {
  return TakeUnsignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/integer.mjs
function TakeSign(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedInteger(input) {
  return Match2(
    TakeSign(input),
    (Sign, SignRest) => Match2(UnsignedInteger(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Integer2(input) {
  return TakeSignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/bigint.mjs
function TakeBigInt(input) {
  return Match2(
    Integer2(input),
    (Integer3, IntegerRest) => Match2(Take(["n"], IntegerRest), (_N, NRest) => [`${Integer3}`, NRest], () => []),
    // fail: did not match 'n'
    () => []
  );
}
function BigInt3(input) {
  return TakeBigInt(input);
}

// node_modules/typebox/build/type/script/token/const.mjs
function TakeConst(const_, input) {
  return Take([const_], input);
}
function Const(const_, input) {
  return IsEqual(const_, "") ? ["", input] : const_.startsWith(NewLine) ? TakeConst(const_, TrimWhitespace(input)) : const_.startsWith(WhiteSpace) ? TakeConst(const_, input) : TakeConst(const_, Trim(input));
}

// node_modules/typebox/build/type/script/token/ident.mjs
var Initial = [...Alpha, UnderScore, DollarSign];
function TakeInitial(input) {
  return Take(Initial, input);
}
var Remaining = [...Initial, ...Digit];
function TakeRemaining(input, result = "") {
  return Match2(Take(Remaining, input), (Remaining2, RemainingRest) => TakeRemaining(RemainingRest, `${result}${Remaining2}`), () => [result, input]);
}
function TakeIdent(input) {
  return Match2(
    TakeInitial(input),
    (Initial2, InitialRest) => Match2(TakeRemaining(InitialRest), (Remaining2, RemainingRest) => [`${Initial2}${Remaining2}`, RemainingRest], () => []),
    // fail: did not match Remaining
    () => []
  );
}
function Ident(input) {
  return TakeIdent(Trim(input));
}

// node_modules/typebox/build/type/script/token/unsigned_number.mjs
var AllowedDigits2 = [...Digit, UnderScore];
function IsLeadingDot(input) {
  return IsMatch(Take([Dot], input));
}
function TakeFractional(input) {
  return Match2(Many(AllowedDigits2, [UnderScore], input), (Digits, DigitsRest) => IsEqual(Digits, "") ? [] : [Digits, DigitsRest], () => []);
}
function LeadingDot(input) {
  return Match2(
    Take([Dot], input),
    (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`0${Dot2}${Fractional}`, FractionalRest], () => []),
    // fail: did not match Fractional
    () => []
  );
}
function LeadingInteger(input) {
  return Match2(
    UnsignedInteger(input),
    (Integer3, IntegerRest) => Match2(
      Take([Dot], IntegerRest),
      (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`${Integer3}${Dot2}${Fractional}`, FractionalRest], () => [`${Integer3}`, DotRest]),
      // fail: did not match Fractional, use Integer
      () => [`${Integer3}`, IntegerRest]
    ),
    // fail: did not match Dot, use Integer
    () => []
  );
}
function TakeUnsignedNumber(input) {
  return IsLeadingDot(input) ? LeadingDot(input) : LeadingInteger(input);
}
function UnsignedNumber(input) {
  return TakeUnsignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/number.mjs
function TakeSign2(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedNumber(input) {
  return Match2(
    TakeSign2(input),
    (Sign, SignRest) => Match2(UnsignedNumber(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Number3(input) {
  return TakeSignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/until.mjs
function TakeOne(input) {
  const result = IsEqual(input, "") ? [] : [input.slice(0, 1), input.slice(1)];
  return result;
}
function IsInputMatchSentinal(end, input) {
  return ShiftLeft(end, (left, right) => input.startsWith(left) ? true : IsInputMatchSentinal(right, input), () => false);
}
function Until(end, input, result = "") {
  return Match2(
    TakeOne(input),
    (One, Rest2) => IsInputMatchSentinal(end, input) ? [result, input] : Until(end, Rest2, `${result}${One}`),
    () => []
  );
}

// node_modules/typebox/build/type/script/token/span.mjs
function MultiLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, Rest3) => [`${Until2}`, Rest3], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function SingleLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([NewLine, end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, EndRest) => [`${Until2}`, EndRest], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function Span(start, end, multiLine, input) {
  return multiLine ? MultiLine(start, end, Trim(input)) : SingleLine(start, end, Trim(input));
}

// node_modules/typebox/build/type/script/token/string.mjs
function TakeInitial2(quotes, input) {
  return Take(quotes, input);
}
function TakeSpan(quote, input) {
  return Span(quote, quote, false, input);
}
function TakeString(quotes, input) {
  return Match2(TakeInitial2(quotes, input), (Initial2, InitialRest) => TakeSpan(Initial2, `${Initial2}${InitialRest}`), () => []);
}
function String3(quotes, input) {
  return TakeString(quotes, Trim(input));
}

// node_modules/typebox/build/type/script/token/until_1.mjs
function Until_1(end, input) {
  return Match2(Until(end, input), (Until2, UntilRest) => IsEqual(Until2, "") ? [] : [Until2, UntilRest], () => []);
}

// node_modules/typebox/build/type/script/parser.mjs
var If = (result, left, right = () => []) => result.length === 2 ? left(result) : right();
var GenericParameterExtendsEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [GenericParameterExtendsEqualsMapping(_0), input2]);
var GenericParameterExtends = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterExtendsMapping(_0), input2]);
var GenericParameterEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterEqualsMapping(_0), input2]);
var GenericParameterIdentifier = (input) => If(Ident(input), ([_0, input2]) => [GenericParameterIdentifierMapping(_0), input2]);
var GenericParameter = (input) => If(If(GenericParameterExtendsEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterExtends(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterIdentifier(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [GenericParameterMapping(_0), input2]);
var GenericParameterList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(GenericParameter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericParameterList_0(input2, [...result, _0]), () => [result, input]);
var GenericParameterList = (input) => If(If(If(GenericParameter(input), ([_0, input2]) => If(GenericParameterList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [GenericParameterListMapping(_0), input2]);
var GenericParameters = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericParameterList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParametersMapping(_0), input2]);
var GenericCallArgumentList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericCallArgumentList_0(input2, [...result, _0]), () => [result, input]);
var GenericCallArgumentList = (input) => If(If(If(Type2(input), ([_0, input2]) => If(GenericCallArgumentList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [GenericCallArgumentListMapping(_0), input2]);
var GenericCallArguments = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericCallArgumentList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericCallArgumentsMapping(_0), input2]);
var GenericCall = (input) => If(If(Ident(input), ([_0, input2]) => If(GenericCallArguments(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallMapping(_0), input2]);
var OptionalSemiColon = (input) => If(If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalSemiColonMapping(_0), input2]);
var KeywordString = (input) => If(Const("string", input), ([_0, input2]) => [KeywordStringMapping(_0), input2]);
var KeywordNumber = (input) => If(Const("number", input), ([_0, input2]) => [KeywordNumberMapping(_0), input2]);
var KeywordBoolean = (input) => If(Const("boolean", input), ([_0, input2]) => [KeywordBooleanMapping(_0), input2]);
var KeywordUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [KeywordUndefinedMapping(_0), input2]);
var KeywordNull = (input) => If(Const("null", input), ([_0, input2]) => [KeywordNullMapping(_0), input2]);
var KeywordInteger = (input) => If(Const("integer", input), ([_0, input2]) => [KeywordIntegerMapping(_0), input2]);
var KeywordBigInt = (input) => If(Const("bigint", input), ([_0, input2]) => [KeywordBigIntMapping(_0), input2]);
var KeywordUnknown = (input) => If(Const("unknown", input), ([_0, input2]) => [KeywordUnknownMapping(_0), input2]);
var KeywordAny = (input) => If(Const("any", input), ([_0, input2]) => [KeywordAnyMapping(_0), input2]);
var KeywordObject = (input) => If(Const("object", input), ([_0, input2]) => [KeywordObjectMapping(_0), input2]);
var KeywordNever = (input) => If(Const("never", input), ([_0, input2]) => [KeywordNeverMapping(_0), input2]);
var KeywordSymbol = (input) => If(Const("symbol", input), ([_0, input2]) => [KeywordSymbolMapping(_0), input2]);
var KeywordVoid = (input) => If(Const("void", input), ([_0, input2]) => [KeywordVoidMapping(_0), input2]);
var KeywordThis = (input) => If(Const("this", input), ([_0, input2]) => [KeywordThisMapping(_0), input2]);
var TemplateInterpolate = (input) => If(If(Const("${", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateInterpolateMapping(_0), input2]);
var TemplateSpan = (input) => If(Until(["${", "`"], input), ([_0, input2]) => [TemplateSpanMapping(_0), input2]);
var TemplateBody = (input) => If(If(If(TemplateSpan(input), ([_0, input2]) => If(TemplateInterpolate(input2), ([_1, input3]) => If(TemplateBody(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [TemplateBodyMapping(_0), input2]);
var TemplateLiteralTypes = (input) => If(If(Const("`", input), ([_0, input2]) => If(TemplateBody(input2), ([_1, input3]) => If(Const("`", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateLiteralTypesMapping(_0), input2]);
var TemplateLiteral = (input) => If(TemplateLiteralTypes(input), ([_0, input2]) => [TemplateLiteralMapping(_0), input2]);
var Dependent2 = (input) => If(If(If(Const("if", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => If(Const("else", input5), ([_4, input6]) => If(Type2(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If(If(Const("if", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [DependentMapping(_0), input2]);
var LiteralBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [LiteralBigIntMapping(_0), input2]);
var LiteralBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [LiteralBooleanMapping(_0), input2]);
var LiteralNumber = (input) => If(Number3(input), ([_0, input2]) => [LiteralNumberMapping(_0), input2]);
var LiteralString = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [LiteralStringMapping(_0), input2]);
var KeyOf = (input) => If(If(If(Const("keyof", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [KeyOfMapping(_0), input2]);
var IndexArray_0 = (input, result = []) => If(If(If(Const("[", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(Const("[", input), ([_0, input2]) => If(Const("]", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => IndexArray_0(input2, [...result, _0]), () => [result, input]);
var IndexArray = (input) => If(IndexArray_0(input), ([_0, input2]) => [IndexArrayMapping(_0), input2]);
var Extends2 = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => If(Const(":", input5), ([_4, input6]) => If(Type2(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExtendsMapping(_0), input2]);
var Base = (input) => If(If(If(Const("(", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(KeywordString(input), ([_0, input2]) => [_0, input2], () => If(KeywordNumber(input), ([_0, input2]) => [_0, input2], () => If(KeywordBoolean(input), ([_0, input2]) => [_0, input2], () => If(KeywordUndefined(input), ([_0, input2]) => [_0, input2], () => If(KeywordNull(input), ([_0, input2]) => [_0, input2], () => If(KeywordInteger(input), ([_0, input2]) => [_0, input2], () => If(KeywordBigInt(input), ([_0, input2]) => [_0, input2], () => If(KeywordUnknown(input), ([_0, input2]) => [_0, input2], () => If(KeywordAny(input), ([_0, input2]) => [_0, input2], () => If(KeywordObject(input), ([_0, input2]) => [_0, input2], () => If(KeywordNever(input), ([_0, input2]) => [_0, input2], () => If(KeywordSymbol(input), ([_0, input2]) => [_0, input2], () => If(KeywordVoid(input), ([_0, input2]) => [_0, input2], () => If(KeywordThis(input), ([_0, input2]) => [_0, input2], () => If(LiteralBigInt(input), ([_0, input2]) => [_0, input2], () => If(LiteralBoolean(input), ([_0, input2]) => [_0, input2], () => If(LiteralNumber(input), ([_0, input2]) => [_0, input2], () => If(LiteralString(input), ([_0, input2]) => [_0, input2], () => If(TemplateLiteral(input), ([_0, input2]) => [_0, input2], () => If(Dependent2(input), ([_0, input2]) => [_0, input2], () => If(_Object_2(input), ([_0, input2]) => [_0, input2], () => If(_Tuple_(input), ([_0, input2]) => [_0, input2], () => If(_Constructor_(input), ([_0, input2]) => [_0, input2], () => If(_Function_2(input), ([_0, input2]) => [_0, input2], () => If(_Mapped_(input), ([_0, input2]) => [_0, input2], () => If(GenericCall(input), ([_0, input2]) => [_0, input2], () => If(Reference(input), ([_0, input2]) => [_0, input2], () => [])))))))))))))))))))))))))))), ([_0, input2]) => [BaseMapping(_0), input2]);
var With = (input) => If(If(If(Const("with", input), ([_0, input2]) => If(WithObject(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithMapping(_0), input2]);
var Factor = (input) => If(If(KeyOf(input), ([_0, input2]) => If(Base(input2), ([_1, input3]) => If(IndexArray(input3), ([_2, input4]) => If(Extends2(input4), ([_3, input5]) => If(With(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [FactorMapping(_0), input2]);
var ExprTermTail = (input) => If(If(If(Const("&", input), ([_0, input2]) => If(Factor(input2), ([_1, input3]) => If(ExprTermTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTermTailMapping(_0), input2]);
var ExprTerm = (input) => If(If(Factor(input), ([_0, input2]) => If(ExprTermTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprTermMapping(_0), input2]);
var ExprTail = (input) => If(If(If(Const("|", input), ([_0, input2]) => If(ExprTerm(input2), ([_1, input3]) => If(ExprTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTailMapping(_0), input2]);
var Expr = (input) => If(If(ExprTerm(input), ([_0, input2]) => If(ExprTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprMapping(_0), input2]);
var ExprReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprReadonlyMapping(_0), input2]);
var ExprPipe = (input) => If(If(Const("|", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprPipeMapping(_0), input2]);
var GenericType = (input) => If(If(GenericParameters(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericTypeMapping(_0), input2]);
var InferType = (input) => If(If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("extends", input3), ([_2, input4]) => If(Expr(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InferTypeMapping(_0), input2]);
var Type2 = (input) => If(If(InferType(input), ([_0, input2]) => [_0, input2], () => If(ExprPipe(input), ([_0, input2]) => [_0, input2], () => If(ExprReadonly(input), ([_0, input2]) => [_0, input2], () => If(Expr(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [TypeMapping(_0), input2]);
var PropertyKeyNumber = (input) => If(Number3(input), ([_0, input2]) => [PropertyKeyNumberMapping(_0), input2]);
var PropertyKeyIdent = (input) => If(Ident(input), ([_0, input2]) => [PropertyKeyIdentMapping(_0), input2]);
var PropertyKeyQuoted = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [PropertyKeyQuotedMapping(_0), input2]);
var PropertyKeyIndex = (input) => If(If(Const("[", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(If(KeywordInteger(input4), ([_02, input5]) => [_02, input5], () => If(KeywordNumber(input4), ([_02, input5]) => [_02, input5], () => If(KeywordString(input4), ([_02, input5]) => [_02, input5], () => If(KeywordSymbol(input4), ([_02, input5]) => [_02, input5], () => [])))), ([_3, input5]) => If(Const("]", input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyKeyIndexMapping(_0), input2]);
var PropertyKey = (input) => If(If(PropertyKeyNumber(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIdent(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyQuoted(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIndex(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [PropertyKeyMapping(_0), input2]);
var Readonly2 = (input) => If(If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ReadonlyMapping(_0), input2]);
var Optional3 = (input) => If(If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalMapping(_0), input2]);
var Property = (input) => If(If(Readonly2(input), ([_0, input2]) => If(PropertyKey(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => If(Const(":", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyMapping(_0), input2]);
var PropertyDelimiter = (input) => If(If(If(Const(",", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(",", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [PropertyDelimiterMapping(_0), input2]);
var PropertyList_0 = (input, result = []) => If(If(PropertyDelimiter(input), ([_0, input2]) => If(Property(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => PropertyList_0(input2, [...result, _0]), () => [result, input]);
var PropertyList = (input) => If(If(If(Property(input), ([_0, input2]) => If(PropertyList_0(input2), ([_1, input3]) => If(If(PropertyDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PropertyListMapping(_0), input2]);
var Properties = (input) => If(If(Const("{", input), ([_0, input2]) => If(PropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PropertiesMapping(_0), input2]);
var _Object_2 = (input) => If(Properties(input), ([_0, input2]) => [_Object_Mapping(_0), input2]);
var ElementNamed = (input) => If(If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ElementNamedMapping(_0), input2]);
var ElementBase = (input) => If(If(ElementNamed(input), ([_0, input2]) => [_0, input2], () => If(If(Readonly2(input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementBaseMapping(_0), input2]);
var Element = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ElementBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ElementBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementMapping(_0), input2]);
var ElementList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Element(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ElementList_0(input2, [...result, _0]), () => [result, input]);
var ElementList = (input) => If(If(If(Element(input), ([_0, input2]) => If(ElementList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementListMapping(_0), input2]);
var _Tuple_ = (input) => If(If(Const("[", input), ([_0, input2]) => If(ElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_Tuple_Mapping(_0), input2]);
var ParameterReadonlyOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [ParameterReadonlyOptionalMapping(_0), input2]);
var ParameterReadonly = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterReadonlyMapping(_0), input2]);
var ParameterOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterOptionalMapping(_0), input2]);
var ParameterType = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type2(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ParameterTypeMapping(_0), input2]);
var ParameterBase = (input) => If(If(ParameterReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterReadonly(input), ([_0, input2]) => [_0, input2], () => If(ParameterOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterType(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ParameterBaseMapping(_0), input2]);
var Parameter2 = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ParameterBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ParameterBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterMapping(_0), input2]);
var ParameterList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Parameter2(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ParameterList_0(input2, [...result, _0]), () => [result, input]);
var ParameterList = (input) => If(If(If(Parameter2(input), ([_0, input2]) => If(ParameterList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterListMapping(_0), input2]);
var _Function_2 = (input) => If(If(Const("(", input), ([_0, input2]) => If(ParameterList(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => If(Const("=>", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_Function_Mapping(_0), input2]);
var _Constructor_ = (input) => If(If(Const("new", input), ([_0, input2]) => If(Const("(", input2), ([_1, input3]) => If(ParameterList(input3), ([_2, input4]) => If(Const(")", input4), ([_3, input5]) => If(Const("=>", input5), ([_4, input6]) => If(Type2(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_Constructor_Mapping(_0), input2]);
var MappedReadonly = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedReadonlyMapping(_0), input2]);
var MappedOptional = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedOptionalMapping(_0), input2]);
var MappedAs = (input) => If(If(If(Const("as", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [MappedAsMapping(_0), input2]);
var _Mapped_ = (input) => If(If(Const("{", input), ([_0, input2]) => If(MappedReadonly(input2), ([_1, input3]) => If(Const("[", input3), ([_2, input4]) => If(Ident(input4), ([_3, input5]) => If(Const("in", input5), ([_4, input6]) => If(Type2(input6), ([_5, input7]) => If(MappedAs(input7), ([_6, input8]) => If(Const("]", input8), ([_7, input9]) => If(MappedOptional(input9), ([_8, input10]) => If(Const(":", input10), ([_9, input11]) => If(Type2(input11), ([_10, input12]) => If(OptionalSemiColon(input12), ([_11, input13]) => If(Const("}", input13), ([_12, input14]) => [[_0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12], input14]))))))))))))), ([_0, input2]) => [_Mapped_Mapping(_0), input2]);
var Reference = (input) => If(Ident(input), ([_0, input2]) => [ReferenceMapping(_0), input2]);
var WithBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [WithBigIntMapping(_0), input2]);
var WithNumber = (input) => If(Number3(input), ([_0, input2]) => [WithNumberMapping(_0), input2]);
var WithBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithBooleanMapping(_0), input2]);
var WithString = (input) => If(String3(['"', "'"], input), ([_0, input2]) => [WithStringMapping(_0), input2]);
var WithNull = (input) => If(Const("null", input), ([_0, input2]) => [WithNullMapping(_0), input2]);
var WithUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [WithUndefinedMapping(_0), input2]);
var WithProperty = (input) => If(If(PropertyKey(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(WithValue(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithPropertyMapping(_0), input2]);
var WithPropertyList_0 = (input, result = []) => If(If(PropertyDelimiter(input), ([_0, input2]) => If(WithProperty(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithPropertyList_0(input2, [...result, _0]), () => [result, input]);
var WithPropertyList = (input) => If(If(If(WithProperty(input), ([_0, input2]) => If(WithPropertyList_0(input2), ([_1, input3]) => If(If(PropertyDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithPropertyListMapping(_0), input2]);
var WithObject = (input) => If(If(Const("{", input), ([_0, input2]) => If(WithPropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithObjectMapping(_0), input2]);
var WithElementList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(WithValue(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithElementList_0(input2, [...result, _0]), () => [result, input]);
var WithElementList = (input) => If(If(If(WithValue(input), ([_0, input2]) => If(WithElementList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithElementListMapping(_0), input2]);
var WithArray = (input) => If(If(Const("[", input), ([_0, input2]) => If(WithElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithArrayMapping(_0), input2]);
var WithValue = (input) => If(If(WithBigInt(input), ([_0, input2]) => [_0, input2], () => If(WithNumber(input), ([_0, input2]) => [_0, input2], () => If(WithBoolean(input), ([_0, input2]) => [_0, input2], () => If(WithString(input), ([_0, input2]) => [_0, input2], () => If(WithNull(input), ([_0, input2]) => [_0, input2], () => If(WithUndefined(input), ([_0, input2]) => [_0, input2], () => If(WithObject(input), ([_0, input2]) => [_0, input2], () => If(WithArray(input), ([_0, input2]) => [_0, input2], () => [])))))))), ([_0, input2]) => [WithValueMapping(_0), input2]);
var PatternBigInt = (input) => If(Const("-?(?:0|[1-9][0-9]*)n", input), ([_0, input2]) => [PatternBigIntMapping(_0), input2]);
var PatternString = (input) => If(Const(".*", input), ([_0, input2]) => [PatternStringMapping(_0), input2]);
var PatternNumber = (input) => If(Const("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", input), ([_0, input2]) => [PatternNumberMapping(_0), input2]);
var PatternInteger = (input) => If(Const("-?(?:0|[1-9][0-9]*)", input), ([_0, input2]) => [PatternIntegerMapping(_0), input2]);
var PatternNever = (input) => If(Const("(?!)", input), ([_0, input2]) => [PatternNeverMapping(_0), input2]);
var PatternText = (input) => If(Until_1(["-?(?:0|[1-9][0-9]*)n", ".*", "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", "-?(?:0|[1-9][0-9]*)", "(?!)", "(", ")", "$", "|"], input), ([_0, input2]) => [PatternTextMapping(_0), input2]);
var PatternBase = (input) => If(If(PatternBigInt(input), ([_0, input2]) => [_0, input2], () => If(PatternString(input), ([_0, input2]) => [_0, input2], () => If(PatternNumber(input), ([_0, input2]) => [_0, input2], () => If(PatternInteger(input), ([_0, input2]) => [_0, input2], () => If(PatternNever(input), ([_0, input2]) => [_0, input2], () => If(PatternGroup(input), ([_0, input2]) => [_0, input2], () => If(PatternText(input), ([_0, input2]) => [_0, input2], () => []))))))), ([_0, input2]) => [PatternBaseMapping(_0), input2]);
var PatternGroup = (input) => If(If(Const("(", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternGroupMapping(_0), input2]);
var PatternUnion = (input) => If(If(If(PatternTerm(input), ([_0, input2]) => If(Const("|", input2), ([_1, input3]) => If(PatternUnion(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(PatternTerm(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [PatternUnionMapping(_0), input2]);
var PatternTerm = (input) => If(If(PatternBase(input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PatternTermMapping(_0), input2]);
var PatternBody = (input) => If(If(PatternUnion(input), ([_0, input2]) => [_0, input2], () => If(PatternTerm(input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PatternBodyMapping(_0), input2]);
var Pattern = (input) => If(If(Const("^", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const("$", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternMapping(_0), input2]);
var InterfaceDeclarationHeritageList_0 = (input, result = []) => If(If(Const(",", input), ([_0, input2]) => If(Type2(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => InterfaceDeclarationHeritageList_0(input2, [...result, _0]), () => [result, input]);
var InterfaceDeclarationHeritageList = (input) => If(If(If(Type2(input), ([_0, input2]) => If(InterfaceDeclarationHeritageList_0(input2), ([_1, input3]) => If(If(Const(",", input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageListMapping(_0), input2]);
var InterfaceDeclarationHeritage = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(InterfaceDeclarationHeritageList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageMapping(_0), input2]);
var InterfaceDeclarationGeneric = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(InterfaceDeclarationHeritage(input4), ([_3, input5]) => If(Properties(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [InterfaceDeclarationGenericMapping(_0), input2]);
var InterfaceDeclaration = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(InterfaceDeclarationHeritage(input3), ([_2, input4]) => If(Properties(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [InterfaceDeclarationMapping(_0), input2]);
var TypeAliasDeclarationGeneric = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type2(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [TypeAliasDeclarationGenericMapping(_0), input2]);
var TypeAliasDeclaration = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("=", input3), ([_2, input4]) => If(Type2(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [TypeAliasDeclarationMapping(_0), input2]);
var ExportKeyword = (input) => If(If(If(Const("export", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExportKeywordMapping(_0), input2]);
var ModuleDeclarationDelimiter = (input) => If(If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ModuleDeclarationDelimiterMapping(_0), input2]);
var ModuleDeclarationList_0 = (input, result = []) => If(If(ModuleDeclarationDelimiter(input), ([_0, input2]) => If(ModuleDeclaration(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ModuleDeclarationList_0(input2, [...result, _0]), () => [result, input]);
var ModuleDeclarationList = (input) => If(If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList_0(input2), ([_1, input3]) => If(If(ModuleDeclarationDelimiter(input3), ([_02, input4]) => [[_02], input4], () => [[], input3]), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ModuleDeclarationListMapping(_0), input2]);
var ModuleDeclaration = (input) => If(If(ExportKeyword(input), ([_0, input2]) => If(If(InterfaceDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(InterfaceDeclaration(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclaration(input2), ([_02, input3]) => [_02, input3], () => [])))), ([_1, input3]) => If(OptionalSemiColon(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ModuleDeclarationMapping(_0), input2]);
var Module = (input) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleMapping(_0), input2]);
var Script = (input) => If(If(Module(input), ([_0, input2]) => [_0, input2], () => If(GenericType(input), ([_0, input2]) => [_0, input2], () => If(Type2(input), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ScriptMapping(_0), input2]);

// node_modules/typebox/build/type/engine/patterns/template.mjs
function ParseTemplateIntoTypes(template) {
  const parsed = TemplateLiteralTypes(`\`${template}\``);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/encode.mjs
function JoinString(input) {
  return input.join("|");
}
function UnwrapTemplateLiteralPattern(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function EncodeLiteral(value, right, pattern) {
  return EncodeTypes(right, `${pattern}${value}`);
}
function EncodeBigInt(right, pattern) {
  return EncodeTypes(right, `${pattern}${BigIntPattern}`);
}
function EncodeInteger(right, pattern) {
  return EncodeTypes(right, `${pattern}${IntegerPattern}`);
}
function EncodeNumber(right, pattern) {
  return EncodeTypes(right, `${pattern}${NumberPattern}`);
}
function EncodeBoolean(right, pattern) {
  return EncodeType(Union([Literal("false"), Literal("true")]), right, pattern);
}
function EncodeString(right, pattern) {
  return EncodeTypes(right, `${pattern}${StringPattern}`);
}
function EncodeTemplateLiteral(templatePattern, right, pattern) {
  return EncodeTypes(right, `${pattern}${UnwrapTemplateLiteralPattern(templatePattern)}`);
}
function EncodeTemplateLiteralDeferred(types, right, pattern) {
  const templateLiteral = TemplateLiteralAction(types, {});
  const result = EncodeType(templateLiteral, right, pattern);
  return result;
}
function EncodeEnum(values, right, pattern) {
  const evaluated = EvaluateEnum(values);
  return EncodeType(evaluated, right, pattern);
}
function EncodeUnion(types, right, pattern, result = []) {
  return guard_exports.ShiftLeft(types, (head, tail) => EncodeUnion(tail, right, pattern, [...result, EncodeType(head, [], "")]), () => EncodeTypes(right, `${pattern}(${JoinString(result)})`));
}
function EncodeType(type, right, pattern) {
  return IsEnum(type) ? EncodeEnum(type.enum, right, pattern) : IsInteger2(type) ? EncodeInteger(right, pattern) : IsLiteral(type) ? EncodeLiteral(type.const, right, pattern) : IsBigInt2(type) ? EncodeBigInt(right, pattern) : IsBoolean3(type) ? EncodeBoolean(right, pattern) : IsNumber3(type) ? EncodeNumber(right, pattern) : IsString3(type) ? EncodeString(right, pattern) : IsTemplateLiteral(type) ? EncodeTemplateLiteral(type.pattern, right, pattern) : IsTemplateLiteralDeferred(type) ? EncodeTemplateLiteralDeferred(type.parameters[0], right, pattern) : IsUnion(type) ? EncodeUnion(type.anyOf, right, pattern) : NeverPattern;
}
function EncodeTypes(types, pattern) {
  return guard_exports.ShiftLeft(types, (left, right) => EncodeType(left, right, pattern), () => pattern);
}
function EncodePattern(types) {
  const encoded = EncodeTypes(types, "");
  const result = `^${encoded}$`;
  return result;
}
function TemplateLiteralEncode(types) {
  const pattern = EncodePattern(types);
  const result = TemplateLiteralCreate(pattern);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/instantiate.mjs
function TemplateLiteralAction(types, options) {
  const result = CanInstantiate(types) ? memory_exports.Update(TemplateLiteralEncode(types), {}, options) : TemplateLiteralDeferred(types, options);
  return result;
}
function TemplateLiteralInstantiate(context, state, types, options) {
  const instantiatedTypes = InstantiateTypes(context, state, types);
  return TemplateLiteralAction(instantiatedTypes, options);
}

// node_modules/typebox/build/type/types/template_literal.mjs
function TemplateLiteralDeferred(types, options = {}) {
  return Deferred("TemplateLiteral", [types], options);
}
function IsTemplateLiteralDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "TemplateLiteral");
}
function TemplateLiteralFromTypes(types) {
  return TemplateLiteralAction(types, {});
}
function TemplateLiteralFromString(template) {
  const types = ParseTemplateIntoTypes(template);
  return TemplateLiteralFromTypes(types);
}
function TemplateLiteral2(input, options = {}) {
  const type = guard_exports.IsString(input) ? TemplateLiteralFromString(input) : TemplateLiteralFromTypes(input);
  return memory_exports.Update(type, {}, options);
}
function IsTemplateLiteral(value) {
  return IsKind(value, "TemplateLiteral");
}

// node_modules/typebox/build/type/extends/result.mjs
var result_exports = {};
__export(result_exports, {
  ExtendsFalse: () => ExtendsFalse,
  ExtendsTrue: () => ExtendsTrue,
  ExtendsUnion: () => ExtendsUnion,
  IsExtendsFalse: () => IsExtendsFalse,
  IsExtendsTrue: () => IsExtendsTrue,
  IsExtendsTrueLike: () => IsExtendsTrueLike,
  IsExtendsUnion: () => IsExtendsUnion,
  Match: () => Match3
});
function ExtendsUnion(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsUnion" }, { inferred });
}
function IsExtendsUnion(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsUnion") && guard_exports.IsObject(value.inferred);
}
function ExtendsTrue(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsTrue" }, { inferred });
}
function IsExtendsTrue(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsTrue") && guard_exports.IsObject(value.inferred);
}
function ExtendsFalse() {
  return memory_exports.Create({ ["~kind"]: "ExtendsFalse" }, {});
}
function IsExtendsFalse(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], "ExtendsFalse");
}
function IsExtendsTrueLike(value) {
  return IsExtendsUnion(value) || IsExtendsTrue(value);
}
function Match3(result, true_, false_) {
  return IsExtendsTrueLike(result) ? true_(result.inferred) : false_();
}

// node_modules/typebox/build/type/extends/extends_right.mjs
function ExtendsRightInfer(inferred, name, left, right) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => ExtendsTrue(memory_exports.Assign(memory_exports.Assign(inferred, checkInferred), { [name]: left })), () => ExtendsFalse());
}
function ExtendsRightAny(inferred, _left) {
  return ExtendsTrue(inferred);
}
function ExtendsRightDependent(inferred, left, if_, then_, else_) {
  return Match3(ExtendsLeft(inferred, left, if_), (inferred2) => Match3(ExtendsLeft(inferred2, left, then_), (inferred3) => ExtendsTrue(inferred3), () => ExtendsFalse()), () => Match3(ExtendsLeft(inferred, left, else_), (inferred2) => ExtendsTrue(inferred2), () => ExtendsFalse()));
}
function ExtendsRightEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightIntersect(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsRightIntersect(inferred2, left, tail), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsRightTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightUnion(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsRightUnion(inferred, left, tail)), () => ExtendsFalse());
}
function ExtendsRight(inferred, left, right) {
  return IsAny(right) ? ExtendsRightAny(inferred, left) : IsDependent(right) ? ExtendsRightDependent(inferred, left, right.if, right.then, right.else) : IsEnum(right) ? ExtendsRightEnum(inferred, left, right.enum) : IsInfer(right) ? ExtendsRightInfer(inferred, right.name, left, right.extends) : IsIntersect(right) ? ExtendsRightIntersect(inferred, left, right.allOf) : IsTemplateLiteral(right) ? ExtendsRightTemplateLiteral(inferred, left, right.pattern) : IsUnion(right) ? ExtendsRightUnion(inferred, left, right.anyOf) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/any.mjs
function ExtendsAny(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsUnion(inferred);
}

// node_modules/typebox/build/type/extends/array.mjs
function ExtendsImmutable(left, right) {
  const isImmutableLeft = IsImmutable(left);
  const isImmutableRight = IsImmutable(right);
  return isImmutableLeft && isImmutableRight ? true : !isImmutableLeft && isImmutableRight ? true : isImmutableLeft && !isImmutableRight ? false : true;
}
function ExtendsArray(inferred, arrayLeft, left, right) {
  return IsArray2(right) ? ExtendsImmutable(arrayLeft, right) ? ExtendsLeft(inferred, left, right.items) : ExtendsFalse() : ExtendsRight(inferred, arrayLeft, right);
}

// node_modules/typebox/build/type/extends/bigint.mjs
function ExtendsBigInt(inferred, left, right) {
  return IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/boolean.mjs
function ExtendsBoolean(inferred, left, right) {
  return IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/parameters.mjs
function ParameterCompare(inferred, left, leftRest, right, rightRest) {
  const checkLeft = IsInfer(right) ? left : right;
  const checkRight = IsInfer(right) ? right : left;
  const isLeftOptional = IsOptional(left);
  const isRightOptional = IsOptional(right);
  return !isLeftOptional && isRightOptional ? ExtendsFalse() : Match3(ExtendsLeft(inferred, checkLeft, checkRight), (inferred2) => ExtendsParameters(inferred2, leftRest, rightRest), () => ExtendsFalse());
}
function ParameterRight(inferred, left, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ParameterCompare(inferred, left, leftRest, head, tail), () => IsOptional(left) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function ParametersLeft(inferred, left, rightRest) {
  return guard_exports.ShiftLeft(left, (head, tail) => ParameterRight(inferred, head, tail, rightRest), () => ExtendsTrue(inferred));
}
function ExtendsParameters(inferred, left, right) {
  return ParametersLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/return_type.mjs
function ExtendsReturnType(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/constructor.mjs
function ExtendsConstructor(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsConstructor2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["instanceType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/dependent.mjs
function ExtendsDependent(inferred, if_, then_, else_, right) {
  return Match3(ExtendsLeft(inferred, if_, right), () => ExtendsLeft(inferred, then_, right), () => ExtendsLeft(inferred, else_, right));
}

// node_modules/typebox/build/type/extends/enum.mjs
function ExtendsEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/function.mjs
function ExtendsFunction(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsFunction2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["returnType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/integer.mjs
function ExtendsInteger(inferred, left, right) {
  return IsInteger2(right) ? ExtendsTrue(inferred) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/intersect.mjs
function ExtendsIntersect(inferred, left, right) {
  const evaluated = EvaluateIntersect(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/literal.mjs
function ExtendsLiteralValue(inferred, left, right) {
  return left === right ? ExtendsTrue(inferred) : ExtendsFalse();
}
function ExtendsLiteralBigInt(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralBoolean(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralNumber(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralString(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteral(inferred, left, right) {
  return guard_exports.IsBigInt(left.const) ? ExtendsLiteralBigInt(inferred, left.const, right) : guard_exports.IsBoolean(left.const) ? ExtendsLiteralBoolean(inferred, left.const, right) : guard_exports.IsNumber(left.const) ? ExtendsLiteralNumber(inferred, left.const, right) : guard_exports.IsString(left.const) ? ExtendsLiteralString(inferred, left.const, right) : Unreachable();
}

// node_modules/typebox/build/type/extends/never.mjs
function ExtendsNever(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : ExtendsTrue(inferred);
}

// node_modules/typebox/build/type/extends/null.mjs
function ExtendsNull(inferred, left, right) {
  return IsNull2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/number.mjs
function ExtendsNumber(inferred, left, right) {
  return IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/object.mjs
function ExtendsPropertyOptional(inferred, left, right) {
  return IsOptional(left) ? IsOptional(right) ? ExtendsTrue(inferred) : ExtendsFalse() : ExtendsTrue(inferred);
}
function ExtendsProperty(inferred, left, right) {
  return (
    // Right TInfer<TNever> is TExtendsFalse
    IsInfer(right) && IsNever(right.extends) ? ExtendsFalse() : Match3(ExtendsLeft(inferred, left, right), (inferred2) => ExtendsPropertyOptional(inferred2, left, right), () => ExtendsFalse())
  );
}
function ExtractInferredProperties(keys, properties) {
  return keys.reduce((result, key) => {
    return key in properties ? IsExtendsTrueLike(properties[key]) ? { ...result, ...properties[key].inferred } : Unreachable() : Unreachable();
  }, {});
}
function ExtendsPropertiesComparer(inferred, left, right) {
  const properties = {};
  for (const rightKey of guard_exports.Keys(right)) {
    properties[rightKey] = rightKey in left ? ExtendsProperty({}, left[rightKey], right[rightKey]) : IsOptional(right[rightKey]) ? IsInfer(right[rightKey]) ? ExtendsTrue(memory_exports.Assign(inferred, { [right[rightKey].name]: right[rightKey].extends })) : ExtendsTrue(inferred) : ExtendsFalse();
  }
  const checked = guard_exports.Values(properties).every((result) => IsExtendsTrueLike(result));
  const extracted = checked ? ExtractInferredProperties(guard_exports.Keys(properties), properties) : {};
  return checked ? ExtendsTrue(extracted) : ExtendsFalse();
}
function ExtendsProperties(inferred, left, right) {
  const compared = ExtendsPropertiesComparer(inferred, left, right);
  return IsExtendsTrueLike(compared) ? ExtendsTrue(memory_exports.Assign(inferred, compared.inferred)) : ExtendsFalse();
}
function ExtendsObjectToObject(inferred, left, right) {
  return ExtendsProperties(inferred, left, right);
}
function RecordMergeInferred(left, right) {
  return guard_exports.Keys(right).reduce((result, key) => {
    return {
      ...result,
      [key]: guard_exports.HasPropertyKey(left, key) ? IsUnion(result[key]) ? Union([...result[key].anyOf, right[key]]) : Union([left[key], right[key]]) : right[key]
    };
  }, left);
}
function ExtendsRecordComparer(properties, keys, type, result) {
  return guard_exports.ShiftLeft(keys, (left, right) => Match3(ExtendsLeft({}, properties[left], type), (inferred) => ExtendsRecordComparer(properties, right, type, RecordMergeInferred(result, inferred)), () => ExtendsFalse()), () => ExtendsTrue(result));
}
function ExtendsObjectToRecord(inferred, properties, _pattern, value) {
  const keys = guard_exports.Keys(properties);
  const result = ExtendsRecordComparer(properties, keys, value, inferred);
  return result;
}
function ExtendsObject(inferred, left, right) {
  return IsRecord(right) ? ExtendsObjectToRecord(inferred, left, RecordPattern(right), RecordValue(right)) : IsObject2(right) ? ExtendsObjectToObject(inferred, left, right.properties) : ExtendsRight(inferred, _Object_(left), right);
}

// node_modules/typebox/build/type/extends/record.mjs
function FromObject2(inferred, properties) {
  return guard_exports.IsEqual(guard_exports.Keys(properties).length, 0) ? ExtendsTrue(inferred) : ExtendsFalse();
}
function FromRecord(inferred, _leftKey, leftValue, _rightKey, rightValue) {
  return ExtendsLeft(inferred, leftValue, rightValue);
}
function ExtendsRecord(inferred, leftPattern, leftValue, right) {
  return IsRecord(right) ? FromRecord(inferred, RecordPatternToType(leftPattern), leftValue, RecordPatternToType(RecordPattern(right)), RecordValue(right)) : IsObject2(right) ? FromObject2(inferred, right.properties) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/string.mjs
function ExtendsString(inferred, left, right) {
  return IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/symbol.mjs
function ExtendsSymbol(inferred, left, right) {
  return IsSymbol2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/template_literal.mjs
function ExtendsTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/inference.mjs
function Inferrable(name, type) {
  return memory_exports.Create({ "~kind": "Inferrable" }, { name, type }, {});
}
function IsInferable(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "name") && guard_exports.HasPropertyKey(value, "type") && guard_exports.IsEqual(value["~kind"], "Inferrable") && guard_exports.IsString(value.name) && guard_exports.IsObject(value.type);
}
function TryRestInferable(type) {
  return IsRest(type) ? IsInfer(type.items) ? IsArray2(type.items.extends) ? Inferrable(type.items.name, type.items.extends.items) : IsUnknown(type.items.extends) ? Inferrable(type.items.name, type.items.extends) : void 0 : Unreachable() : void 0;
}
function TryInferable(type) {
  return IsInfer(type) ? Inferrable(type.name, type.extends) : void 0;
}
function TryInferResults(rest, right, result = []) {
  return guard_exports.ShiftLeft(rest, (head, tail) => Match3(ExtendsLeft({}, head, right), () => TryInferResults(tail, right, [...result, head]), () => void 0), () => result);
}
function InferTupleResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Tuple(results) })) : ExtendsFalse();
}
function InferUnionResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Union(results) })) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/tuple.mjs
function Reverse(types) {
  return [...types].reverse();
}
function ApplyReverse(types, reversed) {
  return reversed ? Reverse(types) : types;
}
function Reversed(types) {
  const first = types.length > 0 ? types[0] : void 0;
  const inferrable = IsSchema(first) ? TryRestInferable(first) : void 0;
  return IsSchema(inferrable);
}
function ElementsCompare(inferred, reversed, left, leftRest, right, rightRest) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => Elements(checkInferred, reversed, leftRest, rightRest), () => ExtendsFalse());
}
function ElementsLeft(inferred, reversed, leftRest, right, rightRest) {
  const inferable = TryRestInferable(right);
  return (
    // Rest Inferrable Right Means we delegate to TInferTupleResult to Generate a Result
    IsInferable(inferable) ? InferTupleResult(inferred, inferable["name"], ApplyReverse(leftRest, reversed), inferable["type"]) : guard_exports.ShiftLeft(leftRest, (head, tail) => ElementsCompare(inferred, reversed, head, tail, right, rightRest), () => ExtendsFalse())
  );
}
function ElementsRight(inferred, reversed, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ElementsLeft(inferred, reversed, leftRest, head, tail), () => guard_exports.IsEqual(leftRest.length, 0) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function Elements(inferred, reversed, leftRest, rightRest) {
  return ElementsRight(inferred, reversed, leftRest, rightRest);
}
function ExtendsTupleToTuple(inferred, left, right) {
  const instantiatedRight = InstantiateElements(inferred, State([], []), right);
  const reversed = Reversed(instantiatedRight);
  return Elements(inferred, reversed, ApplyReverse(left, reversed), ApplyReverse(instantiatedRight, reversed));
}
function ExtendsTupleToArray(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable["name"], left, inferrable["type"]) : guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsLeft(inferred, head, right), (inferred2) => ExtendsTupleToArray(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsTuple(inferred, left, right) {
  const instantiatedLeft = InstantiateElements(inferred, State([], []), left);
  return IsTuple(right) ? ExtendsTupleToTuple(inferred, instantiatedLeft, right.items) : IsArray2(right) ? ExtendsTupleToArray(inferred, instantiatedLeft, right.items) : ExtendsRight(inferred, Tuple(instantiatedLeft), right);
}

// node_modules/typebox/build/type/extends/undefined.mjs
function ExtendsUndefined(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : IsUndefined2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/union.mjs
function ExtendsUnionSome(inferred, type, unionTypes) {
  return guard_exports.ShiftLeft(unionTypes, (head, tail) => Match3(ExtendsLeft(inferred, type, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsUnionSome(inferred, type, tail)), () => ExtendsFalse());
}
function ExtendsUnionLeft(inferred, left, right) {
  return guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsUnionSome(inferred, head, right), (inferred2) => ExtendsUnionLeft(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsUnion2(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable.name, left, inferrable.type) : IsUnion(right) ? ExtendsUnionLeft(inferred, left, right.anyOf) : ExtendsUnionLeft(inferred, left, [right]);
}

// node_modules/typebox/build/type/extends/unknown.mjs
function ExtendsUnknown(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/void.mjs
function ExtendsVoid(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/extends_left.mjs
function ExtendsLeft(inferred, left, right) {
  return IsAny(left) ? ExtendsAny(inferred, left, right) : IsArray2(left) ? ExtendsArray(inferred, left, left.items, right) : IsBigInt2(left) ? ExtendsBigInt(inferred, left, right) : IsBoolean3(left) ? ExtendsBoolean(inferred, left, right) : IsConstructor2(left) ? ExtendsConstructor(inferred, left.parameters, left.instanceType, right) : IsDependent(left) ? ExtendsDependent(inferred, left.if, left.then, left.else, right) : IsEnum(left) ? ExtendsEnum(inferred, left.enum, right) : IsFunction2(left) ? ExtendsFunction(inferred, left.parameters, left.returnType, right) : IsInteger2(left) ? ExtendsInteger(inferred, left, right) : IsIntersect(left) ? ExtendsIntersect(inferred, left.allOf, right) : IsLiteral(left) ? ExtendsLiteral(inferred, left, right) : IsNever(left) ? ExtendsNever(inferred, left, right) : IsNull2(left) ? ExtendsNull(inferred, left, right) : IsNumber3(left) ? ExtendsNumber(inferred, left, right) : IsObject2(left) ? ExtendsObject(inferred, left.properties, right) : IsRecord(left) ? ExtendsRecord(inferred, RecordPattern(left), RecordValue(left), right) : IsString3(left) ? ExtendsString(inferred, left, right) : IsSymbol2(left) ? ExtendsSymbol(inferred, left, right) : IsTemplateLiteral(left) ? ExtendsTemplateLiteral(inferred, left.pattern, right) : IsTuple(left) ? ExtendsTuple(inferred, left.items, right) : IsUndefined2(left) ? ExtendsUndefined(inferred, left, right) : IsUnion(left) ? ExtendsUnion2(inferred, left.anyOf, right) : IsUnknown(left) ? ExtendsUnknown(inferred, left, right) : IsVoid(left) ? ExtendsVoid(inferred, left, right) : ExtendsFalse();
}

// node_modules/typebox/build/type/engine/interface/instantiate.mjs
function InterfaceOperation(heritage, properties) {
  const result = EvaluateIntersect([...heritage, _Object_(properties)]);
  return result;
}
function InterfaceAction(heritage, properties, options) {
  const result = CanInstantiate(heritage) ? memory_exports.Update(InterfaceOperation(heritage, properties), {}, options) : InterfaceDeferred(heritage, properties, options);
  return result;
}
function InterfaceInstantiate(context, state, heritage, properties, options) {
  const instantiatedHeritage = InstantiateTypes(context, state, heritage);
  const instantiatedProperties = InstantiateProperties(context, state, properties);
  return InterfaceAction(instantiatedHeritage, instantiatedProperties, options);
}

// node_modules/typebox/build/type/action/interface.mjs
function InterfaceDeferred(heritage, properties, options = {}) {
  return Deferred("Interface", [heritage, properties], options);
}
function IsInterfaceDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "Interface");
}
function Interface(heritage, properties, options = {}) {
  return InterfaceAction(heritage, properties, options);
}

// node_modules/typebox/build/type/engine/cyclic/check.mjs
function FromRef(stack, context, ref) {
  return stack.includes(ref) ? true : FromType3([...stack, ref], context, context[ref]);
}
function FromProperties(stack, context, properties) {
  const types = PropertyValues(properties);
  return FromTypes2(stack, context, types);
}
function FromTypes2(stack, context, types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType3(stack, context, left) ? true : FromTypes2(stack, context, right), () => false);
}
function FromType3(stack, context, type) {
  return IsRef(type) ? FromRef(stack, context, type.$ref) : IsArray2(type) ? FromType3(stack, context, type.items) : IsConstructor2(type) ? FromTypes2(stack, context, [...type.parameters, type.instanceType]) : IsFunction2(type) ? FromTypes2(stack, context, [...type.parameters, type.returnType]) : IsInterfaceDeferred(type) ? FromProperties(stack, context, type.parameters[1]) : IsIntersect(type) ? FromTypes2(stack, context, type.allOf) : IsObject2(type) ? FromProperties(stack, context, type.properties) : IsUnion(type) ? FromTypes2(stack, context, type.anyOf) : IsTuple(type) ? FromTypes2(stack, context, type.items) : IsRecord(type) ? FromType3(stack, context, RecordValue(type)) : false;
}
function CyclicCheck(stack, context, type) {
  const result = FromType3(stack, context, type);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/candidates.mjs
function ResolveCandidateKeys(context, keys) {
  return keys.reduce((result, left) => {
    return CyclicCheck([left], context, context[left]) ? [...result, left] : result;
  }, []);
}
function CyclicCandidates(context) {
  const keys = PropertyKeys(context);
  const result = ResolveCandidateKeys(context, keys);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/dependencies.mjs
function FromRef2(context, ref, result) {
  return result.includes(ref) ? result : ref in context ? FromType4(context, context[ref], [...result, ref]) : Unreachable();
}
function FromProperties2(context, properties, result) {
  const types = PropertyValues(properties);
  return FromTypes3(context, types, result);
}
function FromTypes3(context, types, result) {
  return types.reduce((result2, left) => {
    return FromType4(context, left, result2);
  }, result);
}
function FromType4(context, type, result) {
  return IsRef(type) ? FromRef2(context, type.$ref, result) : IsArray2(type) ? FromType4(context, type.items, result) : IsConstructor2(type) ? FromTypes3(context, [...type.parameters, type.instanceType], result) : IsFunction2(type) ? FromTypes3(context, [...type.parameters, type.returnType], result) : IsInterfaceDeferred(type) ? FromProperties2(context, type.parameters[1], result) : IsIntersect(type) ? FromTypes3(context, type.allOf, result) : IsObject2(type) ? FromProperties2(context, type.properties, result) : IsUnion(type) ? FromTypes3(context, type.anyOf, result) : IsTuple(type) ? FromTypes3(context, type.items, result) : IsRecord(type) ? FromType4(context, RecordValue(type), result) : result;
}
function CyclicDependencies(context, key, type) {
  const result = FromType4(context, type, [key]);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/extends.mjs
function FromRef3(_ref) {
  return Any();
}
function FromProperties3(properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType5(properties[key]) };
  }, {});
}
function FromTypes4(types) {
  return types.reduce((result, left) => {
    return [...result, FromType5(left)];
  }, []);
}
function FromType5(type) {
  return IsRef(type) ? FromRef3(type.$ref) : IsArray2(type) ? _Array_(FromType5(type.items), ArrayOptions(type)) : IsConstructor2(type) ? Constructor(FromTypes4(type.parameters), FromType5(type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes4(type.parameters), FromType5(type.returnType)) : IsIntersect(type) ? Intersect(FromTypes4(type.allOf)) : IsObject2(type) ? _Object_(FromProperties3(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType5(RecordValue(type))) : IsUnion(type) ? Union(FromTypes4(type.anyOf)) : IsTuple(type) ? Tuple(FromTypes4(type.items)) : type;
}
function CyclicAnyFromParameters(defs, ref) {
  return ref in defs ? FromType5(defs[ref]) : Unknown();
}
function CyclicExtends(type) {
  return CyclicAnyFromParameters(type.$defs, type.$ref);
}

// node_modules/typebox/build/type/engine/cyclic/instantiate.mjs
function CyclicInterface(context, heritage, properties) {
  const instantiatedHeritage = InstantiateTypes(context, State([], []), heritage);
  const instantiatedProperties = InstantiateProperties({}, State([], []), properties);
  const evaluatedInterface = EvaluateIntersect([...instantiatedHeritage, _Object_(instantiatedProperties)]);
  return evaluatedInterface;
}
function CyclicDefinitions(context, dependencies) {
  const keys = guard_exports.Keys(context).filter((key) => dependencies.includes(key));
  return keys.reduce((result, key) => {
    const type = context[key];
    const instantiatedType = IsInterfaceDeferred(type) ? CyclicInterface(context, type.parameters[0], type.parameters[1]) : type;
    return { ...result, [key]: instantiatedType };
  }, {});
}
function InstantiateCyclic(context, ref, type) {
  const dependencies = CyclicDependencies(context, ref, type);
  const definitions = CyclicDefinitions(context, dependencies);
  const result = Cyclic(definitions, ref);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/target.mjs
function Resolve(defs, ref) {
  return ref in defs ? IsRef(defs[ref]) ? Resolve(defs, defs[ref].$ref) : defs[ref] : Never();
}
function CyclicTarget(defs, ref) {
  const result = Resolve(defs, ref);
  return result;
}

// node_modules/typebox/build/type/extends/extends.mjs
function Canonical(type) {
  return IsCyclic(type) ? CyclicExtends(type) : IsUnsafe(type) ? Unknown() : type;
}
function Extends(inferred, left, right) {
  const canonicalLeft = Canonical(left);
  const canonicalRight = Canonical(right);
  return ExtendsLeft(inferred, canonicalLeft, canonicalRight);
}

// node_modules/typebox/build/type/engine/evaluate/compare.mjs
var CompareResultEqual = 0;
var CompareResultDisjoint = 1;
var CompareResultLeftInside = 2;
var CompareResultRightInside = 3;
function Compare(left, right) {
  const extendsCheck = [Extends({}, left, right), Extends({}, right, left)];
  return result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? CompareResultEqual : result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsFalse(extendsCheck[1]) ? CompareResultLeftInside : result_exports.IsExtendsFalse(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? CompareResultRightInside : CompareResultDisjoint;
}

// node_modules/typebox/build/type/engine/evaluate/broaden.mjs
function BroadenFilter(type, types, result = [], all = types) {
  return guard_exports.ShiftLeft(types, (left, right) => {
    const compare = Compare(type, left);
    return guard_exports.IsEqual(compare, CompareResultLeftInside) || guard_exports.IsEqual(compare, CompareResultEqual) ? all : guard_exports.IsEqual(compare, CompareResultDisjoint) ? BroadenFilter(type, right, [...result, left], all) : BroadenFilter(type, right, result, all);
  }, () => [...result, type]);
}
function BroadenType(type, types, result) {
  const evaluated = EvaluateType(type);
  return IsAny(evaluated) ? [evaluated] : (
    // terminate (always the most broad)
    IsUnknown(evaluated) ? [evaluated] : (
      // terminate (always the most broad)
      IsNever(evaluated) ? BroadenTypes(types, result) : (
        // ignored: never is dropped
        IsObject2(evaluated) ? BroadenTypes(types, [...result, evaluated]) : (
          // objects are always considered (too expensive to compare)
          BroadenTypes(types, BroadenFilter(evaluated, result))
        )
      )
    )
  );
}
function BroadenTypes(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => BroadenType(left, right, result), () => result);
}
function Broaden(types) {
  const broadened = BroadenTypes(types);
  const flattened = Flatten(broadened);
  return flattened;
}

// node_modules/typebox/build/type/engine/evaluate/instantiate.mjs
function EvaluateAction(type, options) {
  const result = memory_exports.Update(EvaluateType(type), {}, options);
  return result;
}
function EvaluateInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return EvaluateAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/call/distribute_arguments.mjs
function CollectDistributionNames(expression, result = []) {
  return (
    // Conditional
    IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? IsRef(expression.parameters[0]) ? CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], [...result, expression.parameters[0]["$ref"]])) : CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], result)) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? IsDeferred(expression.parameters[1]) && guard_exports.IsEqual(expression.parameters[1].action, "KeyOf") && IsRef(expression.parameters[1].parameters[0]) ? [...result, expression.parameters[1].parameters[0]["$ref"]] : result : result
  );
}
function BuildDistributionArray(parameters, names) {
  return parameters.reduce((result, left) => [...result, names.includes(left.name)], []);
}
function ZipDistributionArray(arguments_, distributionArray, result = []) {
  return guard_exports.ShiftLeft(arguments_, (argumentLeft, argumentRight) => guard_exports.ShiftLeft(distributionArray, (booleanLeft, booleanRight) => ZipDistributionArray(argumentRight, booleanRight, [...result, [booleanLeft, argumentLeft]]), () => result), () => result);
}
function CanonicalArgument(type) {
  return IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsEnum(type) ? EvaluateEnum(type.enum) : type;
}
function Expand(type) {
  const canonicalArgument = CanonicalArgument(type);
  return IsUnion(canonicalArgument) ? [...canonicalArgument.anyOf] : [canonicalArgument];
}
function Append(current, type) {
  return current.reduce((result, left) => [...result, [...left, type]], []);
}
function Cross(current, variants) {
  return variants.reduce((result, left) => {
    return [...result, ...Append(current, left)];
  }, []);
}
function Distribute2(zipped) {
  return zipped.reduce((result, left) => {
    return guard_exports.IsEqual(left[0], true) ? Cross(result, Expand(left[1])) : Cross(result, [left[1]]);
  }, [[]]);
}
function DistributeArguments(parameters, arguments_, expression) {
  const distributionNames = CollectDistributionNames(expression);
  const distributionArray = BuildDistributionArray(parameters, distributionNames);
  const zippedArguments = ZipDistributionArray(arguments_, distributionArray);
  return IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? Distribute2(zippedArguments) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? Distribute2(zippedArguments) : [arguments_];
}

// node_modules/typebox/build/type/engine/call/resolve_target.mjs
function FromNotResolvable() {
  return ["(not-resolvable)", Never()];
}
function FromNotGeneric() {
  return ["(not-generic)", Never()];
}
function FromGeneric(name, parameters, expression) {
  return [name, Generic(parameters, expression)];
}
function FromRef4(context, ref, arguments_) {
  return ref in context ? FromType6(context, ref, context[ref], arguments_) : FromNotResolvable();
}
function FromType6(context, name, target, arguments_) {
  return IsGeneric(target) ? FromGeneric(name, target.parameters, target.expression) : IsRef(target) ? FromRef4(context, target.$ref, arguments_) : FromNotGeneric();
}
function ResolveTarget(context, target, arguments_) {
  return FromType6(context, "(anonymous)", target, arguments_);
}

// node_modules/typebox/build/type/engine/call/resolve_arguments.mjs
function AssertArgumentExtends(name, type, extends_) {
  if (IsInfer(type) || IsCall(type) || result_exports.IsExtendsTrueLike(Extends({}, type, extends_)))
    return;
  const cause = { parameter: name, expect: extends_, actual: type };
  throw new Error(`Argument for parameter ${name} does not satisfy constraint`, { cause });
}
function BindArgument(context, state, name, extends_, type) {
  const instantiatedArgument = InstantiateType(context, state, type);
  AssertArgumentExtends(name, instantiatedArgument, extends_);
  return memory_exports.Assign(context, { [name]: instantiatedArgument });
}
function BindArguments(context, state, parameterLeft, parameterRight, arguments_) {
  const instantiatedExtends = InstantiateType(context, state, parameterLeft.extends);
  const instantiatedEquals = InstantiateType(context, state, parameterLeft.equals);
  return guard_exports.ShiftLeft(arguments_, (left, right) => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, left), state, parameterRight, right), () => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, instantiatedEquals), state, parameterRight, []));
}
function BindParameters(context, state, parameters, arguments_) {
  return guard_exports.ShiftLeft(parameters, (left, right) => BindArguments(context, state, left, right, arguments_), () => context);
}
function ResolveArgumentsContext(context, state, parameters, arguments_) {
  return BindParameters(context, state, parameters, arguments_);
}

// node_modules/typebox/build/type/engine/call/instantiate.mjs
var instantiationDepth = 0;
var instantiationCount = 0;
function InstantiationAssert() {
  if (guard_exports.IsLessThan(instantiationCount, settings_exports.Get().maxInstantiationCount))
    return;
  throw Error("Type instantiation is excessively deep and possibly infinite");
}
function InstantiationIncrement() {
  InstantiationAssert();
  instantiationCount++;
  instantiationDepth++;
}
function InstantiationDecrement() {
  instantiationDepth--;
  if (guard_exports.IsEqual(instantiationDepth, 0))
    instantiationCount = 0;
}
function Peek(state) {
  const result = guard_exports.IsGreaterThan(state.callstack.length, 0) ? state.callstack[state.callstack.length - 1] : "";
  return result;
}
function IsTailCall(state, name) {
  const result = guard_exports.IsEqual(Peek(state), name);
  return result;
}
function CallDispatch(context, state, target, parameters, expression, arguments_) {
  InstantiationIncrement();
  try {
    const argumentsContext = ResolveArgumentsContext(context, state, parameters, arguments_);
    const returnType = InstantiateType(argumentsContext, State([...state["callstack"], target["$ref"]], state["visited"]), expression);
    return InstantiateType(argumentsContext, State([], []), returnType);
  } finally {
    InstantiationDecrement();
  }
}
function CallDistributed(context, state, target, parameters, expression, distributedArguments) {
  return distributedArguments.reduce((result, arguments_) => {
    const returnType = CallDispatch(context, state, target, parameters, expression, arguments_);
    return [...result, returnType];
  }, []);
}
function CallImmediate(context, state, target, parameters, expression, arguments_) {
  const distributedArguments = DistributeArguments(parameters, arguments_, expression);
  const returnTypes = CallDistributed(context, state, target, parameters, expression, distributedArguments);
  const result = guard_exports.IsEqual(returnTypes.length, 1) ? returnTypes[0] : EvaluateUnion(returnTypes);
  return result;
}
function CallInstantiate(context, state, target, arguments_) {
  const instantiatedArguments = InstantiateTypes(context, state, arguments_);
  const resolved = ResolveTarget(context, target, arguments_);
  const name = resolved[0];
  const type = resolved[1];
  const result = IsGeneric(type) ? IsTailCall(state, name) ? CallConstruct(Ref(name), instantiatedArguments) : CallImmediate(context, state, Ref(name), type.parameters, type.expression, instantiatedArguments) : CallConstruct(target, instantiatedArguments);
  return result;
}

// node_modules/typebox/build/type/types/call.mjs
function CallConstruct(target, arguments_) {
  return memory_exports.Create({ ["~kind"]: "Call" }, { type: "call", target, arguments: arguments_ }, {});
}
function Call(target, arguments_) {
  return CallInstantiate({}, State([], []), target, arguments_);
}
function IsCall(value) {
  return IsKind(value, "Call");
}

// node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs
function RemoveImmutableOperation(type) {
  return memory_exports.Discard(type, ["~immutable"]);
}
function RemoveImmutableAction(type, options) {
  const result = memory_exports.Update(RemoveImmutableOperation(type), {}, options);
  return result;
}
function RemoveImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/intrinsics/mapping.mjs
function ApplyMapping(mapping, value) {
  return mapping(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs
function FromLiteral3(mapping, value) {
  return guard_exports.IsString(value) ? Literal(ApplyMapping(mapping, value)) : Literal(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs
function FromTemplateLiteral(mapping, pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType7(mapping, evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/intrinsics/from_union.mjs
function FromUnion2(mapping, types) {
  const result = types.map((type) => FromType7(mapping, type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/intrinsics/from_type.mjs
function FromType7(mapping, type) {
  return IsLiteral(type) ? FromLiteral3(mapping, type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) : IsUnion(type) ? FromUnion2(mapping, type.anyOf) : type;
}

// node_modules/typebox/build/type/action/capitalize.mjs
function CapitalizeDeferred(type, options = {}) {
  return Deferred("Capitalize", [type], options);
}
function Capitalize(type, options = {}) {
  return CapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/lowercase.mjs
function LowercaseDeferred(type, options = {}) {
  return Deferred("Lowercase", [type], options);
}
function Lowercase(type, options = {}) {
  return LowercaseAction(type, options);
}

// node_modules/typebox/build/type/action/uncapitalize.mjs
function UncapitalizeDeferred(type, options = {}) {
  return Deferred("Uncapitalize", [type], options);
}
function Uncapitalize(type, options = {}) {
  return UncapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/uppercase.mjs
function UppercaseDeferred(type, options = {}) {
  return Deferred("Uppercase", [type], options);
}
function Uppercase(type, options = {}) {
  return UppercaseAction(type, options);
}

// node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs
var CapitalizeMapping = (input) => input[0].toUpperCase() + input.slice(1);
var LowercaseMapping = (input) => input.toLowerCase();
var UncapitalizeMapping = (input) => input[0].toLowerCase() + input.slice(1);
var UppercaseMapping = (input) => input.toUpperCase();
function CapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(CapitalizeMapping, type), {}, options) : CapitalizeDeferred(type, options);
  return result;
}
function LowercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(LowercaseMapping, type), {}, options) : LowercaseDeferred(type, options);
  return result;
}
function UncapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UncapitalizeMapping, type), {}, options) : UncapitalizeDeferred(type, options);
  return result;
}
function UppercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UppercaseMapping, type), {}, options) : UppercaseDeferred(type, options);
  return result;
}
function CapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return CapitalizeAction(instantiatedType, options);
}
function LowercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return LowercaseAction(instantiatedType, options);
}
function UncapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UncapitalizeAction(instantiatedType, options);
}
function UppercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UppercaseAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/conditional.mjs
function ConditionalDeferred(left, right, true_, false_, options = {}) {
  return Deferred("Conditional", [left, right, true_, false_], options);
}
function Conditional(left, right, true_, false_, options = {}) {
  return ConditionalAction({}, State([], []), left, right, true_, false_, options);
}

// node_modules/typebox/build/type/engine/conditional/instantiate.mjs
function ConditionalOperation(context, state, left, right, true_, false_) {
  const extendsResult = Extends(context, left, right);
  return result_exports.IsExtendsUnion(extendsResult) ? Union([InstantiateType(extendsResult.inferred, state, true_), InstantiateType(context, state, false_)]) : result_exports.IsExtendsTrue(extendsResult) ? InstantiateType(extendsResult.inferred, state, true_) : InstantiateType(context, state, false_);
}
function ConditionalAction(context, state, left, right, true_, false_, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ConditionalOperation(context, state, left, right, true_, false_), {}, options) : ConditionalDeferred(left, right, true_, false_, options);
  return result;
}
function ConditionalInstantiate(context, state, left, right, true_, false_, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ConditionalAction(context, state, instantiatedLeft, instantiatedRight, true_, false_, options);
}

// node_modules/typebox/build/type/action/constructor_parameters.mjs
function ConstructorParametersDeferred(type, options = {}) {
  return Deferred("ConstructorParameters", [type], options);
}
function ConstructorParameters(type, options = {}) {
  return ConstructorParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs
function ConstructorParametersOperation(type) {
  const parameters = IsConstructor2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ConstructorParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ConstructorParametersOperation(type), {}, options) : ConstructorParametersDeferred(type, options);
  return result;
}
function ConstructorParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ConstructorParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/exclude.mjs
function ExcludeDeferred(left, right, options = {}) {
  return Deferred("Exclude", [left, right], options);
}
function Exclude(left, right, options = {}) {
  return ExcludeAction(left, right, options);
}

// node_modules/typebox/build/type/engine/exclude/instantiate.mjs
function ExcludeAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExcludeOperation(left, right), {}, options) : ExcludeDeferred(left, right, options);
  return result;
}
function ExcludeInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExcludeAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/action/extract.mjs
function ExtractDeferred(left, right, options = {}) {
  return Deferred("Extract", [left, right], options);
}
function Extract(left, right, options = {}) {
  return ExtractAction(left, right, options);
}

// node_modules/typebox/build/type/engine/extract/operation.mjs
function ExtractType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [left] : [];
  return result;
}
function ExtractUnion(left, right, result = []) {
  return guard_exports.ShiftLeft(left, (head, tail) => ExtractUnion(tail, right, [...result, ...ExtractType(head, right)]), () => result);
}
function ExtractOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExtractUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/extract/instantiate.mjs
function ExtractAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExtractOperation(left, right), {}, options) : ExtractDeferred(left, right, options);
  return result;
}
function ExtractInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExtractAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs
function KeysToLiterals(keys) {
  return keys.reduce((result, left) => {
    return IsLiteralValue(left) ? [...result, Literal(left)] : result;
  }, []);
}
function KeysToIndexer(keys) {
  const literals = KeysToLiterals(keys);
  const result = Union(literals);
  return result;
}

// node_modules/typebox/build/type/action/indexed.mjs
function IndexDeferred(type, indexer, options = {}) {
  return Deferred("Index", [type, indexer], options);
}
function Index(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return IndexAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/object/from_cyclic.mjs
function FromCyclic(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType8(target);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_dependent.mjs
function FromDependent(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType8(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_intersect.mjs
function CollapseIntersectProperties(left, right) {
  const leftKeys = guard_exports.Keys(left).filter((key) => !guard_exports.HasPropertyKey(right, key));
  const rightKeys = guard_exports.Keys(right).filter((key) => !guard_exports.HasPropertyKey(left, key));
  const sharedKeys = guard_exports.Keys(left).filter((key) => guard_exports.HasPropertyKey(right, key));
  const leftProperties = leftKeys.reduce((result, key) => ({ ...result, [key]: left[key] }), {});
  const rightProperties = rightKeys.reduce((result, key) => ({ ...result, [key]: right[key] }), {});
  const sharedProperties = sharedKeys.reduce((result, key) => ({ ...result, [key]: EvaluateIntersect([left[key], right[key]]) }), {});
  const unique = memory_exports.Assign(leftProperties, rightProperties);
  const shared = memory_exports.Assign(unique, sharedProperties);
  return shared;
}
function FromIntersect(types) {
  return types.reduce((result, left) => {
    return CollapseIntersectProperties(result, FromType8(left));
  }, {});
}

// node_modules/typebox/build/type/engine/object/from_object.mjs
function FromObject3(properties) {
  return properties;
}

// node_modules/typebox/build/type/engine/object/from_tuple.mjs
function FromTuple(types) {
  const object = TupleToObject(Tuple(types));
  const result = FromType8(object);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_union.mjs
function CollapseUnionProperties(left, right) {
  const sharedKeys = guard_exports.Keys(left).filter((key) => key in right);
  const result = sharedKeys.reduce((result2, key) => {
    return { ...result2, [key]: EvaluateUnion([left[key], right[key]]) };
  }, {});
  return result;
}
function ReduceVariants(types, result) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, CollapseUnionProperties(result, FromType8(left))), () => result);
}
function FromUnion3(types) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, FromType8(left)), () => Unreachable());
}

// node_modules/typebox/build/type/engine/object/from_type.mjs
function FromType8(type) {
  return IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) : IsDependent(type) ? FromDependent(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect(type.allOf) : IsUnion(type) ? FromUnion3(type.anyOf) : IsTuple(type) ? FromTuple(type.items) : IsObject2(type) ? FromObject3(type.properties) : {};
}

// node_modules/typebox/build/type/engine/object/collapse.mjs
function CollapseToObject(type) {
  const properties = FromType8(type);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/helpers/keys.mjs
var integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");
function ConvertToIntegerKey(value) {
  const normal = `${value}`;
  return integerKeyPattern.test(normal) ? parseInt(normal) : value;
}

// node_modules/typebox/build/type/engine/indexed/from_array.mjs
function NormalizeLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function NormalizeIndexerTypes(types) {
  return types.map((type) => NormalizeIndexer(type));
}
function NormalizeIndexer(type) {
  return IsIntersect(type) ? Intersect(NormalizeIndexerTypes(type.allOf)) : IsUnion(type) ? Union(NormalizeIndexerTypes(type.anyOf)) : IsLiteral(type) ? NormalizeLiteral(type.const) : type;
}
function FromArray2(type, indexer) {
  const normalizedIndexer = NormalizeIndexer(indexer);
  const check = Extends({}, normalizedIndexer, Number2());
  const result = (
    // indexer
    result_exports.IsExtendsTrueLike(check) ? type : IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Number2() : Never()
  );
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs
function FromCyclic2(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType9(target);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_dependent.mjs
function FromDependent2(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_enum.mjs
function FromEnum(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_intersect.mjs
function FromIntersect2(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_literal.mjs
function FromLiteral4(value) {
  const result = [`${value}`];
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs
function FromTemplateLiteral2(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_union.mjs
function FromUnion4(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType9(left)];
  }, []);
}

// node_modules/typebox/build/type/engine/indexable/from_type.mjs
function FromType9(type) {
  return IsCyclic(type) ? FromCyclic2(type.$defs, type.$ref) : IsDependent(type) ? FromDependent2(type.if, type.then, type.else) : IsEnum(type) ? FromEnum(type.enum) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsLiteral(type) ? FromLiteral4(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral2(type.pattern) : IsUnion(type) ? FromUnion4(type.anyOf) : [];
}

// node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs
function ToIndexableKeys(type) {
  const result = FromType9(type);
  return result;
}

// node_modules/typebox/build/type/engine/this/expand_this.mjs
function FromTypes5(properties, types) {
  return types.map((type) => FromType10(properties, type));
}
function FromType10(properties, type) {
  return IsArray2(type) ? _Array_(FromType10(properties, type.items)) : IsConstructor2(type) ? Constructor(FromTypes5(properties, type.parameters), FromType10(properties, type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes5(properties, type.parameters), FromType10(properties, type.returnType)) : IsTuple(type) ? Tuple(FromTypes5(properties, type.items)) : IsUnion(type) ? Union(FromTypes5(properties, type.anyOf)) : IsIntersect(type) ? Intersect(FromTypes5(properties, type.allOf)) : IsThis(type) ? _Object_(properties) : type;
}
function ExpandThis(properties, type) {
  const result = FromType10(properties, type);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/from_object.mjs
function IndexProperty(properties, key) {
  const selectedType = key in properties ? properties[key] : Never();
  const result = ExpandThis(properties, selectedType);
  return result;
}
function IndexProperties(properties, keys) {
  return keys.reduce((result, left) => {
    return [...result, IndexProperty(properties, left)];
  }, []);
}
function FromIndexer(properties, indexer) {
  const keys = ToIndexableKeys(indexer);
  const variants = IndexProperties(properties, keys);
  const result = EvaluateUnion(variants);
  return result;
}
var NumericKeyPattern = new RegExp(IntegerKey);
function NumericKeys(keys) {
  const result = keys.filter((key) => NumericKeyPattern.test(key));
  return result;
}
function FromIndexerNumber(properties) {
  const keys = PropertyKeys(properties);
  const numericKeys = NumericKeys(keys);
  const variants = IndexProperties(properties, numericKeys);
  const result = EvaluateUnion(variants);
  return result;
}
function FromObject4(properties, indexer) {
  const result = IsNumber3(indexer) ? FromIndexerNumber(properties) : FromIndexer(properties, indexer);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/array_indexer.mjs
function ConvertLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function ArrayIndexerTypes(types) {
  return types.map((type) => FormatArrayIndexer(type));
}
function FormatArrayIndexer(type) {
  return IsIntersect(type) ? Intersect(ArrayIndexerTypes(type.allOf)) : IsUnion(type) ? Union(ArrayIndexerTypes(type.anyOf)) : IsLiteral(type) ? ConvertLiteral(type.const) : type;
}

// node_modules/typebox/build/type/engine/indexed/from_tuple.mjs
function IndexElementsWithIndexer(types, indexer) {
  return types.reduceRight((result, right, index) => {
    const check = Extends({}, Literal(index), indexer);
    return result_exports.IsExtendsTrueLike(check) ? [right, ...result] : result;
  }, []);
}
function FromTupleWithIndexer(types, indexer) {
  const formattedArrayIndexer = FormatArrayIndexer(indexer);
  const elements = IndexElementsWithIndexer(types, formattedArrayIndexer);
  return EvaluateUnionFast(elements);
}
function FromTupleWithoutIndexer(types) {
  return EvaluateUnionFast(types);
}
function FromTuple2(types, indexer) {
  return (
    // length (intrinsic)
    IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Literal(types.length) : IsNumber3(indexer) || IsInteger2(indexer) ? FromTupleWithoutIndexer(types) : FromTupleWithIndexer(types, indexer)
  );
}

// node_modules/typebox/build/type/engine/indexed/from_type.mjs
function FromType11(type, indexer) {
  return IsArray2(type) ? FromArray2(type.items, indexer) : IsObject2(type) ? FromObject4(type.properties, indexer) : IsTuple(type) ? FromTuple2(type.items, indexer) : Never();
}

// node_modules/typebox/build/type/engine/indexed/instantiate.mjs
function NormalizeType(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function IndexAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType11(NormalizeType(type), indexer), {}, options) : IndexDeferred(type, indexer, options);
  return result;
}
function IndexInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return IndexAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/instance_type.mjs
function InstanceTypeDeferred(type, options = {}) {
  return Deferred("InstanceType", [type], options);
}
function InstanceType(type, options = {}) {
  return InstanceTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/instance_type/instantiate.mjs
function InstanceTypeOperation(type) {
  return IsConstructor2(type) ? type["instanceType"] : Never();
}
function InstanceTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(InstanceTypeOperation(type), {}, options) : InstanceTypeDeferred(type, options);
  return result;
}
function InstanceTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return InstanceTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/keyof.mjs
function KeyOfDeferred(type, options = {}) {
  return Deferred("KeyOf", [type], options);
}
function KeyOf2(type, options = {}) {
  return KeyOfAction(type, options);
}

// node_modules/typebox/build/type/engine/keyof/from_any.mjs
function FromAny() {
  return Union([Number2(), String2(), Symbol2()]);
}

// node_modules/typebox/build/type/engine/keyof/from_array.mjs
function FromArray3(_type) {
  return Number2();
}

// node_modules/typebox/build/type/engine/keyof/from_object.mjs
function FromPropertyKeys(keys) {
  const result = keys.reduce((result2, left) => {
    return IsLiteralValue(left) ? [...result2, Literal(ConvertToIntegerKey(left))] : Unreachable();
  }, []);
  return result;
}
function FromObject5(properties) {
  const propertyKeys = guard_exports.Keys(properties);
  const variants = FromPropertyKeys(propertyKeys);
  const result = EvaluateUnionFast(variants);
  return result;
}

// node_modules/typebox/build/type/engine/keyof/from_record.mjs
function FromRecord2(type) {
  return RecordKey(type);
}

// node_modules/typebox/build/type/engine/keyof/from_tuple.mjs
function FromTuple3(types) {
  const result = types.map((_, index) => Literal(index));
  return EvaluateUnionFast(result);
}

// node_modules/typebox/build/type/engine/keyof/from_type.mjs
function FromType12(type) {
  return IsAny(type) ? FromAny() : IsArray2(type) ? FromArray3(type.items) : IsObject2(type) ? FromObject5(type.properties) : IsRecord(type) ? FromRecord2(type) : IsTuple(type) ? FromTuple3(type.items) : Never();
}

// node_modules/typebox/build/type/engine/keyof/instantiate.mjs
function NormalizeType2(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function KeyOfAction(type, options) {
  return CanInstantiate([type]) ? memory_exports.Update(FromType12(NormalizeType2(type)), {}, options) : KeyOfDeferred(type, options);
}
function KeyOfInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return KeyOfAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/mapped.mjs
function MappedDeferred(identifier, type, as, property, options = {}) {
  return Deferred("Mapped", [identifier, type, as, property], options);
}
function Mapped(identifier, type, as, property, options = {}) {
  return MappedAction({}, State([], []), identifier, type, as, property, options);
}

// node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs
function FromTemplateLiteral3(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType13(evaluated);
  return result;
}
function FromUnion5(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType13(left)];
  }, []);
}
function FromEnum2(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType13(evaluated);
  return result;
}
function FromLiteral5(value) {
  const result = guard_exports.IsNumber(value) ? [Literal(`${value}`)] : [Literal(value)];
  return result;
}
function FromType13(type) {
  const result = IsEnum(type) ? FromEnum2(type.enum) : IsLiteral(type) ? FromLiteral5(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral3(type.pattern) : IsUnion(type) ? FromUnion5(type.anyOf) : [type];
  return result;
}
function MappedVariants(type) {
  const result = FromType13(type);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs
function CanonicalAs(instantiatedAs) {
  const result = IsTemplateLiteral(instantiatedAs) ? EvaluateTemplateLiteral(instantiatedAs.pattern) : instantiatedAs;
  return result;
}
function MappedVariant(context, state, identifier, variant, as, property) {
  const variantContext = memory_exports.Assign(context, { [identifier["name"]]: variant });
  const instantiatedAs = InstantiateType(variantContext, state, as);
  const canonicalAs = CanonicalAs(instantiatedAs);
  const instantiatedProperty = InstantiateType(variantContext, state, property);
  return IsLiteralNumber(canonicalAs) || IsLiteralString(canonicalAs) ? { [canonicalAs.const]: instantiatedProperty } : {};
}
function MappedProperties(context, state, identifier, variants, as, property) {
  return variants.reduce((result, left) => {
    return [...result, MappedVariant(context, state, identifier, left, as, property)];
  }, []);
}
function MappedObjects(properties) {
  return properties.reduce((result, left) => {
    return [...result, _Object_(left)];
  }, []);
}
function MappedOperation(context, state, identifier, type, as, property) {
  const variants = MappedVariants(type);
  const mappedProperties = MappedProperties(context, state, identifier, variants, as, property);
  const mappedObjects = MappedObjects(mappedProperties);
  const result = EvaluateIntersect(mappedObjects);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/instantiate.mjs
function MappedAction(context, state, identifier, type, as, property, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(MappedOperation(context, state, identifier, type, as, property), {}, options) : MappedDeferred(identifier, type, as, property, options);
  return result;
}
function MappedInstantiate(context, state, identifier, type, as, property, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return MappedAction(context, state, identifier, instantiatedType, as, property, options);
}

// node_modules/typebox/build/type/engine/module/instantiate.mjs
function InstantiateCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateCyclic(declarationContext, key, declarations[key]) };
  }, {});
}
function InstantiateNonCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => !cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateType(declarationContext, State([], []), declarations[key]) };
  }, {});
}
function InstantiateModule(context, declarations, options) {
  const cyclicCandidates = CyclicCandidates(declarations);
  const instantiatedCyclics = InstantiateCyclics(context, declarations, cyclicCandidates);
  const instantiatedNonCyclics = InstantiateNonCyclics(context, declarations, cyclicCandidates);
  const instantiatedModule = { ...instantiatedCyclics, ...instantiatedNonCyclics };
  return memory_exports.Update(instantiatedModule, {}, options);
}
function ModuleInstantiate(context, _state, declarations, options) {
  const instantiatedModule = InstantiateModule(context, declarations, options);
  return instantiatedModule;
}

// node_modules/typebox/build/type/action/non_nullable.mjs
function NonNullableDeferred(type, options = {}) {
  return Deferred("NonNullable", [type], options);
}
function NonNullable(type, options = {}) {
  return NonNullableAction(type, options);
}

// node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs
function NonNullableOperation(type) {
  const excluded = Union([Null(), Undefined()]);
  return ExcludeAction(type, excluded, {});
}
function NonNullableAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(NonNullableOperation(type), {}, options) : NonNullableDeferred(type, options);
  return result;
}
function NonNullableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return NonNullableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/omit.mjs
function OmitDeferred(type, indexer, options = {}) {
  return Deferred("Omit", [type, indexer], options);
}
function Omit(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return OmitAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/indexable/to_indexable.mjs
function ToIndexable(type) {
  const collapsed = CollapseToObject(type);
  const result = IsObject2(collapsed) ? collapsed.properties : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/omit/from_type.mjs
function FromKeys(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? result2 : { ...result2, [key]: properties[key] };
  }, {});
  return result;
}
function FromType14(type, indexer) {
  const indexable = ToIndexable(type);
  const indexableKeys = ToIndexableKeys(indexer);
  const omitted = FromKeys(indexable, indexableKeys);
  const result = _Object_(omitted);
  return result;
}

// node_modules/typebox/build/type/engine/omit/instantiate.mjs
function OmitAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType14(type, indexer), {}, options) : OmitDeferred(type, indexer, options);
  return result;
}
function OmitInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return OmitAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/parameters.mjs
function ParametersDeferred(type, options = {}) {
  return Deferred("Parameters", [type], options);
}
function Parameters(type, options = {}) {
  return ParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/parameters/instantiate.mjs
function ParametersOperation(type) {
  const parameters = IsFunction2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ParametersOperation(type), {}, options) : ParametersDeferred(type, options);
  return result;
}
function ParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/partial.mjs
function PartialDeferred(type, options = {}) {
  return Deferred("Partial", [type], options);
}
function Partial(type, options = {}) {
  return PartialAction(type, options);
}

// node_modules/typebox/build/type/engine/partial/from_cyclic.mjs
function FromCyclic3(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType15(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_dependent.mjs
function FromDependent3(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_intersect.mjs
function FromIntersect3(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_union.mjs
function FromUnion6(types) {
  const result = types.map((type) => FromType15(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/partial/from_object.mjs
function FromObject6(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_type.mjs
function FromType15(type) {
  return IsCyclic(type) ? FromCyclic3(type.$defs, type.$ref) : IsDependent(type) ? FromDependent3(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion6(type.anyOf) : IsObject2(type) ? FromObject6(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/engine/partial/instantiate.mjs
function PartialAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType15(type), {}, options) : PartialDeferred(type, options);
  return result;
}
function PartialInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return PartialAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/pick.mjs
function PickDeferred(type, indexer, options = {}) {
  return Deferred("Pick", [type, indexer], options);
}
function Pick(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return PickAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/pick/from_type.mjs
function FromKeys2(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? memory_exports.Assign(result2, { [key]: properties[key] }) : result2;
  }, {});
  return result;
}
function FromType16(type, indexer) {
  const indexable = ToIndexable(type);
  const keys = ToIndexableKeys(indexer);
  const applied = FromKeys2(indexable, keys);
  const result = _Object_(applied);
  return result;
}

// node_modules/typebox/build/type/engine/pick/instantiate.mjs
function PickAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType16(type, indexer), {}, options) : PickDeferred(type, indexer, options);
  return result;
}
function PickInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return PickAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/readonly_object.mjs
function ReadonlyObjectDeferred(type, options = {}) {
  return Deferred("ReadonlyObject", [type], options);
}
function ReadonlyObject(type, options = {}) {
  return ReadonlyObjectAction(type, options);
}
var ReadonlyType = ReadonlyObject;

// node_modules/typebox/build/type/engine/readonly_object/from_array.mjs
function FromArray4(type) {
  const result = AddImmutable(_Array_(type));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs
function FromCyclic4(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType17(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs
function FromDependent4(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs
function FromIntersect4(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_object.mjs
function FromObject7(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddReadonly(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs
function FromTuple4(types) {
  const result = AddImmutable(Tuple(types));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_union.mjs
function FromUnion7(types) {
  const result = types.map((type) => FromType17(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/readonly_object/from_type.mjs
function FromType17(type) {
  return IsArray2(type) ? FromArray4(type.items) : IsCyclic(type) ? FromCyclic4(type.$defs, type.$ref) : IsDependent(type) ? FromDependent4(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect4(type.allOf) : IsObject2(type) ? FromObject7(type.properties) : IsTuple(type) ? FromTuple4(type.items) : IsUnion(type) ? FromUnion7(type.anyOf) : type;
}

// node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs
function ReadonlyObjectAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType17(type), {}, options) : ReadonlyObjectDeferred(type);
  return result;
}
function ReadonlyObjectInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReadonlyObjectAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/ref/instantiate.mjs
function RefInstantiate(context, state, type, ref) {
  return state.visited.includes(ref) ? type : ref in context ? InstantiateType(context, State(state["callstack"], [...state["visited"], ref]), context[ref]) : type;
}

// node_modules/typebox/build/type/engine/required/from_cyclic.mjs
function FromCyclic5(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType18(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_dependent.mjs
function FromDependent5(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_intersect.mjs
function FromIntersect5(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_union.mjs
function FromUnion8(types) {
  const result = types.map((type) => FromType18(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/required/from_object.mjs
function FromObject8(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: RemoveOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_type.mjs
function FromType18(type) {
  return IsCyclic(type) ? FromCyclic5(type.$defs, type.$ref) : IsDependent(type) ? FromDependent5(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect5(type.allOf) : IsUnion(type) ? FromUnion8(type.anyOf) : IsObject2(type) ? FromObject8(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/action/required.mjs
function RequiredDeferred(type, options = {}) {
  return Deferred("Required", [type], options);
}
function Required(type, options = {}) {
  return RequiredAction(type, options);
}

// node_modules/typebox/build/type/engine/required/instantiate.mjs
function RequiredAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType18(type), {}, options) : RequiredDeferred(type, options);
  return result;
}
function RequiredInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return RequiredAction(instaniatedType, options);
}

// node_modules/typebox/build/type/action/return_type.mjs
function ReturnTypeDeferred(type, options = {}) {
  return Deferred("ReturnType", [type], options);
}
function ReturnType(type, options = {}) {
  return ReturnTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/return_type/instantiate.mjs
function ReturnTypeOperation(type) {
  return IsFunction2(type) ? type["returnType"] : Never();
}
function ReturnTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ReturnTypeOperation(type), {}, options) : ReturnTypeDeferred(type, options);
  return result;
}
function ReturnTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReturnTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/with.mjs
function WithDeferred(type, options) {
  return Deferred("With", [type, options], {});
}
function With2(type, options) {
  return WithAction(type, options);
}

// node_modules/typebox/build/type/engine/with/instantiate.mjs
function WithAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(type, {}, options) : WithDeferred(type, options);
  return result;
}
function WithInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return WithAction(instaniatedType, options);
}

// node_modules/typebox/build/type/engine/rest/spread.mjs
function SpreadElement(type) {
  const result = IsRest(type) ? IsTuple(type.items) ? RestSpread(type.items.items) : IsInfer(type.items) ? [type] : IsRef(type.items) ? [type] : [Never()] : [type];
  return result;
}
function RestSpread(types) {
  const result = types.reduce((result2, left) => {
    return [...result2, ...SpreadElement(left)];
  }, []);
  return result;
}

// node_modules/typebox/build/type/engine/instantiate.mjs
function State(callstack, visited) {
  return { callstack, visited };
}
function CanInstantiate(types) {
  return guard_exports.ShiftLeft(types, (left, right) => IsRef(left) ? false : CanInstantiate(right), () => true);
}
function InstantiateProperties(context, state, properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: InstantiateType(context, state, properties[key]) };
  }, {});
}
function InstantiateElements(context, state, types) {
  const elements = InstantiateTypes(context, state, types);
  const result = RestSpread(elements);
  return result;
}
function InstantiateTypes(context, state, types) {
  return types.map((type) => InstantiateType(context, state, type));
}
function WithModifiers(type, instantiatedType) {
  const withOptional = IsOptional(type) ? AddOptionalAction(instantiatedType, {}) : instantiatedType;
  const withReadonly = IsReadonly(type) ? AddReadonlyAction(withOptional, {}) : withOptional;
  const withImmutable = IsImmutable(type) ? AddImmutableAction(withReadonly, {}) : withReadonly;
  return withImmutable;
}
function InstantiateDeferred(context, state, action, parameters, options) {
  return (
    // Modifiers
    guard_exports.IsEqual(action, "AddImmutable") ? AddImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveImmutable") ? RemoveImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddReadonly") ? AddReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveReadonly") ? RemoveReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddOptional") ? AddOptionalInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveOptional") ? RemoveOptionalInstantiate(context, state, parameters[0], options) : (
      // Actions
      guard_exports.IsEqual(action, "Capitalize") ? CapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Conditional") ? ConditionalInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "ConstructorParameters") ? ConstructorParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Evaluate") ? EvaluateInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Exclude") ? ExcludeInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Extract") ? ExtractInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Index") ? IndexInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "InstanceType") ? InstanceTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Interface") ? InterfaceInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "KeyOf") ? KeyOfInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Lowercase") ? LowercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Mapped") ? MappedInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "Module") ? ModuleInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "NonNullable") ? NonNullableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Pick") ? PickInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Parameters") ? ParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Partial") ? PartialInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Omit") ? OmitInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "ReadonlyObject") ? ReadonlyObjectInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Record") ? RecordInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Required") ? RequiredInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "ReturnType") ? ReturnTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "TemplateLiteral") ? TemplateLiteralInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uncapitalize") ? UncapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uppercase") ? UppercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "With") ? WithInstantiate(context, state, parameters[0], parameters[1]) : Deferred(action, parameters, options)
    )
  );
}
function InstantiateImmediate(context, state, type) {
  const instantiatedType = IsRef(type) ? RefInstantiate(context, state, type, type.$ref) : IsArray2(type) ? _Array_(InstantiateType(context, state, type.items), ArrayOptions(type)) : IsCall(type) ? CallInstantiate(context, state, type.target, type.arguments) : IsConstructor2(type) ? Constructor(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.instanceType), ConstructorOptions(type)) : IsFunction2(type) ? _Function_(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.returnType), FunctionOptions(type)) : IsDependent(type) ? Dependent(InstantiateType(context, state, type.if), InstantiateType(context, state, type.then), InstantiateType(context, state, type.else), DependentOptions(type)) : IsIntersect(type) ? Intersect(InstantiateTypes(context, state, type.allOf), IntersectOptions(type)) : IsObject2(type) ? _Object_(InstantiateProperties(context, state, type.properties), ObjectOptions(type)) : IsRecord(type) ? RecordFromPattern(RecordPattern(type), InstantiateType(context, state, RecordValue(type))) : IsRest(type) ? Rest(InstantiateType(context, state, type.items)) : IsTuple(type) ? Tuple(InstantiateElements(context, state, type.items), TupleOptions(type)) : IsUnion(type) ? Union(InstantiateTypes(context, state, type.anyOf), UnionOptions(type)) : type;
  const withModifiers = WithModifiers(type, instantiatedType);
  return withModifiers;
}
function InstantiateType(context, state, type) {
  const result = IsDeferred(type) ? InstantiateDeferred(context, state, type.action, type.parameters, type.options) : InstantiateImmediate(context, state, type);
  return result;
}
function Instantiate(context, type) {
  return InstantiateType(context, State([], []), type);
}

// node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs
function AddImmutableOperation(type) {
  return memory_exports.Update(type, { "~immutable": true }, {});
}
function AddImmutableAction(type, options) {
  const result = memory_exports.Update(AddImmutableOperation(type), {}, options);
  return result;
}
function AddImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_add_immutable.mjs
function AddImmutableDeferred(type, options = {}) {
  return Deferred("AddImmutable", [type], options);
}
function AddImmutable(type, options = {}) {
  return AddImmutableAction(type, options);
}

// node_modules/typebox/build/type/action/evaluate.mjs
function EvaluateDeferred(type, options = {}) {
  return Deferred("Evaluate", [type], options);
}
function Evaluate(type, options = {}) {
  return EvaluateAction(type, options);
}

// node_modules/typebox/build/type/action/module.mjs
function ModuleDeferred(declarations, options = {}) {
  return Deferred("Module", [declarations], options);
}
function Module2(declarations, options = {}) {
  return ModuleInstantiate({}, State([], []), declarations, options);
}

// node_modules/typebox/build/type/script/script.mjs
function Script2(...args2) {
  const [context, input, options] = arguments_exports.Match(args2, {
    2: (script, options2) => guard_exports.IsString(script) ? [{}, script, options2] : [script, options2, {}],
    3: (context2, script, options2) => [context2, script, options2],
    1: (script) => [{}, script, {}]
  });
  const result = Script(input);
  const parsed = guard_exports.IsArray(result) && guard_exports.IsEqual(result.length, 2) ? InstantiateType(context, State([], []), result[0]) : Never();
  return memory_exports.Update(parsed, {}, options);
}

// node_modules/typebox/build/typebox.mjs
var typebox_exports = {};
__export(typebox_exports, {
  Any: () => Any,
  Array: () => _Array_,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Call: () => Call,
  Capitalize: () => Capitalize,
  Codec: () => Codec,
  Conditional: () => Conditional,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Cyclic: () => Cyclic,
  Decode: () => Decode,
  DecodeBuilder: () => DecodeBuilder,
  Dependent: () => Dependent,
  Encode: () => Encode,
  EncodeBuilder: () => EncodeBuilder,
  Enum: () => Enum,
  Evaluate: () => Evaluate,
  Exclude: () => Exclude,
  Extends: () => Extends,
  ExtendsResult: () => result_exports,
  Extract: () => Extract,
  Function: () => _Function_,
  Generic: () => Generic,
  Identifier: () => Identifier,
  Immutable: () => Immutable,
  Index: () => Index,
  Infer: () => Infer,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Interface: () => Interface,
  Intersect: () => Intersect,
  IsAny: () => IsAny,
  IsArray: () => IsArray2,
  IsBigInt: () => IsBigInt2,
  IsBoolean: () => IsBoolean3,
  IsCall: () => IsCall,
  IsCodec: () => IsCodec,
  IsConstructor: () => IsConstructor2,
  IsCyclic: () => IsCyclic,
  IsDependent: () => IsDependent,
  IsEnum: () => IsEnum,
  IsEnumValue: () => IsEnumValue,
  IsFunction: () => IsFunction2,
  IsGeneric: () => IsGeneric,
  IsIdentifier: () => IsIdentifier,
  IsImmutable: () => IsImmutable,
  IsInfer: () => IsInfer,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect,
  IsKind: () => IsKind,
  IsLiteral: () => IsLiteral,
  IsNever: () => IsNever,
  IsNull: () => IsNull2,
  IsNumber: () => IsNumber3,
  IsObject: () => IsObject2,
  IsOptional: () => IsOptional,
  IsParameter: () => IsParameter,
  IsReadonly: () => IsReadonly,
  IsRecord: () => IsRecord,
  IsRef: () => IsRef,
  IsRefine: () => IsRefine,
  IsRest: () => IsRest,
  IsSchema: () => IsSchema,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol2,
  IsTemplateLiteral: () => IsTemplateLiteral,
  IsThis: () => IsThis,
  IsTuple: () => IsTuple,
  IsUndefined: () => IsUndefined2,
  IsUnion: () => IsUnion,
  IsUnknown: () => IsUnknown,
  IsUnsafe: () => IsUnsafe,
  IsVoid: () => IsVoid,
  KeyOf: () => KeyOf2,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module2,
  Never: () => Never,
  NonNullable: () => NonNullable,
  Null: () => Null,
  Number: () => Number2,
  Object: () => _Object_,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameter: () => Parameter,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Readonly: () => Readonly,
  ReadonlyObject: () => ReadonlyObject,
  ReadonlyType: () => ReadonlyType,
  Record: () => Record,
  RecordKey: () => RecordKey,
  RecordPattern: () => RecordPattern,
  RecordValue: () => RecordValue,
  Ref: () => Ref,
  Refine: () => Refine,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  Script: () => Script2,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral2,
  This: () => This,
  Tuple: () => Tuple,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void,
  With: () => With2
});

// src/contracts/bb-tools.ts
import { z } from "zod";
var bbDynamicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  inputSchema: z.unknown().default({}),
  presentation: z.object({
    label: z.object({
      pending: z.string().optional(),
      completed: z.string().optional()
    }).optional(),
    icon: z.object({ glyph: z.string().optional() }).optional(),
    suppress: z.boolean().optional()
  }).optional()
}).passthrough();
var bbToolCallRequestParamsSchema = z.object({
  threadId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1),
  turnId: z.union([z.string().min(1), z.null()]).default(null),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown().default({})
});
var bbContentItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() })
]);
var bbToolCallResponseSchema = z.object({
  contentItems: z.array(bbContentItemSchema).default([]),
  isError: z.boolean().optional(),
  error: z.object({ message: z.string().optional() }).optional()
}).passthrough();
var bbInteractionRequestParamsSchema = z.object({
  threadId: z.string().min(1).optional(),
  providerThreadId: z.string().min(1),
  turnId: z.union([z.string().min(1), z.null()]).default(null),
  payload: z.object({
    kind: z.enum(["select", "confirm", "input", "editor", "notify"]),
    title: z.string().optional(),
    message: z.string().optional(),
    data: z.unknown().optional()
  })
});

// src/runner/extensions/bb-tools-extension.ts
function createBbDynamicToolsExtension(options) {
  const tools = /* @__PURE__ */ new Map();
  if (options.toolsFilePath && fs.existsSync(options.toolsFilePath)) {
    try {
      const raw = fs.readFileSync(options.toolsFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const toolParsed = bbDynamicToolSchema.safeParse(item);
          if (!toolParsed.success) continue;
          const def = toolParsed.data;
          const schema = def.inputSchema && typeof def.inputSchema === "object" ? typebox_exports.Unsafe(def.inputSchema) : typebox_exports.Object({}, { additionalProperties: true });
          const sourceInfo = {
            type: "synthetic",
            path: options.toolsFilePath,
            name: "bb-dynamic-tools"
          };
          const toolEntry = {
            name: def.name,
            description: def.description ?? "",
            parameters: schema,
            exposure: "both",
            namespace: "bb",
            execute: async (_callId, args2, _ctx) => {
              return options.forwardToolCall(def.name, args2);
            },
            sourceInfo
          };
          toolEntry.definition = toolEntry;
          tools.set(def.name, toolEntry);
        }
      }
    } catch (err) {
      console.warn("[BbToolsExtension] Failed to read tools file:", err);
    }
  }
  return {
    path: options.toolsFilePath ?? "bb-dynamic-tools",
    resolvedPath: options.toolsFilePath ?? "bb-dynamic-tools",
    sourceInfo: {
      type: "synthetic",
      path: options.toolsFilePath ?? "bb-dynamic-tools",
      name: "bb-dynamic-tools"
    },
    handlers: /* @__PURE__ */ new Map(),
    tools,
    messageRenderers: /* @__PURE__ */ new Map(),
    commands: /* @__PURE__ */ new Map(),
    flags: /* @__PURE__ */ new Map(),
    shortcuts: /* @__PURE__ */ new Map()
  };
}

// src/runner/runtime-loader.ts
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// src/runner/codemode-namespaces.ts
var DynamicCodemodeNamespaces = class {
  list = [];
  seen = /* @__PURE__ */ new Set();
  getNamespaces() {
    return this.list;
  }
  registerNamespace(ns) {
    if (this.seen.has(ns.prefix)) {
      const idx = this.list.findIndex((n) => n.prefix === ns.prefix);
      if (idx !== -1) {
        const existing = this.list[idx];
        this.list[idx] = {
          name: ns.name || existing.name,
          prefix: ns.prefix,
          description: ns.description ?? existing.description,
          instructions: ns.instructions ?? existing.instructions
        };
      }
      return;
    }
    this.seen.add(ns.prefix);
    this.list.push(ns);
  }
  registerFromToolDefinitions(toolDefs) {
    for (const def of toolDefs) {
      const match = def.name.match(/^mcp__([a-zA-Z0-9_\-]+?)__/);
      if (match && match[1]) {
        const serverName = match[1];
        const prefix = `mcp__${serverName}__`;
        this.registerNamespace({
          name: def.namespace?.name ?? serverName,
          prefix,
          ...def.namespace?.description ? { description: def.namespace.description } : {},
          ...def.namespace?.instructions ? { instructions: def.namespace.instructions } : {}
        });
      } else if (def.namespace?.name) {
        const name = def.namespace.name;
        const prefix = def.name.startsWith(`${name}__`) ? `${name}__` : def.name.startsWith(`${name}_`) ? `${name}_` : `${name}:`;
        this.registerNamespace({
          name,
          prefix,
          ...def.namespace.description ? { description: def.namespace.description } : {},
          ...def.namespace.instructions ? { instructions: def.namespace.instructions } : {}
        });
      }
    }
  }
};

// src/runner/subagent-policy-ack.ts
import { defineDoc as defineDoc2 } from "@earendil-works/pi-durable";

// src/policy/schema.ts
import { z as z2 } from "zod";
var subagentThinkingLevelSchema = z2.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
var subagentModelReferenceSchema = z2.object({
  provider: z2.string().min(1),
  modelId: z2.string().min(1)
}).strict();
var subagentModelProfileSchema = z2.object({
  model: subagentModelReferenceSchema,
  thinkingLevel: subagentThinkingLevelSchema
}).strict();
var subagentPolicySchema = z2.discriminatedUnion("mode", [
  z2.object({
    mode: z2.literal("inherit"),
    configuredProfile: subagentModelProfileSchema.optional()
  }).strict(),
  z2.object({
    mode: z2.literal("configured"),
    configuredProfile: subagentModelProfileSchema
  }).strict()
]);
var subagentPolicyRecordSchema = z2.object({
  version: z2.literal(1),
  revision: z2.number().int().nonnegative(),
  updatedAt: z2.string().optional(),
  policy: subagentPolicySchema
}).strict();
var subagentPolicySetInputSchema = z2.object({
  policy: subagentPolicySchema,
  expectedRevision: z2.number().int().nonnegative()
}).strict();
var subagentPolicyGetOutputSchema = z2.object({
  record: subagentPolicyRecordSchema
}).strict();
var subagentPolicySetOutputSchema = z2.object({
  record: subagentPolicyRecordSchema
}).strict();

// src/runner/subagent-policy-state.ts
function createSubagentPolicyHolder(options) {
  let currentRecord = options.initialRecord ? subagentPolicyRecordSchema.parse(options.initialRecord) : {
    version: 1,
    revision: 0,
    policy: { mode: "inherit" }
  };
  let writeQueue = Promise.resolve();
  return {
    getRecord() {
      return structuredClone(currentRecord);
    },
    async setRecord(record) {
      const validated = subagentPolicyRecordSchema.parse(record);
      return new Promise((resolve3, reject) => {
        writeQueue = writeQueue.catch(() => {
        }).then(async () => {
          try {
            if (validated.revision < currentRecord.revision) {
              throw new SubagentRevisionConflictError(
                `Revision downgrade rejected: incoming revision ${validated.revision} < current ${currentRecord.revision}`
              );
            }
            if (validated.revision === currentRecord.revision) {
              const currentStr = JSON.stringify(currentRecord);
              const incomingStr = JSON.stringify(validated);
              if (currentStr === incomingStr) {
                resolve3();
                return;
              }
              throw new SubagentRevisionConflictError(
                `Revision conflict: revision ${validated.revision} already exists with different payload`
              );
            }
            await options.persist(validated);
            currentRecord = validated;
            resolve3();
          } catch (error) {
            reject(error);
          }
        });
      });
    }
  };
}

// src/runner/subagent-policy-ack.ts
var SubagentPolicyAckDoc = defineDoc2({
  kind: "durable.subagent-policy-ack",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ record: null })
});
async function loadSubagentPolicyHolder(harness) {
  let initialRecord;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SubagentPolicyAckDoc);
    if (doc.record !== null && doc.record !== void 0) {
      const parsed = subagentPolicyRecordSchema.safeParse(doc.record);
      if (!parsed.success) {
        throw new SubagentPolicyLoadError("Stored subagent policy ACK is corrupted", {
          cause: parsed.error
        });
      }
      initialRecord = parsed.data;
    }
  }, runtimeContext);
  return createSubagentPolicyHolder({
    initialRecord,
    persist: async (record) => {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SubagentPolicyAckDoc);
        doc.record = record;
      }, runtimeContext);
    }
  });
}

// src/runner/runtime-loader.ts
function logRegError(kind, identifier, err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg.includes("already registered") && !msg.includes("duplicate")) {
    console.warn(`[RuntimeLoader] Failed to register ${kind} '${identifier}': ${err instanceof Error ? err.message : String(err)}`);
  }
}
function registerPendingProviders(modelRuntime, runtime) {
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch (err) {
      logRegError("provider", name, err);
    }
  }
  for (const { provider } of runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (err) {
      logRegError("native provider", provider?.id ?? "unknown", err);
    }
  }
  for (const { definition } of runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch (err) {
      logRegError("virtual model", definition?.id ?? "unknown", err);
    }
  }
}
async function loadHarnessEnvironment(location, options, envs) {
  try {
    initTheme();
  } catch (err) {
    console.warn(`[RuntimeLoader] Theme initialization warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.create(location.cwd);
  const extEnv = process.env.PI_ADDITIONAL_EXTENSIONS;
  const extPaths = [
    ...options.cli?.extensions ?? (options.cli?.extension ? [options.cli.extension] : []),
    ...extEnv ? extEnv.split(",").map((s) => s.trim()).filter(Boolean) : []
  ];
  const resourceLoader = new DefaultResourceLoader({
    cwd: location.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: createStandardExtensionFactories(),
    additionalSkillPaths: options.cli?.skills,
    additionalExtensionPaths: extPaths.length > 0 ? extPaths : void 0,
    noExtensions: options.cli?.noGlobalExtensions ?? false
  });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  const toolsFile = options.toolsFilePath ?? options.cli?.toolsFilePath;
  if (toolsFile) {
    const dynamicToolsExt = createBbDynamicToolsExtension({
      toolsFilePath: toolsFile,
      forwardToolCall: options.forwardToolCall ?? (async (name) => ({
        content: [{ type: "text", text: `Tool call ${name} not handled` }],
        isError: true
      }))
    });
    extensionsResult.extensions.push(dynamicToolsExt);
  }
  registerPendingProviders(modelRuntime, extensionsResult.runtime);
  configureHarnessHttp(settingsManager);
  let activeModelRef;
  const getActiveModel = () => {
    if (activeModelRef) return activeModelRef;
    const p = settingsManager.getDefaultProvider();
    const m = settingsManager.getDefaultModel();
    return p && m ? { provider: p, modelId: m } : void 0;
  };
  const dynamicSections = new DynamicPromptSections();
  const dynamicNamespaces = new DynamicCodemodeNamespaces();
  const settings2 = createHarnessSettings(settingsManager, getActiveModel);
  let subagentPolicyHolder;
  const getSubagentPolicy = () => {
    if (!subagentPolicyHolder) {
      throw new Error("Subagent policy accessed before runtime initialization");
    }
    return subagentPolicyHolder.getRecord();
  };
  const codingRegistry = await createCodingRegistry(
    settingsManager,
    location.cwd,
    getSubagentPolicy,
    { ...options.prompt, resourceLoader, dynamicSections },
    dynamicNamespaces,
    options.plugins
  );
  const registry = codingRegistry;
  const pendingReports = [];
  const report = (error) => pendingReports.push(error);
  let liveNoticeForwarder;
  let runnerRef;
  const executeToolFn = createNestedToolExecutor(
    registry,
    () => runnerRef,
    () => envs.env({ cwd: location.cwd })
  );
  const actionsDelegate = {};
  const mounted = await mountExtensionBridge(
    location,
    modelRuntime,
    extensionsResult,
    registry,
    executeToolFn,
    report,
    dynamicSections,
    (level, message) => {
      if (liveNoticeForwarder) {
        liveNoticeForwarder(level, message);
      } else {
        pendingReports.push({ kind: "notice", level, message });
      }
    },
    settingsManager,
    dynamicNamespaces,
    actionsDelegate
  );
  runnerRef = mounted.extensionRunner;
  let harness;
  const sessionCleanup = async () => {
    await codingRegistry.pluginRegistry.teardownAll().catch((err) => {
      console.warn("[RuntimeLoader] Plugin teardown error:", err);
    });
    await mounted.cleanup?.();
  };
  try {
    harness = await Harness.open(
      await openNodeSqliteStorage(location.database),
      { models: modelRuntime, registry, settings: settings2, env: envs.env, onReport: report },
      runtimeContext
    );
    subagentPolicyHolder = await loadSubagentPolicyHolder(harness);
  } catch (error) {
    await Promise.allSettled([
      harness?.close(runtimeContext),
      sessionCleanup()
    ]);
    throw error;
  }
  const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime, options.cli) : void 0;
  if (initial?.model) activeModelRef = initial.model;
  return {
    modelRuntime,
    settingsManager,
    harness,
    subagentPolicyHolder,
    initialModelRef: initial?.model,
    initialThinkingLevel: initial?.thinkingLevel,
    fallbackMessage: initial?.fallbackMessage,
    pendingReports,
    getActiveModel,
    setActiveModelRef: (ref) => {
      activeModelRef = ref;
    },
    cleanup: sessionCleanup,
    extensionRunner: mounted.extensionRunner,
    actionsDelegate,
    dynamicSections,
    setNoticeForwarder: (forwarder) => {
      liveNoticeForwarder = forwarder;
    },
    setActiveTools: mounted.setActiveTools,
    getActiveTools: mounted.getActiveTools
  };
}

// src/runner/runtime-hydration.ts
function hydrateSessionActiveTools(rootAgent, activeEnvState) {
  if (Array.isArray(rootAgent.tools)) {
    activeEnvState.setActiveTools?.(rootAgent.tools.map((t) => t.name));
  }
}
async function loadSummaries(harness, rootId) {
  const summaries = [];
  let cursor;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
    for (const { id } of page.items) summaries.push({ id, label: id === rootId ? "main" : `subagent ${id}`, ...await firstInput(harness, id) });
    cursor = page.next;
  } while (cursor !== void 0);
  return summaries;
}

// src/runner/runtime.ts
async function openDurable(options = {}) {
  const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
  const envs = new ExecutionEnvs(location.cwd);
  let harness;
  let envState;
  try {
    const activeEnvState = await loadHarnessEnvironment(location, options, envs);
    envState = activeEnvState;
    const { modelRuntime, settingsManager } = activeEnvState;
    harness = activeEnvState.harness;
    const initialTools = activeEnvState.extensionRunner?.getActiveTools?.();
    const root = await harness.root(runtimeContext, {
      agent: {
        cwd: location.cwd,
        ...activeEnvState.initialModelRef ? { model: activeEnvState.initialModelRef } : {},
        ...activeEnvState.initialThinkingLevel ? { thinkingLevel: activeEnvState.initialThinkingLevel } : {},
        ...Array.isArray(initialTools) ? { modelTools: initialTools.map((name) => ({ name })) } : {}
      }
    });
    if (!location.created) {
      const rootAgent = await root.agent(runtimeContext);
      if (rootAgent.model) activeEnvState.setActiveModelRef(rootAgent.model);
      hydrateSessionActiveTools(rootAgent, activeEnvState);
      if (options.cli !== void 0) {
        const cli = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
        if (cli.model) {
          activeEnvState.setActiveModelRef(cli.model);
          await root.configure({ model: cli.model, thinkingLevel: cli.thinkingLevel }, runtimeContext);
        } else if (cli.thinkingLevel !== void 0) {
          await root.configure({ thinkingLevel: cli.thinkingLevel }, runtimeContext);
        }
      }
    }
    const summaries = await loadSummaries(harness, root.id);
    const conversation = await root.viewState(runtimeContext);
    const enabled = settingsManager.getEnabledModels();
    const scoped = enabled?.length ? await resolveModelScopeWithDiagnostics(enabled, modelRuntime) : void 0;
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
    for (const report of activeEnvState.pendingReports) {
      if (report && typeof report === "object" && "kind" in report && report.kind === "notice") {
        const nr = report;
        notice(nr.level, nr.message);
      } else {
        notice("warning", report instanceof Error ? report.message : String(report));
      }
    }
    activeEnvState.setNoticeForwarder?.((level, message) => notice(level, message));
    const bindings = new RuntimeBindings(root, conversation, update);
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
    const opened = harness;
    const controller = createDurableController({
      bindings,
      opened,
      modelRuntime,
      getState: () => state,
      notice,
      fail,
      setActiveModelRef: (ref) => activeEnvState.setActiveModelRef(ref),
      extensionRunner: activeEnvState.extensionRunner,
      dynamicSections: activeEnvState.dynamicSections,
      cwd: location.cwd,
      setActiveTools: activeEnvState.setActiveTools,
      getActiveTools: activeEnvState.getActiveTools
    });
    if (activeEnvState.actionsDelegate) {
      activeEnvState.actionsDelegate.onAbort = () => {
        void controller.abort();
      };
      activeEnvState.actionsDelegate.onCompact = (i) => {
        void controller.compact(i);
      };
      activeEnvState.actionsDelegate.isIdle = () => true;
      activeEnvState.actionsDelegate.onSubmitUserMessage = async (content, deliverAs) => {
        await controller.submit(content, deliverAs ?? "followUp");
      };
      activeEnvState.actionsDelegate.onConfigureModelTools = async (tools) => {
        await root.configure({ modelTools: tools.map((name) => ({ name })) }, runtimeContext);
      };
      activeEnvState.actionsDelegate.getContextUsage = () => {
        const doc = state.conversation.docs["pi.agent"] ?? {};
        const p = doc.model?.provider, m = doc.model?.modelId ?? doc.model?.id;
        return { tokens: null, contextWindow: (p && m ? modelRuntime.getModel(p, m)?.contextWindow : void 0) ?? 128e3 };
      };
    }
    const saved = agentOf(state.conversation).model;
    if (!saved) notice("warning", "No model configured; select one with /model.");
    else if (!modelRuntime.getModel(saved.provider, saved.modelId)) {
      notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
    }
    if (activeEnvState.fallbackMessage) notice("info", activeEnvState.fallbackMessage);
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
      subagentPolicyHolder: activeEnvState.subagentPolicyHolder,
      close() {
        return closing ??= closeRuntimeResources([
          () => {
            listeners.clear();
            bindings.close();
          },
          unsubscribeCommits,
          () => opened.close(runtimeContext),
          () => envs.cleanup(runtimeContext),
          () => activeEnvState.cleanup?.(),
          () => location.release()
        ]);
      }
    };
  } catch (error) {
    await envState?.cleanup?.().catch((err) => console.warn("[DurableRuntime] Cleanup extension runner:", err));
    await harness?.close(runtimeContext).catch((err) => console.warn("[DurableRuntime] Cleanup harness:", err));
    await location.release().catch((err) => console.warn("[DurableRuntime] Cleanup location:", err));
    throw error;
  }
}

// src/runner/bridge/durable-contracts.ts
function isAgentDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isUsageDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isToolCallBlock(block) {
  return typeof block === "object" && block !== null && block.type === "toolCall";
}
function isConversationEntryRecord(entry) {
  return typeof entry === "object" && entry !== null;
}

// src/runner/bridge/assistant-message-builder.ts
function extractCumulativeUsage(current) {
  const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
  if (!rawUsageDoc || typeof rawUsageDoc !== "object") {
    return void 0;
  }
  const usageDoc = rawUsageDoc;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let hasUsage = false;
  const accumulate = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const inTok = Number(entry.input ?? 0);
    const outTok = Number(entry.output ?? 0);
    const totTok = Number(entry.totalTokens ?? inTok + outTok);
    const cacheRead = Number(entry.cacheRead ?? 0);
    const cacheWrite = Number(entry.cacheWrite ?? 0);
    if (totTok > 0 || inTok > 0 || outTok > 0 || cacheRead > 0 || cacheWrite > 0) {
      hasUsage = true;
      totalTokens += totTok;
      inputTokens += inTok;
      outputTokens += outTok;
      cachedInputTokens += cacheRead;
      cacheWriteInputTokens += cacheWrite;
    }
  };
  if (usageDoc.models && typeof usageDoc.models === "object") {
    for (const modelUsage of Object.values(usageDoc.models)) {
      accumulate(modelUsage);
    }
  }
  if (usageDoc.tools && typeof usageDoc.tools === "object") {
    for (const toolUsage of Object.values(usageDoc.tools)) {
      accumulate(toolUsage);
    }
  }
  if (!hasUsage && (usageDoc.totalTokens != null || usageDoc.input != null || usageDoc.output != null)) {
    accumulate(usageDoc);
  }
  if (!hasUsage && totalTokens === 0) {
    return void 0;
  }
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    ...cachedInputTokens > 0 ? { cachedInputTokens } : {},
    ...cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}
  };
}
function buildFinalAssistantMessage(current, lastGenerationText, lastThinkingText) {
  const entries = current.conversation.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find(
    (e) => isConversationEntryRecord(e) && e.kind === "pi.assistant"
  );
  const lastAssistantMsg = lastAssistantEntry?.model?.[0];
  if (lastAssistantMsg) {
    const rawErr = lastAssistantMsg.errorMessage;
    const errorMessage = typeof rawErr === "string" ? rawErr : void 0;
    const stopReason = typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : errorMessage ? "error" : "stop";
    let content = Array.isArray(lastAssistantMsg.content) ? lastAssistantMsg.content : [{ type: "text", text: lastGenerationText }];
    if (content.length === 0 && (stopReason === "error" || errorMessage)) {
      content = [{ type: "text", text: errorMessage ? `\u26A0\uFE0F ${errorMessage}` : "An error occurred during turn generation." }];
    }
    const usage = typeof lastAssistantMsg.usage === "object" && lastAssistantMsg.usage !== null ? lastAssistantMsg.usage : void 0;
    return {
      role: "assistant",
      content,
      stopReason,
      ...errorMessage ? { errorMessage } : {},
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
  const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
  const usageDoc = isUsageDocument(rawUsageDoc) ? rawUsageDoc : {};
  const cumUsage = extractCumulativeUsage(current);
  const inTok = cumUsage?.inputTokens ?? usageDoc.input;
  const outTok = cumUsage?.outputTokens ?? usageDoc.output;
  const cacheRead = cumUsage?.cachedInputTokens ?? usageDoc.cacheRead;
  const cacheWrite = cumUsage?.cacheWriteInputTokens ?? usageDoc.cacheWrite;
  const totalTokens = cumUsage?.totalTokens ?? usageDoc.totalTokens ?? (inTok ?? 0) + (outTok ?? 0);
  return {
    role: "assistant",
    content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
    stopReason: "stop",
    usage: {
      input: inTok,
      output: outTok,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: usageDoc.cost
    }
  };
}

// src/runner/bridge/turn-summary.ts
function findSubmissionFault(inputs, submissions, lastTaskError) {
  if (inputs && submissions) {
    for (const id of inputs) {
      const sub = submissions.get(id);
      if (sub && sub.status === "unanswered") {
        const isAborted = sub.reason === "aborted";
        return {
          isAborted,
          isError: !isAborted,
          errorMessage: sub.detail || sub.reason || lastTaskError || "Turn ended with unanswered input"
        };
      }
    }
  }
  if (lastTaskError) {
    return { isAborted: false, isError: true, errorMessage: lastTaskError };
  }
  return void 0;
}
function resolveTurnSummary(current, currentText, currentThinking, lastAssistantMessage, resolveContextWindow, fault) {
  const tail = current?.conversation?.entries?.at(-1);
  const lastCheckpointId = tail?.id !== void 0 ? String(tail.id) : void 0;
  const finalMsg = lastAssistantMessage ?? buildFinalAssistantMessage(
    current,
    currentText,
    currentThinking
  );
  const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
  const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
  const cw = resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
  const cumulativeUsage = extractCumulativeUsage(current);
  const entries = current?.conversation?.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find(
    (e) => isConversationEntryRecord(e) && e.kind === "pi.assistant"
  );
  const firstModelMsg = lastAssistantEntry?.model?.[0];
  const isLastAssistantAborted = Boolean(
    firstModelMsg && "stopReason" in firstModelMsg && firstModelMsg.stopReason === "aborted"
  );
  const isAborted = finalMsg.stopReason === "aborted" || isLastAssistantAborted || Boolean(fault?.isAborted);
  const rawLastErr = firstModelMsg && "errorMessage" in firstModelMsg ? firstModelMsg.errorMessage : void 0;
  const lastErrStr = typeof rawLastErr === "string" ? rawLastErr : void 0;
  const isLastAssistantError = Boolean(
    firstModelMsg && "stopReason" in firstModelMsg && firstModelMsg.stopReason === "error" || lastErrStr
  );
  const isError = finalMsg.stopReason === "error" || isLastAssistantError || Boolean(fault?.isError);
  const errorMessage = finalMsg.errorMessage ?? fault?.errorMessage ?? lastErrStr;
  if (isAborted && finalMsg.stopReason !== "aborted") {
    finalMsg.stopReason = "aborted";
  } else if (isError && finalMsg.stopReason !== "error") {
    finalMsg.stopReason = "error";
  }
  if (errorMessage && !finalMsg.errorMessage) {
    finalMsg.errorMessage = errorMessage;
  }
  return { finalMsg, cw, cumulativeUsage, isAborted, isError, errorMessage, lastCheckpointId };
}

// src/runner/bridge/native-tool-result.ts
function extractCanonicalToolDetails(event) {
  if (typeof event !== "object" || event === null) return void 0;
  const rec = event;
  if (rec.result && typeof rec.result === "object" && "details" in rec.result) {
    return rec.result.details;
  }
  if (rec.entry && typeof rec.entry === "object" && Array.isArray(rec.entry.model)) {
    const msg = rec.entry.model[0];
    if (msg && typeof msg === "object" && "details" in msg) {
      return msg.details;
    }
  }
  if ("details" in rec) {
    return rec.details;
  }
  return void 0;
}
function decodeEntry(entry) {
  const msg = entry.model?.[0];
  if (!msg || typeof msg !== "object" || msg.role !== "toolResult") {
    return {
      status: "invalid",
      isError: true,
      errorMessage: "Tool execution entry is missing a valid toolResult message"
    };
  }
  return {
    status: "entry",
    isError: Boolean(msg.isError),
    rawOutput: msg.content ?? msg.output,
    details: "details" in msg ? msg.details : void 0
  };
}
function decodeResult(result) {
  return {
    status: "result",
    isError: Boolean(result.isError),
    rawOutput: result.structuredOutput,
    details: "details" in result ? result.details : void 0,
    diagnostics: result.diagnostics ?? []
  };
}
function decodeNativeToolEnd(event) {
  const hasEntry = event.entry !== void 0;
  const hasResult = event.result !== void 0;
  if (hasEntry && hasResult) {
    return {
      status: "invalid",
      isError: true,
      errorMessage: "Tool protocol invariant violation: both entry and result present in tool_execution_end"
    };
  }
  if (!hasEntry && !hasResult) {
    return {
      status: "missing",
      isError: true,
      errorMessage: "Tool execution completed without generating an entry record or nested result"
    };
  }
  if (hasResult && event.result) {
    return decodeResult(event.result);
  }
  if (event.entry) {
    return decodeEntry(event.entry);
  }
  return {
    status: "invalid",
    isError: true,
    errorMessage: "Tool execution entry is missing"
  };
}

// src/runner/bridge/tool-result-presentation.ts
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail
} from "@earendil-works/pi-coding-agent";
function isImageContent(value) {
  if (typeof value !== "object" || value === null) return false;
  const rec = value;
  return rec.type === "image" && (typeof rec.data === "string" || typeof rec.mimeType === "string");
}
function redactImageStructures(value) {
  if (typeof value !== "object" || value === null) return value;
  if (isImageContent(value)) {
    const rec = value;
    return { ...rec, data: "[image data omitted]" };
  }
  if (Array.isArray(value)) {
    return value.map(redactImageStructures);
  }
  const result = {};
  for (const [k, v] of Object.entries(value)) {
    result[k] = redactImageStructures(v);
  }
  return result;
}
function formatContentBlock(block) {
  if (typeof block === "string") return block;
  if (typeof block !== "object" || block === null) return String(block);
  const rec = block;
  if (typeof rec.text === "string") return rec.text;
  if (isImageContent(rec)) {
    return `[image: ${String(rec.mimeType ?? "image")}]`;
  }
  return JSON.stringify(redactImageStructures(rec));
}
function formatRawOutput(toolName, raw) {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(formatContentBlock).filter(Boolean).join("\n");
  }
  if (typeof raw === "object" && raw !== null) {
    const rec = raw;
    if (toolName === "bash" && typeof rec.output === "string") {
      return rec.output;
    }
    if (isImageContent(rec)) {
      return `[image: ${String(rec.mimeType ?? "image")}]`;
    }
    return JSON.stringify(redactImageStructures(raw), null, 2);
  }
  return "";
}
function renderDiagnostics(diagnostics) {
  return diagnostics.filter((d) => d && typeof d.message === "string" && d.message.length > 0).map((d) => d.severity && d.severity !== "info" ? `[${d.severity}] ${d.message}` : d.message).join("\n");
}
function presentToolResult(params) {
  const { toolName, rawOutput, isError, diagnostics, retainedOutput } = params;
  let text = "";
  if (rawOutput !== void 0) {
    text = formatRawOutput(toolName, rawOutput);
  } else if (retainedOutput) {
    text = retainedOutput;
  }
  if (diagnostics && diagnostics.length > 0) {
    const diagText = renderDiagnostics(diagnostics);
    if (diagText) {
      text = text ? `${text}
${diagText}` : diagText;
    }
  }
  if (!text && isError) {
    text = `Tool ${toolName} failed`;
  }
  return truncateTail(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES
  }).content;
}

// src/runner/bridge/tool-progress-state.ts
var ToolProgressState = class {
  active = /* @__PURE__ */ new Map();
  applyOutputUpdate(callId, output2) {
    if (!output2) {
      return this.active.get(callId)?.output;
    }
    let current = this.active.get(callId)?.output ?? "";
    if ("set" in output2) {
      current = output2.set;
    } else {
      const trim = typeof output2.trimStart === "number" ? Math.max(0, output2.trimStart) : 0;
      const append = typeof output2.append === "string" ? output2.append : "";
      current = current.slice(trim) + append;
    }
    const existing = this.active.get(callId);
    if (existing) {
      existing.output = current;
    } else {
      this.active.set(callId, { output: current });
    }
    return current;
  }
  setDetails(callId, details) {
    const existing = this.active.get(callId);
    if (existing) {
      existing.details = details;
    } else {
      this.active.set(callId, { output: "", details });
    }
  }
  getDetails(callId) {
    return this.active.get(callId)?.details;
  }
  getRetainedOutput(callId) {
    return this.active.get(callId)?.output;
  }
  take(callId) {
    const slot = this.active.get(callId);
    this.active.delete(callId);
    return slot ? { output: slot.output, details: slot.details } : {};
  }
  clear() {
    this.active.clear();
  }
  seedFromSnapshot(tools, nestedTools) {
    const all = [...tools ?? [], ...nestedTools ?? []];
    for (const t of all) {
      if (t && t.callId !== void 0) {
        const outputStr = typeof t.output === "string" ? t.output : "";
        this.active.set(t.callId, { output: outputStr, details: t.details });
      }
    }
  }
};

// src/runner/bridge/tool-result-extractor.ts
function buildTerminalError(event, decoded, canonicalDetails, parentRef) {
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: decoded.errorMessage,
    isError: true,
    ...canonicalDetails !== void 0 ? { details: canonicalDetails } : {},
    ...parentRef !== void 0 ? { parentRef } : {}
  };
}
function buildTerminalSuccess(event, decoded, scoped, canonicalDetails, parentRef) {
  const details = canonicalDetails !== void 0 ? canonicalDetails : scoped.details;
  const result = presentToolResult({
    toolName: event.toolName,
    rawOutput: decoded.rawOutput,
    isError: decoded.isError,
    diagnostics: decoded.status === "result" ? decoded.diagnostics : void 0,
    retainedOutput: scoped.output
  });
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result,
    isError: decoded.isError,
    ...details !== void 0 ? { details } : {},
    ...parentRef !== void 0 ? { parentRef } : {}
  };
}
var ToolEventProjector = class {
  progressState = new ToolProgressState();
  projectToolUpdate(event, parentRef) {
    let partialResult;
    if (event.output) {
      partialResult = this.progressState.applyOutputUpdate(event.toolCallId, event.output);
    } else if (event.details !== void 0) {
      partialResult = this.progressState.getRetainedOutput(event.toolCallId) ?? "";
    }
    if (event.details !== void 0) {
      this.progressState.setDetails(event.toolCallId, event.details);
    }
    let trimStart;
    if (event.output && "trimStart" in event.output && typeof event.output.trimStart === "number") {
      trimStart = event.output.trimStart;
    }
    if (partialResult !== void 0 || trimStart !== void 0 || event.details !== void 0) {
      return {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: partialResult ?? "",
        ...trimStart !== void 0 ? { trimStart } : {},
        ...event.details !== void 0 ? { details: event.details } : {},
        ...parentRef !== void 0 ? { parentRef } : {}
      };
    }
    return void 0;
  }
  projectToolEnd(event, parentRef) {
    const decoded = decodeNativeToolEnd(event);
    const scoped = this.progressState.take(event.toolCallId);
    const canonicalDetails = extractCanonicalToolDetails(event);
    if (decoded.status === "missing" || decoded.status === "invalid") {
      const fallback = canonicalDetails !== void 0 ? canonicalDetails : scoped.details;
      return buildTerminalError(event, decoded, fallback, parentRef);
    }
    return buildTerminalSuccess(event, decoded, scoped, canonicalDetails, parentRef);
  }
  clear() {
    this.progressState.clear();
  }
  seedFromSnapshot(tools, nestedTools) {
    this.progressState.seedFromSnapshot(tools, nestedTools);
  }
};

// src/runner/bridge/child-run-outcome.ts
function resolveChildRunOutcome(inputs, submissions, lastTaskError) {
  if (inputs && submissions) {
    let hasDoneInput = false;
    for (const id of inputs) {
      const sub = submissions.get(id);
      if (sub) {
        if (sub.status === "done") {
          hasDoneInput = true;
        } else if (sub.status === "unanswered") {
          const isAborted = sub.reason === "aborted" || sub.reason === "cancelled";
          return {
            status: isAborted ? "interrupted" : "failed",
            isAborted,
            isError: !isAborted,
            errorMessage: sub.detail || sub.reason || lastTaskError || "Task failed"
          };
        }
      }
    }
    if (hasDoneInput) {
      return { status: "completed" };
    }
  }
  if (lastTaskError) {
    return {
      status: "failed",
      isError: true,
      errorMessage: lastTaskError
    };
  }
  return { status: "completed" };
}

// src/runner/bridge/durable-child-event-adapter.ts
var DurableChildEventAdapter = class {
  output;
  parentRef;
  conversationId;
  toolProjector = new ToolEventProjector();
  submissions = /* @__PURE__ */ new Map();
  lastTaskError;
  currentText = "";
  currentThinking = "";
  isInThinking = false;
  constructor(output2, parentRef, conversationId) {
    this.output = output2;
    this.parentRef = parentRef;
    this.conversationId = conversationId;
  }
  closeThinkingIfNeeded() {
    if (!this.isInThinking) return;
    this.isInThinking = false;
    this.output({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking },
      parentRef: this.parentRef,
      ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
    });
  }
  handleBatch(batch, current) {
    if (batch.some((ev) => ev.type === "run_start")) {
      this.lastTaskError = void 0;
      this.submissions.clear();
    }
    for (const ev of batch) {
      if (ev.type === "task_failed") {
        this.lastTaskError = ev.message;
      } else if (ev.type === "submission" && ev.record?.id !== void 0) {
        this.submissions.set(ev.record.id, ev.record);
      }
    }
    for (const ev of batch) {
      this.handleEvent(ev, current);
    }
  }
  handleEvent(event, _current) {
    switch (event.type) {
      case "message_update": {
        for (const change of event.changes) {
          const thinkDelta = change.type === "thinking_delta" ? change.delta : change.type === "thinking_start" && change.block.type === "thinking" && change.block.thinking ? change.block.thinking : void 0;
          const textDelta = change.type === "text_delta" ? change.delta : change.type === "text_start" && change.block.type === "text" && change.block.text ? change.block.text : void 0;
          if (thinkDelta) {
            this.isInThinking = true;
            this.currentThinking += thinkDelta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkDelta },
              parentRef: this.parentRef,
              ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
            });
          } else if (textDelta) {
            this.closeThinkingIfNeeded();
            this.currentText += textDelta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: textDelta },
              parentRef: this.parentRef,
              ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
            });
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.closeThinkingIfNeeded();
        this.output({
          type: "tool_execution_start",
          toolCallId: `${this.parentRef}:${event.toolCallId}`,
          toolName: event.toolName,
          args: event.args ?? {},
          parentRef: this.parentRef,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      case "tool_execution_update": {
        const update = this.toolProjector.projectToolUpdate(
          { ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
          this.parentRef
        );
        if (update) {
          this.output({
            ...update,
            ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
          });
        }
        break;
      }
      case "tool_execution_end": {
        const end = this.toolProjector.projectToolEnd(
          { ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
          this.parentRef
        );
        this.output({
          ...end,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      case "message_end": {
        this.closeThinkingIfNeeded();
        const message = event.entry?.model?.[0];
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const fullText = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
          if (fullText.startsWith(this.currentText) && fullText.length > this.currentText.length) {
            const delta = fullText.slice(this.currentText.length);
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
              parentRef: this.parentRef,
              ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
            });
          }
          this.currentText = "";
          this.currentThinking = "";
        }
        break;
      }
      case "run_end": {
        this.closeThinkingIfNeeded();
        this.toolProjector.clear();
        const outcome = resolveChildRunOutcome(event.inputs, this.submissions, this.lastTaskError);
        this.output({
          type: "agent_end",
          messages: [],
          parentRef: this.parentRef,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {},
          ...outcome.isAborted ? { aborted: true, stopReason: "aborted" } : {},
          ...outcome.isError && !outcome.isAborted ? { stopReason: "error", ...outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {} } : {}
        });
        break;
      }
      case "turn_start": {
        this.output({
          type: "turn_start",
          parentRef: this.parentRef,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      case "snapshot": {
        const snap = event;
        const prefix = (slots) => slots?.map((s) => ({ ...s, callId: `${this.parentRef}:${s.callId}` }));
        this.toolProjector.seedFromSnapshot(prefix(snap.tools), prefix(snap.nestedTools));
        break;
      }
      case "run_start": {
        this.toolProjector.clear();
        break;
      }
      default:
        break;
    }
  }
};

// src/runner/bridge/tool-args-resolver.ts
function resolveToolCallArgs(callId, current) {
  const rawLive = current.conversation.docs["pi.live"];
  const live = typeof rawLive === "object" && rawLive !== null ? rawLive : {};
  const rawBlocks = Array.isArray(live.generation?.message?.content) ? live.generation.message.content : [];
  const activeCalls = rawBlocks.filter(isToolCallBlock);
  if (activeCalls.length > 0) {
    const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
    if (matched?.arguments && typeof matched.arguments === "object") {
      return matched.arguments;
    }
  }
  const entries = current.conversation.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isConversationEntryRecord(entry) && entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
      for (const msg of entry.model) {
        if (Array.isArray(msg?.content)) {
          for (const part of msg.content) {
            if (isToolCallBlock(part) && (part.id === callId || part.callId === callId)) {
              if (part.arguments && typeof part.arguments === "object") {
                return part.arguments;
              }
            }
          }
        }
      }
    }
  }
  const rawTools = Array.isArray(live.tools) ? live.tools : [];
  const slot = rawTools.find((s) => {
    if (typeof s !== "object" || s === null) return false;
    const candidate = s;
    const sid = candidate.callId ?? (candidate.id !== void 0 ? String(candidate.id) : void 0);
    return sid === callId;
  });
  if (slot?.args && typeof slot.args === "object") {
    return slot.args;
  }
  return {};
}

// src/runner/bridge/durable-event-adapter.ts
var DurableEventAdapter = class {
  output;
  resolveContextWindow;
  submissions = /* @__PURE__ */ new Map();
  activeToolNames = /* @__PURE__ */ new Map();
  toolProjector = new ToolEventProjector();
  lastTaskError;
  lastAssistantMessage;
  lastCheckpointId;
  currentText = "";
  currentThinking = "";
  isInThinking = false;
  constructor(output2, resolveContextWindow) {
    this.output = output2;
    this.resolveContextWindow = resolveContextWindow;
  }
  closeThinkingIfNeeded() {
    if (!this.isInThinking) return;
    this.isInThinking = false;
    this.output({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking } });
  }
  resolveParentRef(parentToolCallId) {
    if (parentToolCallId === void 0) return void 0;
    const name = this.activeToolNames.get(parentToolCallId);
    if (name === "codemode" || name !== void 0 && name !== "subagent" && name !== "agent_spawn" && name !== "agent_spawn_graph") return void 0;
    return String(parentToolCallId);
  }
  createChildAdapter(parentCallId, conversationId) {
    return new DurableChildEventAdapter(this.output, parentCallId, conversationId);
  }
  emitTerminal(type, current, inputs) {
    this.closeThinkingIfNeeded();
    const fault = type === "agent_end" ? findSubmissionFault(inputs, this.submissions, this.lastTaskError) : void 0;
    const summary = resolveTurnSummary(current, this.currentText, this.currentThinking, this.lastAssistantMessage, this.resolveContextWindow, fault);
    if (summary.lastCheckpointId) this.lastCheckpointId = summary.lastCheckpointId;
    const isAborted = summary.isAborted;
    const isError = summary.isError && !isAborted;
    const base = {
      contextWindow: summary.cw,
      ...this.lastCheckpointId && { providerCheckpointId: this.lastCheckpointId },
      ...summary.cumulativeUsage && { cumulativeUsage: summary.cumulativeUsage },
      ...isAborted && { aborted: true, stopReason: "aborted" },
      ...isError && { stopReason: "error", ...summary.errorMessage && { errorMessage: summary.errorMessage } }
    };
    if (type === "turn_end") this.output({ type: "turn_end", message: summary.finalMsg, ...base });
    else this.output({ type: "agent_end", messages: [summary.finalMsg], ...base });
  }
  handleBatch(batch, current) {
    for (const ev of batch) {
      if (ev.type === "task_failed") this.lastTaskError = ev.message;
      else if (ev.type === "submission" && ev.record?.id !== void 0) this.submissions.set(ev.record.id, ev.record);
    }
    for (const ev of batch) this.handleEvent(ev, current);
  }
  handleEvent(event, current) {
    switch (event.type) {
      case "snapshot": {
        const snap = event;
        const entries = snap.view?.conversation?.entries ?? snap.entries ?? current?.conversation?.entries;
        const tail = entries?.at(-1);
        if (tail?.id !== void 0) this.lastCheckpointId = String(tail.id);
        this.toolProjector.seedFromSnapshot(snap.tools, snap.nestedTools);
        break;
      }
      case "run_start": {
        this.lastTaskError = void 0;
        this.currentText = "";
        this.currentThinking = "";
        this.isInThinking = false;
        this.lastAssistantMessage = void 0;
        this.activeToolNames.clear();
        this.toolProjector.clear();
        this.output({ type: "agent_start" });
        break;
      }
      case "turn_start": {
        this.output({ type: "turn_start" });
        break;
      }
      case "message_update": {
        for (const change of event.changes) {
          const thinkDelta = change.type === "thinking_delta" ? change.delta : change.type === "thinking_start" && change.block.type === "thinking" && change.block.thinking ? change.block.thinking : void 0;
          const textDelta = change.type === "text_delta" ? change.delta : change.type === "text_start" && change.block.type === "text" && change.block.text ? change.block.text : void 0;
          if (thinkDelta) {
            this.isInThinking = true;
            this.currentThinking += thinkDelta;
            this.output({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkDelta } });
          } else if (textDelta) {
            this.closeThinkingIfNeeded();
            this.currentText += textDelta;
            this.output({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: textDelta } });
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.closeThinkingIfNeeded();
        this.activeToolNames.set(event.toolCallId, event.toolName);
        const parentRef = this.resolveParentRef(event.parentToolCallId);
        this.output({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args ?? {}, ...parentRef !== void 0 ? { parentRef } : {} });
        break;
      }
      case "tool_execution_update": {
        const update = this.toolProjector.projectToolUpdate(event, this.resolveParentRef(event.parentToolCallId));
        if (update) this.output(update);
        break;
      }
      case "tool_execution_end": {
        this.output(this.toolProjector.projectToolEnd(event, this.resolveParentRef(event.parentToolCallId)));
        break;
      }
      case "message_end": {
        this.closeThinkingIfNeeded();
        const modelItem = event.entry?.model?.[0];
        const msg = typeof modelItem === "object" && modelItem !== null ? modelItem : void 0;
        if (msg?.role === "assistant") {
          const errMsg = typeof msg.errorMessage === "string" ? msg.errorMessage : void 0;
          const stopReason = msg.stopReason ?? (errMsg ? "error" : "stop");
          let content = msg.content ?? [{ type: "text", text: this.currentText }];
          if (content.length === 0 && (stopReason === "error" || errMsg)) {
            content = [{ type: "text", text: errMsg ? `\u26A0\uFE0F ${errMsg}` : "An error occurred during turn generation." }];
          }
          this.lastAssistantMessage = {
            role: "assistant",
            content,
            stopReason,
            ...errMsg ? { errorMessage: errMsg } : {},
            usage: msg.usage
          };
          this.output({ type: "message_end", message: this.lastAssistantMessage });
          this.currentText = "";
          this.currentThinking = "";
        }
        break;
      }
      case "task_failed":
        this.lastTaskError = event.message;
        break;
      case "submission":
        if (event.record?.id !== void 0) this.submissions.set(event.record.id, event.record);
        break;
      case "compaction_start":
        this.output({ type: "compaction_start", reason: event.reason === "threshold" ? "threshold" : "manual" });
        break;
      case "compaction_end":
        this.output({ type: "compaction_end", reason: event.reason === "threshold" ? "threshold" : "manual", aborted: false });
        break;
      case "turn_end":
        this.emitTerminal("turn_end", current);
        break;
      case "run_end":
        this.toolProjector.clear();
        this.emitTerminal("agent_end", current, event.inputs);
        break;
      case "auto_retry_start":
        this.output({ type: "auto_retry_start", attempt: event.attempt, ...event.at !== void 0 ? { at: event.at } : {}, ...event.errorMessage ? { errorMessage: event.errorMessage } : {} });
        break;
      case "auto_retry_end":
        this.output({ type: "auto_retry_end", attempt: event.attempt });
        break;
    }
  }
};

// src/runner/subagent-watcher.ts
import {
  ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2,
  watchEvents as defaultWatchEvents
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";

// src/runner/binding-docs.ts
import { defineDoc as defineDoc3 } from "@earendil-works/pi-durable";
var BindingDoc = defineDoc3({
  kind: "durable.binding",
  version: 2,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: () => ({ binding: null })
});
var BindingIndexDoc = defineDoc3({
  kind: "durable.binding-index",
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ byIdentity: {}, byThreadId: {} })
});
function identityKey(identity) {
  return JSON.stringify([identity.providerId, identity.sessionId, identity.threadId]);
}

// src/runner/subagent-watcher.ts
function extractChildConversationId(event) {
  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const details = extractCanonicalToolDetails(event);
    return details?.conversationId;
  }
  return void 0;
}
async function startSubagentWatcher(harness, adapter, getCurrentView, options) {
  const watch2 = options?.watchEventsFn ?? defaultWatchEvents;
  const attached = /* @__PURE__ */ new Set();
  const activeStreams = /* @__PURE__ */ new Map();
  const attach = async (conversationId, parentCallId) => {
    if (attached.has(conversationId)) return;
    attached.add(conversationId);
    const isChild = parentCallId !== void 0;
    const childAdapter = isChild ? adapter.createChildAdapter(parentCallId, conversationId) : void 0;
    try {
      const stream = await watch2(harness, conversationId, BACKGROUND_CONTEXT2);
      activeStreams.set(conversationId, stream);
      stream.start(async (batch) => {
        try {
          const view = getCurrentView();
          if (childAdapter) {
            childAdapter.handleBatch(batch, view);
          } else {
            adapter.handleBatch(batch, view);
          }
          for (const event of batch) {
            const childId = extractChildConversationId(event);
            if (childId !== void 0 && !attached.has(childId)) {
              const callId = "toolCallId" in event ? isChild ? `${parentCallId}:${String(event.toolCallId)}` : String(event.toolCallId) : parentCallId ?? "subagent";
              void attach(childId, callId);
            }
          }
        } catch (err) {
          console.error(`[SubagentWatcher] Batch handling error for conversation ${conversationId}:`, err);
        }
      });
    } catch (err) {
      console.error(`[SubagentWatcher] Failed to attach stream for conversation ${conversationId}:`, err);
    }
  };
  await attach(ROOT_CONVERSATION_ID2);
  try {
    const index = await harness.snapshot(BindingIndexDoc, BACKGROUND_CONTEXT2);
    if (index?.byThreadId) {
      for (const convId of Object.values(index.byThreadId)) {
        if (convId && convId !== ROOT_CONVERSATION_ID2) {
          await attach(convId, "subagent");
        }
      }
    }
    const subagents = await harness.snapshot(SubagentsDoc, ROOT_CONVERSATION_ID2, BACKGROUND_CONTEXT2);
    if (subagents?.agents) {
      for (const agent of Object.values(subagents.agents)) {
        if (agent?.conversationId && agent.conversationId !== ROOT_CONVERSATION_ID2) {
          await attach(agent.conversationId, String(agent.ownerTaskId ?? "subagent"));
        }
      }
    }
  } catch (err) {
    console.warn(`[SubagentWatcher] Bootstrap child discovery warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ensureAttached: async (conversationId, parentCallId) => {
      await attach(conversationId, parentCallId ?? "subagent");
    },
    close: () => {
      for (const stream of activeStreams.values()) {
        try {
          stream.stop();
        } catch (err) {
          console.warn(`[SubagentWatcher] Stream stop warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      activeStreams.clear();
      attached.clear();
    }
  };
}

// src/runner/engine.ts
var DurableEngine = class _DurableEngine {
  #instance;
  sessionDir;
  eventListeners = /* @__PURE__ */ new Set();
  eventAdapter;
  watcher;
  unsubscribeView;
  constructor(instance, sessionDir) {
    this.#instance = instance;
    this.sessionDir = sessionDir;
    this.eventAdapter = new DurableEventAdapter((event) => {
      for (const listener of this.eventListeners) {
        listener(event);
      }
    });
    this.unsubscribeView = this.#instance.view.subscribe(this.eventAdapter.subscriber);
  }
  static async open(options = {}) {
    const sessionDir = options.sessionDir ?? options.session ?? process.cwd();
    const instance = await openDurable({
      cwd: options.cwd ?? process.cwd(),
      sessionDir,
      session: options.session,
      continueSession: options.continueSession,
      cli: {
        extensions: options.extensions,
        noGlobalExtensions: options.noGlobalExtensions
      }
    });
    const engine = new _DurableEngine(instance, sessionDir);
    engine.watcher = await startSubagentWatcher(
      instance.harness,
      engine.eventAdapter,
      () => instance.view.current()
    );
    return engine;
  }
  getSnapshot() {
    return this.#instance.view.current();
  }
  async prompt(content, options) {
    await this.#instance.controller.submit(content, options?.deliverAs ?? "followUp");
  }
  events(callback) {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }
  async abort() {
    await this.#instance.controller.abort();
  }
  async close() {
    this.eventListeners.clear();
    this.unsubscribeView?.();
    this.watcher?.close();
    await this.#instance.close();
  }
};

// src/runner/model-setup.ts
import {
  DefaultResourceLoader as DefaultResourceLoader2,
  ModelRuntime as ModelRuntime2,
  SettingsManager as SettingsManager2,
  getAgentDir as getAgentDir2,
  resolveModelScopeWithDiagnostics as resolveModelScopeWithDiagnostics2
} from "@earendil-works/pi-coding-agent";
async function setupRunnerModels(cwd, args2) {
  const agentDir = getAgentDir2();
  const settingsManager = SettingsManager2.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime2.create();
  const resourceLoader = new DefaultResourceLoader2({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register provider ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register native provider ${provider?.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register virtual model ${definition?.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const availableModels = modelRuntime.getAvailableSnapshot();
  const enabledPatterns = settingsManager.getEnabledModels();
  const scopedScope = enabledPatterns && enabledPatterns.length > 0 ? await resolveModelScopeWithDiagnostics2(enabledPatterns, modelRuntime) : void 0;
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
    else if (arg === "--extension" && i + 1 < argv2.length) {
      const ext = argv2[++i];
      args2.extension = ext;
      args2.extensions ??= [];
      args2.extensions.push(ext);
    } else if (arg === "--no-global-extensions") {
      args2.noGlobalExtensions = true;
    } else if (arg === "--skill" && i + 1 < argv2.length) {
      args2.skills ??= [];
      args2.skills.push(argv2[++i]);
    } else if (arg === "--tools-file" && i + 1 < argv2.length) {
      args2.toolsFilePath = argv2[++i];
    } else if (arg.startsWith("-")) {
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
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID5 } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT4 } from "@earendil-works/chord/context";

// src/runner/binding-commands.ts
function toConversationId(id) {
  if (typeof id === "number" && Number.isInteger(id) && id > 0) {
    return id;
  }
  if (typeof id === "string" && id.trim()) {
    const num = Number(id.trim());
    if (Number.isInteger(num) && num > 0) {
      return num;
    }
  }
  return void 0;
}
async function handleBindingCommand(cmd, durable, responder) {
  if (cmd.type === "register_binding") {
    try {
      if (typeof cmd.threadId !== "string" || !cmd.threadId.trim() || cmd.conversationId === void 0 || cmd.conversationId === null) {
        throw new InvalidCommandPayloadError("register_binding", "Missing threadId or conversationId");
      }
      const threadId = cmd.threadId.trim();
      const convId = toConversationId(cmd.conversationId);
      if (convId === void 0) {
        throw new InvalidCommandPayloadError("register_binding", `Invalid conversationId: ${String(cmd.conversationId)}`);
      }
      await durable.harness.commit(async (tx) => {
        const index = await tx.doc(BindingIndexDoc);
        const state = await tx.doc(BindingDoc, convId);
        const sessionId = durable.view.current()?.session?.id ?? "default";
        const parentThreadId = typeof cmd.parentThreadId === "string" && cmd.parentThreadId.trim() ? cmd.parentThreadId.trim() : null;
        const record = {
          providerId: "pi-durable",
          sessionId,
          conversationId: convId,
          threadId,
          parentThreadId,
          createdAt: Date.now()
        };
        state.binding = record;
        index.byThreadId[threadId] = convId;
        const key = identityKey(record);
        index.byIdentity[key] = convId;
      }, runtimeContext);
      responder.success(cmd.id, "register_binding", { registered: true });
    } catch (err) {
      responder.error(cmd.id, "register_binding", err instanceof Error ? err.message : String(err));
    }
    return true;
  }
  if (cmd.type === "get_all_bindings") {
    try {
      const index = await durable.harness.snapshot(BindingIndexDoc, runtimeContext);
      const bindings = [];
      if (index?.byThreadId) {
        const convIds = new Set(Object.values(index.byThreadId));
        for (const convId of convIds) {
          try {
            const state = await durable.harness.snapshot(BindingDoc, convId, runtimeContext);
            if (state?.binding) {
              bindings.push(state.binding);
            }
          } catch (err) {
            console.warn(`[BindingCommands] Failed to read BindingDoc for conversation ${convId}: ${err}`);
          }
        }
      }
      responder.success(cmd.id, "get_all_bindings", { bindings });
    } catch (err) {
      responder.error(cmd.id, "get_all_bindings", err instanceof Error ? err.message : String(err));
    }
    return true;
  }
  return false;
}

// src/runner/session-state-commands.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID4 } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";

// src/runner/conversation-id.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID3 } from "@earendil-works/pi-durable";
function parseConversationId(id) {
  if (id === void 0 || id === null) return ROOT_CONVERSATION_ID3;
  const trimmed = typeof id === "string" ? id.trim() : id;
  if (trimmed === "") {
    throw new Error(`Invalid conversationId: ${String(id)}`);
  }
  const num = typeof trimmed === "number" ? trimmed : Number(trimmed);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid conversationId: ${String(id)}`);
  }
  return num;
}

// src/runner/session-state-commands.ts
async function handleSessionStateCommand(cmd, durable, modelRuntime, args2, respond) {
  if (cmd.type === "get_state") {
    const targetId = parseConversationId(cmd.conversationId);
    let agentDoc;
    if (targetId !== ROOT_CONVERSATION_ID4) {
      const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT3);
      if (!conv) {
        throw new Error(`Conversation not found: ${cmd.conversationId}`);
      }
      const agentState = await conv.agent(BACKGROUND_CONTEXT3);
      agentDoc = agentState;
    } else {
      const current = durable.view.current();
      agentDoc = current.conversation.docs["pi.agent"] ?? {};
    }
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
    return true;
  }
  if (cmd.type === "get_session_stats") {
    const targetId = parseConversationId(cmd.conversationId);
    let agentDoc;
    if (targetId !== ROOT_CONVERSATION_ID4) {
      const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT3);
      const agentState = conv ? await conv.agent(BACKGROUND_CONTEXT3) : void 0;
      agentDoc = agentState ?? {};
    } else {
      const current = durable.view.current();
      agentDoc = current.conversation.docs["pi.agent"] ?? {};
    }
    let contextWindow = 128e3;
    const provider = agentDoc.model?.provider ?? args2.provider;
    const modelId = agentDoc.model?.modelId ?? args2.model;
    if (provider && modelId) {
      const m = modelRuntime.getModel(provider, modelId);
      if (m?.contextWindow) contextWindow = m.contextWindow;
    }
    let tokens = null;
    try {
      const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT3);
      if (conv) {
        const ctxView = await conv.context(BACKGROUND_CONTEXT3);
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
    return true;
  }
  return false;
}

// src/runner/session-commands.ts
function toDurableInput(message, images) {
  const msg = message ?? "";
  const imgs = Array.isArray(images) ? images : [];
  if (!msg && imgs.length === 0) return null;
  if (imgs.length === 0) return msg;
  return [...msg ? [{ type: "text", text: msg }] : [], ...imgs];
}
async function handleActiveSessionCommand(cmd, durable, modelRuntime, args2, respond) {
  if (await handleBindingCommand(cmd, durable, respond)) {
    return;
  }
  if (await handleSessionStateCommand(cmd, durable, modelRuntime, args2, respond)) {
    return;
  }
  switch (cmd.type) {
    case "prompt": {
      const content = toDurableInput(cmd.message, cmd.images);
      if (!content) {
        respond.error(cmd.id, "prompt", "Missing message or images");
        return;
      }
      respond.success(cmd.id, "prompt");
      const behavior = cmd.streamingBehavior || "followUp";
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID5) {
        if (durable.watcher) await durable.watcher.ensureAttached(targetId);
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT4);
        if (!conv) {
          throw new Error(`Conversation not found: ${cmd.conversationId}`);
        }
        await conv.submit({ type: "input", content, whenBusy: behavior }, BACKGROUND_CONTEXT4);
      } else {
        await durable.controller.submit(content, behavior);
      }
      break;
    }
    case "steer": {
      const content = toDurableInput(cmd.message, cmd.images);
      if (!content) {
        respond.error(cmd.id, "steer", "Missing message or images");
        return;
      }
      respond.success(cmd.id, "steer");
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID5) {
        if (durable.watcher) await durable.watcher.ensureAttached(targetId);
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT4);
        if (!conv) {
          throw new Error(`Conversation not found: ${cmd.conversationId}`);
        }
        await conv.submit({ type: "input", content, whenBusy: "steer" }, BACKGROUND_CONTEXT4);
      } else {
        await durable.controller.submit(content, "steer");
      }
      break;
    }
    case "abort": {
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID5) {
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT4);
        if (conv) {
          await conv.abort(BACKGROUND_CONTEXT4, { background: true });
        }
      } else {
        await durable.controller.abort();
      }
      respond.success(cmd.id, "abort");
      break;
    }
    case "abort_task": {
      if (typeof cmd.taskId !== "number") {
        respond.error(cmd.id, "abort_task", "Missing taskId");
        return;
      }
      await durable.harness.abortTask(cmd.taskId, BACKGROUND_CONTEXT4);
      respond.success(cmd.id, "abort_task", { ok: true });
      break;
    }
    case "compact": {
      await durable.controller.compact(cmd.instructions);
      respond.success(cmd.id, "compact");
      break;
    }
    case "set_subagent_policy": {
      try {
        const record = subagentPolicyRecordSchema.parse(cmd.policyRecord);
        await durable.subagentPolicyHolder.setRecord(record);
        respond.success(cmd.id, "set_subagent_policy");
      } catch (err) {
        respond.error(cmd.id, "set_subagent_policy", err instanceof Error ? err.message : String(err));
      }
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
      if (!cmd.level) {
        respond.error(cmd.id, "set_thinking_level", "Missing thinking level");
        return;
      }
      await durable.controller.setThinkingLevel(cmd.level);
      respond.success(cmd.id, "set_thinking_level");
      break;
    }
    default: {
      respond.error(cmd.id, cmd.type ?? "unknown", `Unknown command: ${cmd.type}`);
      break;
    }
  }
}

// src/contracts/runner-command.ts
import { z as z4 } from "zod";

// src/contracts/wire-context.ts
import { z as z3 } from "zod";
var conversationIdSchema = z3.union([z3.number().int().positive(), z3.string().regex(/^[1-9]\d*$/)]);
var cumulativeUsageSchema = z3.object({
  totalTokens: z3.number(),
  inputTokens: z3.number(),
  outputTokens: z3.number(),
  cachedInputTokens: z3.number().optional(),
  cacheWriteInputTokens: z3.number().optional()
}).passthrough();
var wireContextSchema = z3.object({
  parentRef: z3.string().optional(),
  conversationId: conversationIdSchema.optional(),
  providerCheckpointId: z3.string().optional(),
  cumulativeUsage: cumulativeUsageSchema.optional(),
  aborted: z3.boolean().optional(),
  stopReason: z3.string().optional(),
  errorMessage: z3.string().optional()
}).passthrough();

// src/contracts/runner-command.ts
var runnerCommandSchema = z4.object({
  type: z4.enum(["prompt", "steer", "abort", "abort_task", "compact", "set_subagent_policy", "get_available_models", "set_model", "set_thinking_level", "get_state", "get_session_stats", "register_binding", "get_all_bindings"]),
  id: z4.string().optional(),
  message: z4.string().optional(),
  images: z4.array(z4.object({ type: z4.literal("image"), data: z4.string(), mimeType: z4.string() })).optional(),
  streamingBehavior: z4.enum(["steer", "followUp"]).optional(),
  provider: z4.string().optional(),
  modelId: z4.string().optional(),
  instructions: z4.string().optional(),
  level: z4.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  conversationId: conversationIdSchema.optional(),
  threadId: z4.string().optional(),
  parentThreadId: z4.string().optional(),
  sessionId: z4.string().optional(),
  policyRecord: z4.unknown().optional(),
  taskId: z4.number().int().positive().optional()
}).passthrough();
var knownCommandTypes = new Set(runnerCommandSchema.shape.type.options);
var runnerRequestHeaderSchema = z4.object({ type: z4.string().min(1), id: z4.string().optional() }).passthrough();
function parseRunnerCommand(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error("INVALID_COMMAND_JSON", { cause });
  }
  const parsed = runnerCommandSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVALID_COMMAND", { cause: parsed.error });
  return parsed.data;
}

// src/shared/version.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
var esmRequire = createRequire(import.meta.url);
var currentDir = dirname(fileURLToPath(import.meta.url));
function getPiDurableVersion() {
  try {
    const durablePkg = esmRequire.resolve("@earendil-works/pi-durable/package.json");
    if (existsSync2(durablePkg)) {
      const parsed = JSON.parse(readFileSync2(durablePkg, "utf8"));
      if (parsed.version) return parsed.version;
    }
  } catch (err) {
    const code = err?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ENOENT") {
      console.warn(`[Version] Failed to resolve durable package: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const pluginPkg = join3(currentDir, "..", "..", "package.json");
    if (existsSync2(pluginPkg)) {
      const parsed = JSON.parse(readFileSync2(pluginPkg, "utf8"));
      const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
      if (dep) return dep;
    }
  } catch (err) {
    const code = err?.code;
    if (code !== "ENOENT") {
      console.warn(`[Version] Failed to read plugin package: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return "1.0.0";
}

// src/runner/bridge-channel.ts
import { Socket } from "node:net";
import { writeSync } from "node:fs";

// src/contracts/runner-channel.ts
import { z as z5 } from "zod";
var runnerChannelSchema = z5.discriminatedUnion("kind", [
  z5.object({ kind: z5.literal("ready"), ready: z5.boolean().optional() }).passthrough(),
  z5.object({ kind: z5.literal("model-scope"), scopedModelIds: z5.array(z5.string()).optional(), defaultModelId: z5.string().optional() }).passthrough(),
  z5.object({ kind: z5.literal("reply"), id: z5.union([z5.string(), z5.number()]), result: z5.unknown().optional(), error: z5.unknown().optional() }).passthrough()
]);
var runnerBridgeRequestSchema = z5.object({
  kind: z5.literal("request"),
  id: z5.union([z5.string(), z5.number()]),
  method: z5.string(),
  params: z5.unknown().optional()
}).passthrough();
var knownChannelKinds = new Set(runnerChannelSchema.options.map((schema) => schema.shape.kind.value));

// src/runner/bridge-channel.ts
var CHILD_TO_BRIDGE_FD = 3;
var BRIDGE_TO_CHILD_FD = 4;
function createBridgeSender() {
  return (msg) => {
    const str = `${JSON.stringify(msg)}
`;
    try {
      writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
    } catch (err) {
      const code = err?.code;
      if (code !== "EBADF" && code !== "ENXIO") {
        console.warn(`[BridgeChannel] FD ${CHILD_TO_BRIDGE_FD} write warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
function initBridgeInboundChannel(modelScope, sendToBridge2) {
  try {
    const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
    bridgeIn.on("error", (err) => {
      const code = err?.code;
      if (code !== "EBADF") {
        console.warn(`[BridgeChannel] Inbound socket warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    bridgeIn.unref();
    attachJsonlLineReader(bridgeIn, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const value = JSON.parse(trimmed);
        const result = runnerBridgeRequestSchema.safeParse(value);
        if (!result.success) throw new Error("INVALID_BRIDGE_REQUEST");
        const req = result.data;
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
        console.error(JSON.stringify({ component: "RunnerBridgeChannel", operation: "inbound_request", code: "INVALID_MESSAGE", severity: "error", outcome: "failed" }));
        bridgeIn.destroy();
      }
    });
  } catch (err) {
    const code = err?.code;
    if (code !== "EBADF") {
      console.warn(`[BridgeChannel] Inbound channel setup notice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// src/runtime-graph/schema.ts
import { z as z6 } from "zod";
var MAX_LIVE_NODES = 512;
var MAX_RECEIPTS = 128;
var MAX_LABEL_LENGTH = 160;
var MAX_PREVIEW_LENGTH = 500;
var MAX_SNAPSHOT_BYTES = 1048576;
var TASK_OUTCOMES = ["completed", "failed", "aborted", "faulted", "orphaned"];
var taskOutcomeSchema = z6.enum(TASK_OUTCOMES);
var LIVE_TASK_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"];
var liveTaskStatusSchema = z6.enum(LIVE_TASK_STATUSES);
var BLOCKED_REASONS = ["missing_task", "task_too_old", "migration_failed", "restart_limit"];
var blockedReasonSchema = z6.enum(BLOCKED_REASONS);
var graphScopeSchema = z6.object({
  sessionId: z6.string().min(1).max(256),
  rootConversationId: z6.string().min(1).max(64),
  buildId: z6.string().min(1).max(64)
});
var graphObservationSchema = z6.object({
  epoch: z6.string().min(1).max(64),
  revision: z6.number().int().nonnegative(),
  observedAt: z6.number().int().positive(),
  completeness: z6.enum(["complete", "limited"])
});
var runtimeTaskStateSchema = z6.discriminatedUnion("status", [
  z6.object({
    status: z6.literal("pending"),
    phase: z6.string().max(64).optional()
  }),
  z6.object({
    status: z6.literal("running"),
    phase: z6.string().max(64).optional()
  }),
  z6.object({
    status: z6.literal("waiting"),
    phase: z6.string().max(64).optional(),
    on: z6.array(z6.number().int().positive()).max(MAX_LIVE_NODES),
    policy: z6.enum(["failFast", "allSettled", "all", "first"]).optional()
  }),
  z6.object({
    status: z6.literal("sleeping"),
    phase: z6.string().max(64).optional(),
    until: z6.number().int().positive()
  }),
  z6.object({
    status: z6.literal("completing"),
    outcome: taskOutcomeSchema
  })
]);
var taskTokensUsageSchema = z6.object({
  total: z6.number().int().nonnegative().optional(),
  input: z6.number().int().nonnegative().optional(),
  output: z6.number().int().nonnegative().optional(),
  reasoning: z6.number().int().nonnegative().optional(),
  cacheRead: z6.number().int().nonnegative().optional()
});
var runtimeTaskNodeSchema = z6.object({
  id: z6.number().int().positive(),
  kind: z6.string().min(1).max(64),
  conversationId: z6.number().int().positive(),
  owner: z6.number().int().positive().optional(),
  background: z6.boolean(),
  abortRequested: z6.boolean(),
  state: runtimeTaskStateSchema,
  blocked: blockedReasonSchema.optional(),
  label: z6.string().min(1).max(MAX_LABEL_LENGTH),
  startedAt: z6.number().int().positive().optional(),
  endedAt: z6.number().int().positive().optional(),
  durationMs: z6.number().int().nonnegative().optional(),
  toolName: z6.string().max(64).optional(),
  targetHint: z6.string().max(128).optional(),
  model: z6.object({
    provider: z6.string().max(64),
    modelId: z6.string().max(128)
  }).optional(),
  thinkingLevel: z6.string().max(32).optional(),
  tokens: taskTokensUsageSchema.optional()
});
var runtimeConversationNodeSchema = z6.object({
  id: z6.number().int().positive(),
  owner: z6.object({
    conversationId: z6.number().int().positive(),
    taskId: z6.number().int().positive()
  }).optional(),
  parent: z6.object({
    conversationId: z6.number().int().positive(),
    at: z6.number().int().positive()
  }).optional()
});
var runtimeTaskReceiptSchema = z6.object({
  taskId: z6.number().int().positive(),
  conversationId: z6.number().int().positive(),
  owner: z6.number().int().positive().optional(),
  kind: z6.string().min(1).max(64),
  outcome: taskOutcomeSchema,
  isToolError: z6.boolean().optional(),
  error: z6.object({
    message: z6.string().max(1024),
    code: z6.string().max(64).optional()
  }).optional(),
  endedAt: z6.number().int().positive(),
  durationMs: z6.number().int().nonnegative().optional(),
  preview: z6.string().max(MAX_PREVIEW_LENGTH).optional(),
  toolName: z6.string().max(64).optional(),
  targetHint: z6.string().max(128).optional(),
  startedAt: z6.number().int().positive().optional(),
  tokens: taskTokensUsageSchema.optional()
});
var runtimeGraphStatsSchema = z6.object({
  liveCount: z6.number().int().nonnegative(),
  terminalCount: z6.number().int().nonnegative(),
  totalCount: z6.number().int().nonnegative()
});
function getUtf8ByteLength(str) {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(str, "utf8");
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 127) bytes += 1;
    else if (code <= 2047) bytes += 2;
    else if (code >= 55296 && code <= 56319) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
var runtimeGraphSnapshotSchema = z6.object({
  version: z6.literal(1),
  scope: graphScopeSchema,
  observation: graphObservationSchema,
  nodes: z6.record(z6.string(), runtimeTaskNodeSchema).refine((nodes) => Object.keys(nodes).length <= MAX_LIVE_NODES, {
    message: `Live nodes exceed maximum of ${MAX_LIVE_NODES}`
  }),
  conversations: z6.record(z6.string(), runtimeConversationNodeSchema),
  receipts: z6.array(runtimeTaskReceiptSchema).max(MAX_RECEIPTS),
  stats: runtimeGraphStatsSchema
}).refine(
  (snapshot) => {
    try {
      const json = JSON.stringify(snapshot);
      return getUtf8ByteLength(json) <= MAX_SNAPSHOT_BYTES;
    } catch {
      return false;
    }
  },
  { message: "Runtime graph snapshot exceeds 1 MiB payload limit" }
);

// src/runner/task-tokens.ts
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const u = raw;
  const total = typeof u.totalTokens === "number" ? u.totalTokens : typeof u.total === "number" ? u.total : void 0;
  const input = typeof u.input === "number" ? u.input : typeof u.inputTokens === "number" ? u.inputTokens : void 0;
  const output2 = typeof u.output === "number" ? u.output : typeof u.outputTokens === "number" ? u.outputTokens : void 0;
  const reasoning = typeof u.reasoning === "number" ? u.reasoning : void 0;
  const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : typeof u.cachedInputTokens === "number" ? u.cachedInputTokens : void 0;
  const computedTotal = total ?? (input ?? 0) + (output2 ?? 0);
  if (computedTotal <= 0 && (output2 ?? 0) <= 0) return void 0;
  return {
    total: computedTotal,
    input,
    output: output2,
    reasoning,
    cacheRead
  };
}
function extractLiveTokens(node, current) {
  if (node.kind !== "pi.generation") return void 0;
  const cur = current;
  if (!cur || typeof cur !== "object") return void 0;
  const liveDoc = cur?.conversation?.docs?.["pi.live"];
  if (liveDoc?.generation?.message?.usage) {
    const usage = normalizeUsage(liveDoc.generation.message.usage);
    if (usage) return usage;
  }
  return void 0;
}
function extractTerminalTokens(task, current, recentEntries) {
  if (task.kind !== "pi.generation") return void 0;
  const state = task.state;
  const outcome = state?.outcome;
  const entryId = outcome?.result?.entryId;
  if (entryId === void 0) return void 0;
  const entryIdNum = Number(entryId);
  if (recentEntries) {
    const rawEntry = recentEntries.get(entryIdNum);
    const usage = rawEntry?.record?.model?.[0]?.usage ?? rawEntry?.model?.[0]?.usage;
    if (usage) {
      const normalized = normalizeUsage(usage);
      if (normalized) return normalized;
    }
  }
  const cur = current;
  const entries = cur?.conversation?.entries;
  if (Array.isArray(entries)) {
    const target = entries.find((e) => Number(e?.id) === entryIdNum);
    if (target?.model?.[0]?.usage) {
      return normalizeUsage(target.model[0].usage);
    }
  }
  return void 0;
}

// src/runner/runtime-graph-receipts.ts
var MAX_ERROR_MESSAGE_LENGTH = 1024;
var MAX_ERROR_CODE_LENGTH = 64;
var RuntimeGraphReceiptsCollector = class {
  capacity;
  receipts = [];
  knownTaskIds = /* @__PURE__ */ new Set();
  pendingEntryIds = /* @__PURE__ */ new Map();
  constructor(capacity = MAX_RECEIPTS) {
    this.capacity = capacity;
  }
  recordTerminal(task, options) {
    const state = task.state;
    if (state.status !== "terminal") {
      return void 0;
    }
    const taskId = Number(task.id);
    let outcome = "completed";
    let error;
    const taskOutcome = typeof state.outcome === "object" && state.outcome !== null && "status" in state.outcome ? state.outcome : { status: String(state.outcome ?? "completed") };
    outcome = taskOutcome.status ?? "completed";
    if ("error" in taskOutcome && taskOutcome.error !== void 0 && taskOutcome.error !== null) {
      let rawMsg = "Task execution failed";
      let rawCode;
      if (typeof taskOutcome.error === "object") {
        const err = taskOutcome.error;
        if (err.message !== void 0 && err.message !== null) rawMsg = String(err.message);
        if (err.code !== void 0 && err.code !== null) rawCode = String(err.code);
      } else {
        rawMsg = String(taskOutcome.error);
      }
      error = {
        message: rawMsg.length > MAX_ERROR_MESSAGE_LENGTH ? rawMsg.slice(0, MAX_ERROR_MESSAGE_LENGTH) : rawMsg,
        code: rawCode ? rawCode.length > MAX_ERROR_CODE_LENGTH ? rawCode.slice(0, MAX_ERROR_CODE_LENGTH) : rawCode : void 0
      };
    } else if ("reason" in taskOutcome && taskOutcome.reason !== void 0 && taskOutcome.reason !== null) {
      const rawReason = String(taskOutcome.reason);
      error = {
        message: rawReason.length > MAX_ERROR_MESSAGE_LENGTH ? rawReason.slice(0, MAX_ERROR_MESSAGE_LENGTH) : rawReason
      };
    }
    let preview = options?.preview;
    let toolName = options?.toolName;
    let targetHint = options?.targetHint;
    if (preview && preview.length > MAX_PREVIEW_LENGTH) {
      preview = preview.slice(0, MAX_PREVIEW_LENGTH);
    }
    if (toolName && toolName.length > 64) {
      toolName = toolName.slice(0, 64);
    }
    if (targetHint && targetHint.length > 128) {
      targetHint = targetHint.slice(0, 128);
    }
    if (!preview && toolName) {
      preview = targetHint ? `${toolName}: ${targetHint}` : toolName;
    }
    const startedAt = options?.startedAt ?? (task.startedAt !== void 0 && task.startedAt !== null ? Number(task.startedAt) : void 0);
    const durationMs = options?.durationMs ?? (task.endedAt && startedAt && task.endedAt >= startedAt ? task.endedAt - startedAt : void 0);
    const owner = task.owner !== void 0 && task.owner !== null && Number(task.owner) > 0 ? Number(task.owner) : void 0;
    const receipt = {
      taskId,
      conversationId: Number(task.conversationId),
      owner,
      kind: task.kind,
      outcome,
      isToolError: options?.isToolError,
      error,
      endedAt: task.endedAt ?? Date.now(),
      startedAt,
      durationMs,
      preview,
      toolName,
      targetHint,
      tokens: options?.tokens
    };
    if (options?.entryId && !options.tokens) {
      this.pendingEntryIds.set(taskId, options.entryId);
    } else if (options?.tokens) {
      this.pendingEntryIds.delete(taskId);
    }
    this.pushReceipt(receipt);
    return receipt;
  }
  hydrateFromScan(tasks) {
    for (const task of tasks) {
      if (task.state.status === "terminal") {
        this.recordTerminal(task);
      }
    }
  }
  getReceipts() {
    return [...this.receipts];
  }
  hasReceipt(taskId) {
    return this.knownTaskIds.has(taskId);
  }
  updateReceiptTokens(taskId, tokens) {
    const existingIndex = this.receipts.findIndex((r) => r.taskId === taskId);
    if (existingIndex !== -1) {
      this.receipts[existingIndex] = { ...this.receipts[existingIndex], tokens };
      this.pendingEntryIds.delete(taskId);
      return true;
    }
    return false;
  }
  backfillTokensFromEntries(entries) {
    if (this.pendingEntryIds.size === 0 || !Array.isArray(entries)) return false;
    let updated = false;
    for (const [taskId, entryId] of this.pendingEntryIds) {
      const target = entries.find((e) => Number(e?.id) === entryId);
      const usage = target?.model?.[0]?.usage ?? target?.record?.model?.[0]?.usage;
      if (usage) {
        const tokens = normalizeUsage(usage);
        if (tokens && this.updateReceiptTokens(taskId, tokens)) {
          updated = true;
        }
      }
    }
    return updated;
  }
  pushReceipt(receipt) {
    const existingIndex = this.receipts.findIndex((r) => r.taskId === receipt.taskId);
    if (existingIndex !== -1) {
      this.receipts[existingIndex] = receipt;
      return;
    }
    if (this.receipts.length >= this.capacity) {
      const evicted = this.receipts.shift();
      if (evicted) {
        this.knownTaskIds.delete(evicted.taskId);
      }
    }
    this.receipts.push(receipt);
    this.knownTaskIds.add(receipt.taskId);
  }
};

// src/runner/runtime-graph-conversations.ts
var RuntimeGraphConversations = class {
  known = /* @__PURE__ */ new Map();
  constructor(rootConversationId) {
    this.known.set(rootConversationId, { id: Number(rootConversationId) });
  }
  recordFromLiveNode(convId, id, ownedConversations) {
    const convStr = String(convId);
    if (!this.known.has(convStr)) {
      this.known.set(convStr, { id: convId });
    }
    for (const ownedConvId of ownedConversations ?? []) {
      const cid = Number(ownedConvId);
      this.known.set(String(cid), {
        id: cid,
        owner: { conversationId: convId, taskId: id }
      });
    }
  }
  recordConversation(conv) {
    const cid = Number(conv.id);
    const existing = this.known.get(String(cid)) ?? { id: cid };
    const owner = conv.owner ? { conversationId: Number(conv.owner.conversationId), taskId: Number(conv.owner.taskId) } : existing.owner;
    const parent = conv.parent ? { conversationId: Number(conv.parent.conversationId), at: Number(conv.parent.at) } : existing.parent;
    this.known.set(String(cid), { id: cid, ...owner ? { owner } : {}, ...parent ? { parent } : {} });
  }
  recordLogicalOwner(childId, parentConversationId, ownerTaskId) {
    const cidStr = String(childId);
    const existing = this.known.get(cidStr) ?? { id: childId };
    this.known.set(cidStr, {
      ...existing,
      owner: { conversationId: parentConversationId, taskId: ownerTaskId }
    });
  }
  snapshot() {
    return Object.fromEntries(this.known);
  }
};

// src/runner/task-labels.ts
var MAX_NAME = 48;
var MAX_TARGET_HINT = 128;
var MAX_TASK_NAMES = 512;
var KIND_NAMES = {
  "pi.generation": "assistant turn",
  "pi.compaction": "compacting context"
};
var ARG_KEYS = ["command", "task", "path", "file_path", "pattern", "query", "url", "prompt"];
function clip(text, max = MAX_NAME) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}\u2026`;
}
function sanitizeTargetHint(raw, max = MAX_TARGET_HINT) {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [redacted]");
  s = s.replace(/(ghp|gho|ghu|ghs|ghr|sec)_[a-zA-Z0-9]+/g, "[redacted]");
  s = s.replace(/(api[_-]?key|token|secret|password|passwd|auth)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]");
  return clip(s, max);
}
function argumentHint(args2) {
  if (typeof args2 !== "object" || args2 === null) return void 0;
  const record = args2;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return sanitizeTargetHint(value);
  }
  return void 0;
}
function liveOf(view) {
  const raw = view?.conversation?.docs?.["pi.live"];
  return typeof raw === "object" && raw !== null ? raw : {};
}
function isNested(slot) {
  return "parentCallId" in slot;
}
var TaskNames = class {
  names = /* @__PURE__ */ new Map();
  details = /* @__PURE__ */ new Map();
  learn(view) {
    const live = liveOf(view);
    for (const slot of [...live.tools ?? [], ...live.nestedTools ?? []]) {
      if (slot.taskId === void 0) continue;
      const key = String(slot.taskId);
      if (this.names.has(key)) continue;
      const args2 = isNested(slot) ? slot.arguments : resolveToolCallArgs(slot.callId, view);
      const hint = argumentHint(args2);
      const toolName = slot.name ? clip(slot.name, MAX_NAME) : void 0;
      const preview = clip(hint === void 0 ? slot.name : `${slot.name}: ${hint}`, MAX_NAME);
      if (this.names.size >= MAX_TASK_NAMES) {
        const oldest = this.names.keys().next().value;
        if (oldest !== void 0) {
          this.names.delete(oldest);
          this.details.delete(oldest);
        }
      }
      this.names.set(key, preview);
      this.details.set(key, { toolName, targetHint: hint, preview });
    }
  }
  get(taskId) {
    return this.names.get(taskId);
  }
  getDetails(taskId) {
    return this.details.get(taskId);
  }
};
function taskLabel(node, names, modelLabel) {
  const state = node.state;
  const call = names?.get(String(node.id));
  const plain = node.kind === "pi.generation" && modelLabel ? modelLabel : KIND_NAMES[node.kind];
  const kind = call ?? plain ?? (node.kind.startsWith("pi.") ? node.kind.slice(3) : node.kind);
  if (state.status === "waiting") return `${kind} \xB7 waiting on ${state.on.length}`;
  if (state.status === "completing") {
    const outcome = typeof state.outcome === "object" && state.outcome !== null && "status" in state.outcome ? state.outcome.status : state.outcome;
    return `${kind} \xB7 completing (${String(outcome ?? "completed")})`;
  }
  return call !== void 0 || plain !== void 0 ? kind : `${kind} \xB7 ${state.phase}`;
}

// src/runner/runtime-graph-state.ts
function extractTaskGraph(current) {
  if (!current || typeof current !== "object") return { tasks: {} };
  const obj = current;
  if ("tasks" in obj && obj.tasks && typeof obj.tasks === "object") {
    const inner = obj.tasks;
    if ("tasks" in inner && inner.tasks && typeof inner.tasks === "object") {
      return inner;
    }
    return current;
  }
  return { tasks: {} };
}
function mapTaskGraphNodeState(state) {
  switch (state.status) {
    case "pending":
    case "running":
      return { status: state.status, phase: state.phase };
    case "waiting":
      return {
        status: "waiting",
        phase: state.phase,
        on: state.on ? state.on.map(Number) : [],
        policy: state.policy
      };
    case "sleeping":
      return { status: "sleeping", phase: state.phase, until: state.until };
    case "completing": {
      const outcome = typeof state.outcome === "object" && state.outcome !== null && "status" in state.outcome ? state.outcome.status : state.outcome;
      return { status: "completing", outcome: outcome ?? "completed" };
    }
  }
}

// src/runner/runtime-graph-mapper.ts
function extractTaskModelMeta(node, current, rootConvId) {
  if (node.kind !== "pi.generation") return {};
  const cp = node.state?.checkpoint ?? node.checkpoint;
  let provider;
  let modelId;
  let thinkingLevel;
  if (cp && typeof cp === "object" && cp.model && typeof cp.model === "object") {
    if (cp.model.provider && (cp.model.modelId || cp.model.id)) {
      provider = String(cp.model.provider);
      modelId = String(cp.model.modelId ?? cp.model.id);
    }
    if (cp.thinkingLevel !== void 0 && cp.thinkingLevel !== null) thinkingLevel = String(cp.thinkingLevel);
  }
  if (!provider || !modelId) {
    const convId = Number(node.conversationId);
    if (convId === rootConvId) {
      const doc = current?.conversation?.docs?.["pi.agent"];
      if (doc?.model?.provider) {
        provider = String(doc.model.provider);
        modelId = String(doc.model.modelId ?? doc.model.id);
      }
      if (doc?.thinkingLevel !== void 0 && doc?.thinkingLevel !== null) thinkingLevel = String(doc.thinkingLevel);
    } else {
      const doc = current?.conversation?.docs?.["durable.subagents"];
      const sub = doc?.agents ? Object.values(doc.agents).find((a) => Number(a?.conversationId) === convId) : void 0;
      if (sub?.actualModel?.provider) {
        provider = String(sub.actualModel.provider);
        modelId = String(sub.actualModel.modelId ?? sub.actualModel.id);
      }
      if (sub?.thinkingLevel !== void 0 && sub?.thinkingLevel !== null) thinkingLevel = String(sub.thinkingLevel);
    }
  }
  if (!provider || !modelId) return {};
  const model = { provider, modelId };
  const modelLabel = thinkingLevel && thinkingLevel !== "off" ? `assistant turn \xB7 ${modelId} (${thinkingLevel})` : `assistant turn \xB7 ${modelId}`;
  return { model, thinkingLevel, modelLabel };
}
function recordSubagentOwnership(conversations, current, rootConvId) {
  const doc = current?.conversation?.docs?.["durable.subagents"];
  if (!doc?.agents) return;
  for (const a of Object.values(doc.agents)) {
    if (a?.conversationId && a?.ownerTaskId) {
      conversations.recordLogicalOwner(Number(a.conversationId), Number(rootConvId), Number(a.ownerTaskId));
    }
  }
}
function findSubagentMeta(current, taskId) {
  const doc = current?.conversation?.docs?.["durable.subagents"];
  if (!doc?.agents) return void 0;
  for (const a of Object.values(doc.agents)) {
    if (Number(a?.anchorTaskId) === taskId || Number(a?.ownerTaskId) === taskId) {
      return { name: a.name, task: a.task };
    }
  }
  return void 0;
}
function buildMappedNode(node, current, rootConvId, names, nativeStartedAt, clock) {
  const id = Number(node.id);
  const convId = Number(node.conversationId);
  const meta = extractTaskModelMeta(node, current, rootConvId);
  const callDetails = names.getDetails(String(id));
  const subMeta = findSubagentMeta(current, id);
  let label = taskLabel(node, names, meta.modelLabel);
  if (node.kind === "durable.subagent-anchor" && subMeta?.name) {
    label = `durable.subagent-anchor \xB7 subagent: ${subMeta.name}`;
  }
  if (label.length > MAX_LABEL_LENGTH) label = label.slice(0, MAX_LABEL_LENGTH);
  const startedAt = node.startedAt !== void 0 && node.startedAt !== null ? Number(node.startedAt) : nativeStartedAt.get(id);
  const durationMs = startedAt !== void 0 ? Math.max(0, clock() - startedAt) : void 0;
  return {
    id,
    kind: node.kind,
    conversationId: convId,
    owner: node.owner !== void 0 ? Number(node.owner) : void 0,
    background: Boolean(node.background),
    abortRequested: Boolean(node.abortRequested),
    state: mapTaskGraphNodeState(node.state),
    blocked: node.blocked,
    label,
    startedAt,
    durationMs,
    toolName: callDetails?.toolName ?? (subMeta ? "subagent" : void 0),
    targetHint: callDetails?.targetHint ?? (subMeta ? subMeta.name || subMeta.task : void 0),
    model: meta.model,
    thinkingLevel: meta.thinkingLevel,
    tokens: extractLiveTokens(node, current)
  };
}
function recordTerminalWithDetails(receipts, task, names, nativeStartedAt, current, recentEntries) {
  const id = Number(task.id);
  const details = names.getDetails(String(id));
  const subMeta = findSubagentMeta(current, id);
  const toolName = details?.toolName ?? (subMeta ? "subagent" : void 0);
  const targetHint = details?.targetHint ?? (subMeta ? subMeta.name || subMeta.task : void 0);
  const preview = subMeta?.task ?? details?.preview ?? names.get(String(id));
  const state = task.state;
  const rawEntryId = state?.outcome?.result?.entryId;
  const entryId = rawEntryId !== void 0 ? Number(rawEntryId) : void 0;
  receipts.recordTerminal(task, {
    preview,
    toolName,
    targetHint,
    entryId,
    startedAt: nativeStartedAt.get(id),
    tokens: extractTerminalTokens(task, current, recentEntries)
  });
}

// src/runner/runtime-graph-source.ts
var RuntimeGraphSource = class {
  viewSource;
  scope;
  debounceMs;
  maxDebounceMs;
  clock;
  receipts;
  harness;
  names = new TaskNames();
  listeners = /* @__PURE__ */ new Set();
  epoch;
  conversations;
  nativeStartedAt = /* @__PURE__ */ new Map();
  recentEntries = /* @__PURE__ */ new Map();
  revision = 0;
  previousNodes = /* @__PURE__ */ new Map();
  lastStructuralJson = "";
  timer;
  firstScheduledAt;
  unsubscribeView;
  unsubscribeCommits;
  isDisposed = false;
  constructor(viewSource, scope, options) {
    this.viewSource = viewSource;
    this.scope = scope;
    this.debounceMs = options?.debounceMs ?? 250;
    this.maxDebounceMs = options?.maxDebounceMs ?? 1e3;
    this.clock = options?.clock ?? Date.now;
    this.receipts = options?.receipts ?? new RuntimeGraphReceiptsCollector();
    this.harness = options?.harness;
    this.epoch = `epoch_${this.clock()}_${Math.random().toString(36).slice(2, 7)}`;
    this.conversations = new RuntimeGraphConversations(this.scope.rootConversationId);
    if (this.harness?.subscribeCommits) {
      this.unsubscribeCommits = this.harness.subscribeCommits((pub) => {
        for (const ch of pub.changes) {
          if (ch?.type === "entry" && ch.value) {
            this.recentEntries.set(Number(ch.value.id), ch.value);
            if (this.recentEntries.size > 256) {
              const oldest = this.recentEntries.keys().next().value;
              if (oldest !== void 0) this.recentEntries.delete(oldest);
            }
          } else if (ch?.type === "task") {
            const taskVal = ch.value;
            const idNum = Number(taskVal?.id);
            if (taskVal?.startedAt) {
              if (this.nativeStartedAt.size >= 256) {
                const oldest = this.nativeStartedAt.keys().next().value;
                if (oldest !== void 0) this.nativeStartedAt.delete(oldest);
              }
              this.nativeStartedAt.set(idNum, Number(taskVal.startedAt));
            }
            if (taskVal?.state?.status === "terminal") {
              this.learnNames();
              recordTerminalWithDetails(this.receipts, taskVal, this.names, this.nativeStartedAt, this.viewSource.current(), this.recentEntries);
            }
            this.schedule();
          } else if (ch?.type === "conversation" && ch.value) {
            this.conversations.recordConversation(ch.value);
            this.schedule();
          }
        }
      });
    }
    this.unsubscribeView = this.viewSource.subscribe(() => {
      const cur = this.viewSource.current();
      if (cur?.conversation?.entries) {
        this.receipts.backfillTokensFromEntries(cur.conversation.entries);
      }
      this.schedule();
    });
    this.schedule();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  teardown() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
      this.publish();
    }
    this.unsubscribeCommits?.();
    this.unsubscribeView?.();
    this.listeners.clear();
  }
  schedule() {
    if (this.isDisposed) return;
    const now = this.clock();
    if (this.firstScheduledAt === void 0) this.firstScheduledAt = now;
    const elapsed = now - this.firstScheduledAt;
    if (elapsed >= this.maxDebounceMs) {
      clearTimeout(this.timer);
      this.timer = void 0;
      this.publish();
      return;
    }
    clearTimeout(this.timer);
    const delay = Math.min(this.debounceMs, this.maxDebounceMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = void 0;
      this.publish();
    }, Math.max(0, delay));
  }
  publish() {
    this.firstScheduledAt = void 0;
    if (this.isDisposed) return;
    const current = this.viewSource.current();
    this.learnNames(current);
    const rawNodes = extractTaskGraph(current).tasks ?? {};
    const totalLiveCount = Object.keys(rawNodes).length;
    const liveNodeEntries = Object.entries(rawNodes).slice(0, MAX_LIVE_NODES);
    const currentLiveIds = /* @__PURE__ */ new Set();
    const mappedNodes = {};
    const rootConvId = Number(this.scope.rootConversationId);
    for (const [key, node] of liveNodeEntries) {
      currentLiveIds.add(Number(node.id));
      this.conversations.recordFromLiveNode(Number(node.conversationId), Number(node.id), node.conversations);
      mappedNodes[key] = buildMappedNode(node, current, rootConvId, this.names, this.nativeStartedAt, this.clock);
    }
    const hasMissingReceipts = this.reconcileDisappearedNodes(currentLiveIds);
    this.previousNodes = new Map(
      liveNodeEntries.map(([_, n]) => [Number(n.id), { conversationId: Number(n.conversationId), kind: n.kind }])
    );
    const completeness = totalLiveCount > MAX_LIVE_NODES || hasMissingReceipts ? "limited" : "complete";
    const conversations = this.conversations.snapshot();
    const receipts = this.receipts.getReceipts();
    const allTaskIds = /* @__PURE__ */ new Set();
    for (const key of Object.keys(rawNodes)) allTaskIds.add(Number(key));
    for (const r of receipts) allTaskIds.add(r.taskId);
    const stats = { liveCount: Object.keys(mappedNodes).length, terminalCount: receipts.length, totalCount: allTaskIds.size };
    const structuralJson = JSON.stringify({ nodes: mappedNodes, conversations, receipts, completeness, stats });
    if (structuralJson === this.lastStructuralJson) return;
    this.lastStructuralJson = structuralJson;
    const snapshot = {
      version: 1,
      scope: this.scope,
      observation: { epoch: this.epoch, revision: ++this.revision, observedAt: this.clock(), completeness },
      nodes: mappedNodes,
      conversations,
      receipts,
      stats
    };
    for (const listener of this.listeners) listener(snapshot);
  }
  learnNames(current) {
    const cur = current ?? this.viewSource.current();
    if (cur && typeof cur === "object" && "session" in cur && "conversation" in cur) {
      this.names.learn(cur);
    }
    recordSubagentOwnership(this.conversations, cur, this.scope.rootConversationId);
  }
  reconcileDisappearedNodes(currentLiveIds) {
    let hasMissing = false;
    for (const [prevId] of this.previousNodes) {
      if (!currentLiveIds.has(prevId) && !this.receipts.hasReceipt(prevId)) {
        hasMissing = true;
        if (this.harness?.getTask) {
          void this.harness.getTask(prevId).then((task) => {
            if (task && task.state?.status === "terminal") {
              this.learnNames();
              recordTerminalWithDetails(this.receipts, task, this.names, this.nativeStartedAt, this.viewSource.current(), this.recentEntries);
              this.schedule();
            }
          }).catch(() => {
          });
        }
      }
    }
    return hasMissing;
  }
};

// src/runner/index.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID6 } from "@earendil-works/pi-durable";

// src/runner/stdout-guard.ts
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join as join4 } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
var SUPPORTED_PI_VERSION_PREFIX = "1.4.";
var EXPECTED_GUARD_RELATIVE_PATH = "dist/core/output-guard.js";
var UpstreamStdoutGuardPortError = class extends Error {
  reason;
  constructor(message, reason) {
    super(`[UpstreamStdoutGuardPortError] ${message} (reason: ${reason})`);
    this.name = "UpstreamStdoutGuardPortError";
    this.reason = reason;
  }
};
var activeGuard = null;
function validateUpstreamGuardVersion(version) {
  if (!version.startsWith(SUPPORTED_PI_VERSION_PREFIX)) {
    throw new UpstreamStdoutGuardPortError(
      `Incompatible @earendil-works/pi-coding-agent version: "${version}". Expected ${SUPPORTED_PI_VERSION_PREFIX}x`,
      "INCOMPATIBLE_VERSION"
    );
  }
}
function validateUpstreamGuardShape(mod) {
  if (!mod || typeof mod !== "object") {
    throw new UpstreamStdoutGuardPortError("Loaded upstream output-guard module is not an object", "INVALID_MODULE");
  }
  const candidate = mod;
  const requiredFunctions = ["takeOverStdout", "restoreStdout", "isStdoutTakenOver", "writeRawStdout", "flushRawStdout"];
  for (const fn of requiredFunctions) {
    if (typeof candidate[fn] !== "function") {
      throw new UpstreamStdoutGuardPortError(`Missing required upstream output-guard export: ${fn}`, "INVALID_SHAPE");
    }
  }
}
async function loadUpstreamGuard() {
  if (activeGuard) return activeGuard;
  const pkgDir = getPackageDir();
  const pkgJsonPath = join4(pkgDir, "package.json");
  if (!existsSync3(pkgJsonPath)) {
    throw new UpstreamStdoutGuardPortError(`Cannot locate package.json at ${pkgJsonPath}`, "MISSING_PACKAGE_JSON");
  }
  let version;
  try {
    const pkgJson = JSON.parse(readFileSync3(pkgJsonPath, "utf8"));
    version = pkgJson.version ?? "";
  } catch (err) {
    throw new UpstreamStdoutGuardPortError(
      `Failed to parse @earendil-works/pi-coding-agent package.json: ${err instanceof Error ? err.message : String(err)}`,
      "PARSE_FAILURE"
    );
  }
  validateUpstreamGuardVersion(version);
  const guardPath = join4(pkgDir, EXPECTED_GUARD_RELATIVE_PATH);
  if (!existsSync3(guardPath)) {
    throw new UpstreamStdoutGuardPortError(`Missing upstream output guard artifact at ${guardPath}`, "MISSING_ARTIFACT");
  }
  let mod;
  try {
    mod = await import(pathToFileURL(guardPath).href);
  } catch (err) {
    throw new UpstreamStdoutGuardPortError(
      `Failed to dynamically import output guard: ${err instanceof Error ? err.message : String(err)}`,
      "IMPORT_FAILURE"
    );
  }
  validateUpstreamGuardShape(mod);
  activeGuard = mod;
  return mod;
}
async function setupRunnerStdoutGuard() {
  const guard = await loadUpstreamGuard();
  guard.takeOverStdout();
  if (!guard.isStdoutTakenOver()) {
    throw new UpstreamStdoutGuardPortError("takeOverStdout() failed to activate takeover state", "ACTIVATION_FAILED");
  }
}
function writeWireStdout(text) {
  if (activeGuard) {
    activeGuard.writeRawStdout(text);
  } else {
    process.stdout.write(text);
  }
}
async function flushWireStdout() {
  if (activeGuard?.flushRawStdout) {
    await activeGuard.flushRawStdout();
  }
}

// src/runner/control-channel.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, watch } from "node:fs";
import { join as join5 } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT5 } from "@earendil-works/chord/context";
function startRunnerControlChannel(sessionDir, harness, onNotice) {
  const controlFile = join5(sessionDir, "control.jsonl");
  let fileOffset = 0;
  let isClosed = false;
  let watcher = null;
  const processPendingLines = async () => {
    if (isClosed || !existsSync4(controlFile)) return;
    try {
      const content = readFileSync4(controlFile, "utf8");
      if (content.length <= fileOffset) return;
      const newChunk = content.slice(fileOffset);
      fileOffset = content.length;
      const lines = newChunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === "abort_task" && typeof msg.taskId === "number") {
            await harness.abortTask(msg.taskId, BACKGROUND_CONTEXT5);
            onNotice?.(`Aborted task #${msg.taskId} via control channel`);
          }
        } catch (parseErr) {
          console.warn(`[ControlChannel] Failed to process command: ${parseErr}`);
        }
      }
    } catch (err) {
      console.warn(`[ControlChannel] Error reading control file: ${err}`);
    }
  };
  try {
    watcher = watch(sessionDir, (_event, filename) => {
      if (filename === "control.jsonl" || !filename) {
        void processPendingLines();
      }
    });
  } catch (watchErr) {
    console.warn(`[ControlChannel] fs.watch not supported: ${watchErr}`);
  }
  void processPendingLines();
  return {
    close: () => {
      if (isClosed) return;
      isClosed = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    }
  };
}

// src/runner/index.ts
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(getPiDurableVersion());
  process.exit(0);
}
var args = parseCliArgs(argv);
function output(data) {
  writeWireStdout(serializeJsonLine(data));
}
var sendToBridge = createBridgeSender();
async function main() {
  await setupRunnerStdoutGuard();
  let activeDurable = null;
  let activeWatcher = null;
  let activeGraphSource = null;
  let activeControlChannel = null;
  let isTerminating = false;
  const handleExit = async (signalOrReason) => {
    if (isTerminating) return;
    isTerminating = true;
    try {
      activeControlChannel?.close();
    } catch (err) {
      console.warn(`[Runner] Error closing control channel on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      activeGraphSource?.teardown();
    } catch (err) {
      console.warn(`[Runner] Error tearing down graph source on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      activeWatcher?.close();
    } catch (err) {
      console.warn(`[Runner] Error closing subagent watcher on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await activeDurable?.close();
    } catch (err) {
      console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
    }
    try {
      await flushWireStdout();
    } catch (err) {
      console.warn(`[Runner] Error flushing stdout on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
    void handleExit(sig);
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
    output({ type: "ready", kind: "ready", pid: process.pid });
    sendToBridge({ ready: true, kind: "ready", pid: process.pid });
    attachJsonlLineReader(process.stdin, (line) => {
      if (!line.trim()) return;
      try {
        const cmd = parseRunnerCommand(line);
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
        error(void 0, "unknown", "INVALID_COMMAND");
      }
    });
    return;
  }
  const durable = await openDurable({
    cwd: args.cwd,
    continueSession: args.continueSession,
    session: args.session,
    cli: { provider: args.provider, model: args.model, thinking: args.thinking, skills: args.skills, extension: args.extension },
    prompt: { systemPromptPath: args.systemPromptPath, appendSystemPromptPath: args.appendSystemPromptPath }
  });
  activeDurable = durable;
  activeControlChannel = startRunnerControlChannel(durable.view.current().session.directory, durable.harness);
  const adapter = new DurableEventAdapter(
    (evt) => output(evt),
    (provider, modelId) => {
      const p = provider ?? args.provider;
      const m = modelId ?? args.model;
      return p && m ? modelRuntime.getModel(p, m)?.contextWindow : void 0;
    }
  );
  const watcher = await startSubagentWatcher(durable.harness, adapter, () => durable.view.current());
  activeWatcher = watcher;
  durable.watcher = watcher;
  activeGraphSource = new RuntimeGraphSource(
    durable.view,
    {
      sessionId: durable.view.current().session.id,
      rootConversationId: String(ROOT_CONVERSATION_ID6),
      buildId: "pi-durable-1.4"
    },
    {
      harness: durable.harness
    }
  );
  activeGraphSource.subscribe((snapshot) => output({ type: "runtime_graph_snapshot", snapshot }));
  let stdinQueue = Promise.resolve();
  attachJsonlLineReader(process.stdin, (line) => {
    stdinQueue = stdinQueue.then(async () => {
      let cmd;
      try {
        cmd = parseRunnerCommand(line);
      } catch (e) {
        error(void 0, "parse", "INVALID_COMMAND");
        return;
      }
      try {
        await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
      } catch (err) {
        error(cmd.id, cmd.type ?? "unknown", err instanceof Error ? err.message : String(err));
      }
    }).catch((fatal) => {
      console.error(`[Runner stdin] Unhandled command error: ${fatal}`);
    });
  });
  output({ type: "ready", kind: "ready", pid: process.pid });
  sendToBridge({ ready: true, kind: "ready", pid: process.pid });
}
main().catch((err) => {
  console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
export {
  DurableEngine
};
//# sourceMappingURL=index.js.map
