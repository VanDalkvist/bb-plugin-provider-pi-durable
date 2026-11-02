import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);

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
function createExtensionUIContext(onNotice) {
  return {
    select: async () => void 0,
    confirm: async () => false,
    input: async () => void 0,
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
    editor: async () => void 0,
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
import { z } from "zod";
var subagentThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
var subagentModelReferenceSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1)
}).strict();
var subagentModelProfileSchema = z.object({
  model: subagentModelReferenceSchema,
  thinkingLevel: subagentThinkingLevelSchema
}).strict();
var subagentPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("inherit"),
    configuredProfile: subagentModelProfileSchema.optional()
  }).strict(),
  z.object({
    mode: z.literal("configured"),
    configuredProfile: subagentModelProfileSchema
  }).strict()
]);
var subagentPolicyRecordSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().optional(),
  policy: subagentPolicySchema
}).strict();
var subagentPolicySetInputSchema = z.object({
  policy: subagentPolicySchema,
  expectedRevision: z.number().int().nonnegative()
}).strict();
var subagentPolicyGetOutputSchema = z.object({
  record: subagentPolicyRecordSchema
}).strict();
var subagentPolicySetOutputSchema = z.object({
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
  const settings = createHarnessSettings(settingsManager, getActiveModel);
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
      { models: modelRuntime, registry, settings, env: envs.env, onReport: report },
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
import { z as z3 } from "zod";

// src/contracts/wire-context.ts
import { z as z2 } from "zod";
var conversationIdSchema = z2.union([z2.number().int().positive(), z2.string().regex(/^[1-9]\d*$/)]);
var cumulativeUsageSchema = z2.object({
  totalTokens: z2.number(),
  inputTokens: z2.number(),
  outputTokens: z2.number(),
  cachedInputTokens: z2.number().optional(),
  cacheWriteInputTokens: z2.number().optional()
}).passthrough();
var wireContextSchema = z2.object({
  parentRef: z2.string().optional(),
  conversationId: conversationIdSchema.optional(),
  providerCheckpointId: z2.string().optional(),
  cumulativeUsage: cumulativeUsageSchema.optional(),
  aborted: z2.boolean().optional(),
  stopReason: z2.string().optional(),
  errorMessage: z2.string().optional()
}).passthrough();

// src/contracts/runner-command.ts
var runnerCommandSchema = z3.object({
  type: z3.enum(["prompt", "steer", "abort", "abort_task", "compact", "set_subagent_policy", "get_available_models", "set_model", "set_thinking_level", "get_state", "get_session_stats", "register_binding", "get_all_bindings"]),
  id: z3.string().optional(),
  message: z3.string().optional(),
  images: z3.array(z3.object({ type: z3.literal("image"), data: z3.string(), mimeType: z3.string() })).optional(),
  streamingBehavior: z3.enum(["steer", "followUp"]).optional(),
  provider: z3.string().optional(),
  modelId: z3.string().optional(),
  instructions: z3.string().optional(),
  level: z3.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  conversationId: conversationIdSchema.optional(),
  threadId: z3.string().optional(),
  parentThreadId: z3.string().optional(),
  sessionId: z3.string().optional(),
  policyRecord: z3.unknown().optional(),
  taskId: z3.number().int().positive().optional()
}).passthrough();
var knownCommandTypes = new Set(runnerCommandSchema.shape.type.options);
var runnerRequestHeaderSchema = z3.object({ type: z3.string().min(1), id: z3.string().optional() }).passthrough();
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
import { z as z4 } from "zod";
var runnerChannelSchema = z4.discriminatedUnion("kind", [
  z4.object({ kind: z4.literal("ready"), ready: z4.boolean().optional() }).passthrough(),
  z4.object({ kind: z4.literal("model-scope"), scopedModelIds: z4.array(z4.string()).optional(), defaultModelId: z4.string().optional() }).passthrough(),
  z4.object({ kind: z4.literal("reply"), id: z4.union([z4.string(), z4.number()]), result: z4.unknown().optional(), error: z4.unknown().optional() }).passthrough()
]);
var runnerBridgeRequestSchema = z4.object({
  kind: z4.literal("request"),
  id: z4.union([z4.string(), z4.number()]),
  method: z4.string(),
  params: z4.unknown().optional()
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
import { z as z5 } from "zod";
var MAX_LIVE_NODES = 512;
var MAX_RECEIPTS = 128;
var MAX_LABEL_LENGTH = 160;
var MAX_PREVIEW_LENGTH = 500;
var MAX_SNAPSHOT_BYTES = 1048576;
var TASK_OUTCOMES = ["completed", "failed", "aborted", "faulted", "orphaned"];
var taskOutcomeSchema = z5.enum(TASK_OUTCOMES);
var LIVE_TASK_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"];
var liveTaskStatusSchema = z5.enum(LIVE_TASK_STATUSES);
var BLOCKED_REASONS = ["missing_task", "task_too_old", "migration_failed", "restart_limit"];
var blockedReasonSchema = z5.enum(BLOCKED_REASONS);
var graphScopeSchema = z5.object({
  sessionId: z5.string().min(1).max(256),
  rootConversationId: z5.string().min(1).max(64),
  buildId: z5.string().min(1).max(64)
});
var graphObservationSchema = z5.object({
  epoch: z5.string().min(1).max(64),
  revision: z5.number().int().nonnegative(),
  observedAt: z5.number().int().positive(),
  completeness: z5.enum(["complete", "limited"])
});
var runtimeTaskStateSchema = z5.discriminatedUnion("status", [
  z5.object({
    status: z5.literal("pending"),
    phase: z5.string().max(64).optional()
  }),
  z5.object({
    status: z5.literal("running"),
    phase: z5.string().max(64).optional()
  }),
  z5.object({
    status: z5.literal("waiting"),
    phase: z5.string().max(64).optional(),
    on: z5.array(z5.number().int().positive()).max(MAX_LIVE_NODES),
    policy: z5.enum(["failFast", "allSettled", "all", "first"]).optional()
  }),
  z5.object({
    status: z5.literal("sleeping"),
    phase: z5.string().max(64).optional(),
    until: z5.number().int().positive()
  }),
  z5.object({
    status: z5.literal("completing"),
    outcome: taskOutcomeSchema
  })
]);
var taskTokensUsageSchema = z5.object({
  total: z5.number().int().nonnegative().optional(),
  input: z5.number().int().nonnegative().optional(),
  output: z5.number().int().nonnegative().optional(),
  reasoning: z5.number().int().nonnegative().optional(),
  cacheRead: z5.number().int().nonnegative().optional()
});
var runtimeTaskNodeSchema = z5.object({
  id: z5.number().int().positive(),
  kind: z5.string().min(1).max(64),
  conversationId: z5.number().int().positive(),
  owner: z5.number().int().positive().optional(),
  background: z5.boolean(),
  abortRequested: z5.boolean(),
  state: runtimeTaskStateSchema,
  blocked: blockedReasonSchema.optional(),
  label: z5.string().min(1).max(MAX_LABEL_LENGTH),
  startedAt: z5.number().int().positive().optional(),
  endedAt: z5.number().int().positive().optional(),
  durationMs: z5.number().int().nonnegative().optional(),
  toolName: z5.string().max(64).optional(),
  targetHint: z5.string().max(128).optional(),
  model: z5.object({
    provider: z5.string().max(64),
    modelId: z5.string().max(128)
  }).optional(),
  thinkingLevel: z5.string().max(32).optional(),
  tokens: taskTokensUsageSchema.optional()
});
var runtimeConversationNodeSchema = z5.object({
  id: z5.number().int().positive(),
  owner: z5.object({
    conversationId: z5.number().int().positive(),
    taskId: z5.number().int().positive()
  }).optional(),
  parent: z5.object({
    conversationId: z5.number().int().positive(),
    at: z5.number().int().positive()
  }).optional()
});
var runtimeTaskReceiptSchema = z5.object({
  taskId: z5.number().int().positive(),
  conversationId: z5.number().int().positive(),
  owner: z5.number().int().positive().optional(),
  kind: z5.string().min(1).max(64),
  outcome: taskOutcomeSchema,
  isToolError: z5.boolean().optional(),
  error: z5.object({
    message: z5.string().max(1024),
    code: z5.string().max(64).optional()
  }).optional(),
  endedAt: z5.number().int().positive(),
  durationMs: z5.number().int().nonnegative().optional(),
  preview: z5.string().max(MAX_PREVIEW_LENGTH).optional(),
  toolName: z5.string().max(64).optional(),
  targetHint: z5.string().max(128).optional(),
  startedAt: z5.number().int().positive().optional(),
  tokens: taskTokensUsageSchema.optional()
});
var runtimeGraphStatsSchema = z5.object({
  liveCount: z5.number().int().nonnegative(),
  terminalCount: z5.number().int().nonnegative(),
  totalCount: z5.number().int().nonnegative()
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
var runtimeGraphSnapshotSchema = z5.object({
  version: z5.literal(1),
  scope: graphScopeSchema,
  observation: graphObservationSchema,
  nodes: z5.record(z5.string(), runtimeTaskNodeSchema).refine((nodes) => Object.keys(nodes).length <= MAX_LIVE_NODES, {
    message: `Live nodes exceed maximum of ${MAX_LIVE_NODES}`
  }),
  conversations: z5.record(z5.string(), runtimeConversationNodeSchema),
  receipts: z5.array(runtimeTaskReceiptSchema).max(MAX_RECEIPTS),
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
