import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/runner/index.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeSync } from "node:fs";
import { join as join3 } from "node:path";
import { Socket } from "node:net";
import { DefaultResourceLoader as DefaultResourceLoader2, ModelRuntime as ModelRuntime2, SettingsManager as SettingsManager2 } from "@earendil-works/pi-coding-agent";

// src/runner/sessions.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
function getAgentDir() {
  const override = process.env.PI_AGENT_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return join(homedir(), ".pi", "agent");
}
async function selectSession(cwdInput, continueSession, targetSession) {
  const cwd = await realpath(resolve(cwdInput));
  const root = join(
    getAgentDir(),
    "experimental",
    "durable-sessions",
    createHash("sha256").update(cwd).digest("hex").slice(0, 24)
  );
  await mkdir(root, { recursive: true });
  let directory;
  let created = false;
  if (targetSession) {
    if (targetSession.includes("/") || targetSession.includes("\\")) {
      directory = targetSession.endsWith(".sqlite") ? resolve(targetSession, "..") : resolve(targetSession);
    } else {
      directory = join(root, targetSession);
    }
    try {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      created = !entries.includes("session.sqlite");
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
import { join as join2 } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
var CONTRIBUTIONS = {
  read: {
    snippet: "Read file contents",
    guidelines: ["Use read to examine files instead of cat or sed."]
  },
  bash: {
    snippet: "Execute bash commands (ls, grep, find, etc.)",
    guidelines: [
      "Use bash for file operations like ls, rg, find",
      "You can inspect PI_* environment variables for current model and session details."
    ]
  },
  edit: {
    snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    guidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."
    ]
  },
  write: {
    snippet: "Create or overwrite files",
    guidelines: ["Use write only for new files or complete rewrites."]
  }
};
var KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"];
function loadContextFiles(cwd) {
  const files = [];
  const candidates = [
    join2(cwd, "AGENTS.md"),
    join2(cwd, ".bb", "AGENTS.md"),
    join2(cwd, ".github", "copilot-instructions.md")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf8").trim();
        if (content) {
          files.push({ path: candidate, content });
        }
      } catch {
      }
    }
  }
  return files;
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
    const contrib = CONTRIBUTIONS[name];
    if (contrib) {
      for (const guideline of contrib.guidelines) {
        addRule(guideline);
      }
    }
  }
  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");
  return rules.map((r) => `- ${r}`).join("\n");
}
function createPiPrompt(settings, fallbackCwd, options = {}) {
  let systemPromptOverride;
  if (options.systemPromptPath && existsSync(options.systemPromptPath)) {
    try {
      systemPromptOverride = readFileSync(options.systemPromptPath, "utf8").trim();
    } catch (err) {
      console.error(`Warning: failed to read system-prompt: ${err}`);
    }
  }
  let appendPrompt;
  if (options.appendSystemPromptPath && existsSync(options.appendSystemPromptPath)) {
    try {
      appendPrompt = readFileSync(options.appendSystemPromptPath, "utf8").trim();
    } catch (err) {
      console.error(`Warning: failed to read append-system-prompt: ${err}`);
    }
  }
  const resources = /* @__PURE__ */ new Map();
  const load = (cwd) => {
    let found = resources.get(cwd);
    if (found === void 0) {
      found = {
        contextFiles: loadContextFiles(cwd),
        skills: []
      };
      resources.set(cwd, found);
    }
    return found;
  };
  const built = /* @__PURE__ */ new WeakMap();
  const build = (input) => {
    let sections = built.get(input);
    if (sections === void 0) {
      sections = buildSections(input);
      built.set(input, sections);
    }
    return sections;
  };
  const buildSections = (input) => {
    const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
    const { contextFiles, skills } = load(cwd);
    const selectedTools = input.agent.tools.map((t) => t.name);
    const sections = {};
    if (systemPromptOverride) {
      sections.preamble = systemPromptOverride;
    } else {
      sections.preamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
      const visibleTools = selectedTools.filter((name) => !!CONTRIBUTIONS[name]).map((name) => `- ${name}: ${CONTRIBUTIONS[name].snippet}`);
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
    if (contextFiles && contextFiles.length > 0) {
      const rendered = contextFiles.map((cf) => `<project_instructions path="${cf.path}">
${cf.content}
</project_instructions>`).join("\n\n");
      sections.project_context = `<project_context>
Project-specific instructions and guidelines:

${rendered}
</project_context>`;
    }
    if (skills && skills.length > 0) {
      sections.skills = `<skills>
${formatSkillsForPrompt(skills, "read")}
</skills>`;
    }
    sections.cwd = `<cwd>
${cwd.replace(/\\/g, "/")}
</cwd>`;
    return sections;
  };
  return defineExtension({
    name: "pi-prompt",
    sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false }))
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
function createHarnessSettings(settingsManager) {
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
      return settingsManager.getCompactionSettings?.() ?? {};
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
  async cleanup(context2) {
    const envs = [...this.#envs.values()];
    this.#envs.clear();
    for (const env of envs) await env.cleanup(context2);
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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  Harness,
  ROOT_CONVERSATION_ID
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager
} from "@earendil-works/pi-coding-agent";

// src/runner/subagent.ts
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension as defineExtension2,
  defineTool
} from "@earendil-works/pi-durable";
async function answerText(api, answer, context2) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context2);
  const message = entry?.model?.[0];
  return message?.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("") ?? "";
}
var Subagent = defineExtension2({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to a subagent with the same tools and get its answer back. Give it everything it needs to know; it does not see this conversation.",
      parameters: Type.Object({ task: Type.String({ description: "What the subagent should do" }) }),
      replay: "safe",
      execute: async (args2, api, context2) => {
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== void 0) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { extensions: { remove: [Subagent] } });
          return created.id;
        }, context2);
        await api.details({ conversationId: child }, context2);
        const handle = await api.conversation(child, context2);
        const request = { type: "input", content: args2.task, requestId: `subagent:${api.taskId}` };
        const settled = await (await handle.submit(request, context2)).wait(context2);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent ${child} failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, context2);
        return { content: [{ type: "text", text }], details: { conversationId: child } };
      }
    })
  ]
});

// src/runner/runtime.ts
var context = BACKGROUND_CONTEXT;
function agentOf(view) {
  return view.docs["pi.agent"] ?? {};
}
async function firstInput(harness, id) {
  if (id === ROOT_CONVERSATION_ID) return {};
  const conversation = await harness.conversation(id, context);
  let first;
  let cursor;
  do {
    const page = await conversation.entries({}, 256, cursor, context);
    first = [...page.items].reverse().find((entry) => entry.kind === "pi.user") ?? first;
    cursor = page.next;
  } while (cursor !== void 0);
  return titleOf(first);
}
function titleOf(entry) {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
  return { title: text.replace(/\s+/g, " ").trim() };
}
async function openDurable(options = {}) {
  const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
  const envs = new ExecutionEnvs(location.cwd);
  let harness;
  try {
    const modelRuntime = await ModelRuntime.create();
    const settingsManager = SettingsManager.create(location.cwd);
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({ cwd: location.cwd, agentDir, settingsManager });
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
    configureHarnessHttp(settingsManager);
    const settings = createHarnessSettings(settingsManager);
    const registry = createCodingRegistry(settingsManager, location.cwd, options.prompt);
    registry.install(Subagent);
    const pendingReports = [];
    let report = (error) => pendingReports.push(error);
    harness = await Harness.open(
      await openNodeSqliteStorage(location.database),
      {
        models: modelRuntime,
        registry,
        settings,
        env: envs.env,
        onReport: (error) => report(error)
      },
      context
    );
    const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime, options.cli) : void 0;
    const root = await harness.root(context, {
      agent: {
        cwd: location.cwd,
        ...initial?.model === void 0 ? {} : { model: initial.model },
        ...initial?.thinkingLevel === void 0 ? {} : { thinkingLevel: initial.thinkingLevel }
      }
    });
    if (!location.created && options.cli !== void 0) {
      const cliModel = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
      if (cliModel.model !== void 0) {
        await root.configure({ model: cliModel.model, thinkingLevel: cliModel.thinkingLevel }, context);
      }
    }
    const label = (id) => id === root.id ? "main" : `subagent ${id}`;
    const opened = harness;
    const summaries = [];
    let cursor;
    do {
      const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
      for (const { id } of page.items) summaries.push({ id, label: label(id), ...await firstInput(opened, id) });
      cursor = page.next;
    } while (cursor !== void 0);
    let current = root;
    let conversation = await root.viewState(context);
    const models = () => modelRuntime.getAvailableSnapshot().map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow
    }));
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
    const fail = (error) => notice("error", error instanceof Error ? error.message : String(error));
    report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
    for (const error of pendingReports) report(error);
    let unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
    const unsubscribeCommits = harness.subscribeCommits((publication) => {
      let conversations = state.conversations;
      for (const change of publication.changes) {
        if (change.type === "conversation") {
          conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
        } else if (change.type === "entry" && change.value.kind === "pi.user") {
          const id = change.value.conversationId;
          conversations = conversations.map(
            (summary) => summary.id === id && summary.title === void 0 ? { ...summary, ...titleOf(change.value) } : summary
          );
        }
      }
      if (conversations !== state.conversations) update({ conversations });
    });
    let tasks;
    let unsubscribeTasks = () => {
    };
    const closeTasks = () => {
      unsubscribeTasks();
      tasks?.dispose();
      tasks = void 0;
    };
    let queue = Promise.resolve();
    const command = (operation) => {
      queue = queue.then(operation).catch(fail);
      return queue;
    };
    const watchAnswer = (submission) => {
      void submission.wait(context).then((settled) => {
        if (settled.status === "unanswered" && settled.reason !== "aborted") {
          notice(
            "error",
            `No answer: ${settled.reason}${settled.detail === void 0 ? "" : ` ${JSON.stringify(settled.detail)}`}`
          );
        }
      }, fail);
    };
    const agentModel = () => {
      const ref = agentOf(state.conversation).model;
      const model = ref === void 0 ? void 0 : modelRuntime.getModel(ref.provider, ref.modelId);
      if (model === void 0)
        throw new Error(ref === void 0 ? "No model selected" : "Current model is unavailable");
      return model;
    };
    const controller = {
      submit: (text, whenBusy) => command(async () => watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context))),
      compact: (instructions) => command(async () => {
        const id = await current.compact(instructions, context);
        void opened.waitForTask(id, context).then(async (receipt) => {
          const outcome = receipt.state.outcome;
          if (outcome.status === "completed") {
            const { entryId, submissionId } = outcome.result;
            const status = submissionId === void 0 ? void 0 : (await (await opened.submission(submissionId, context))?.status(context))?.status;
            notice(
              "info",
              entryId !== void 0 || status === "done" ? "Compacted." : status === "queued" ? "Compaction summary queued; it is placed at the next turn boundary." : status === "unanswered" ? "Compaction summary dropped: the context changed under it." : "Nothing to compact: the context fits in the recent window that is kept verbatim."
            );
          } else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
          else
            notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
        }, fail);
      }),
      abort: () => current.abort(context).catch(fail),
      cycleThinking: () => command(async () => {
        const model = agentModel();
        if (!model.reasoning) throw new Error("Current model does not support thinking");
        const levels = getSupportedThinkingLevels(model);
        const level = agentOf(state.conversation).thinkingLevel ?? "off";
        const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
        await current.configure({ thinkingLevel: next }, context);
      }),
      setThinkingLevel: (targetLevel) => command(async () => {
        const model = agentModel();
        if (!model.reasoning) throw new Error("Current model does not support thinking");
        await current.configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, context);
      }),
      setModel: (ref) => command(async () => {
        const model = modelRuntime.getModel(ref.provider, ref.modelId);
        if (model === void 0) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
        const thinking = agentOf(state.conversation).thinkingLevel ?? "off";
        await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
      }),
      toggleTasks: () => command(async () => {
        if (tasks !== void 0) {
          closeTasks();
          update({ tasks: void 0 });
          return;
        }
        const graph = await opened.taskGraph(context);
        tasks = graph;
        unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
      }),
      switchConversation: (id) => command(async () => {
        const next = await opened.conversation(id, context);
        if (next === void 0) throw new Error(`Conversation ${id} does not exist`);
        const nextState = await next.viewState(context);
        unsubscribe();
        conversation.dispose();
        current = next;
        conversation = nextState;
        unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
      })
    };
    const saved = agentOf(state.conversation).model;
    if (saved === void 0) notice("warning", "No model configured; select one with /model.");
    else if (modelRuntime.getModel(saved.provider, saved.modelId) === void 0) {
      notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
    }
    if (initial?.fallbackMessage !== void 0) notice("info", initial.fallbackMessage);
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
        closing ??= (async () => {
          unsubscribe();
          unsubscribeCommits();
          conversation.dispose();
          closeTasks();
          try {
            await opened.close(context);
            await envs.cleanup(context);
          } finally {
            await location.release();
          }
        })();
        return closing;
      }
    };
  } catch (error) {
    await harness?.close(context).catch(() => {
    });
    await location.release().catch(() => {
    });
    throw error;
  }
}

// src/runner/index.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2, watchEvents } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";

// src/runner/bridge/assistant-message-builder.ts
function buildFinalAssistantMessage(current, lastGenerationText, lastThinkingText) {
  const entries = current.conversation.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find((e) => e.kind === "pi.assistant");
  const lastAssistantMsg = lastAssistantEntry?.model?.[0];
  if (lastAssistantMsg) {
    return {
      role: "assistant",
      content: lastAssistantMsg.content ?? [{ type: "text", text: lastGenerationText }],
      stopReason: lastAssistantMsg.stopReason ?? "stop",
      usage: lastAssistantMsg.usage
    };
  }
  const finalContent = [];
  if (lastThinkingText) {
    finalContent.push({ type: "thinking", thinking: lastThinkingText });
  }
  if (lastGenerationText) {
    finalContent.push({ type: "text", text: lastGenerationText });
  }
  const usageDoc = current.conversation.docs["pi.usage"] ?? {};
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
var BBEventAdapter = class {
  output;
  lastAssistantMessage;
  currentText = "";
  currentThinking = "";
  constructor(output2) {
    this.output = output2;
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
              assistantMessageEvent: {
                type: "thinking_delta",
                contentIndex: 0,
                delta: change.delta
              }
            });
          } else if (change.type === "text_delta") {
            this.currentText += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: change.delta
              }
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
          if ("set" in event.output) {
            partialResult = event.output.set;
          } else if ("append" in event.output) {
            partialResult = event.output.append ?? "";
          }
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
        const toolResultMsg = event.entry?.model?.[0];
        const isError = toolResultMsg?.isError ?? false;
        let result = "";
        if (Array.isArray(toolResultMsg?.content)) {
          result = toolResultMsg.content.map((block) => block && typeof block === "object" && "text" in block ? block.text : "").filter(Boolean).join("\n");
        } else if (typeof toolResultMsg?.content === "string") {
          result = toolResultMsg.content;
        }
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
        const msg = event.entry?.model?.[0];
        if (msg?.role === "assistant") {
          this.lastAssistantMessage = {
            role: "assistant",
            content: msg.content ?? [{ type: "text", text: this.currentText }],
            stopReason: msg.stopReason ?? "stop",
            usage: msg.usage
          };
          this.output({
            type: "message_end",
            message: this.lastAssistantMessage
          });
        }
        break;
      }
      case "turn_end": {
        const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
          current,
          this.currentText,
          this.currentThinking
        );
        this.output({
          type: "turn_end",
          message: finalMsg
        });
        break;
      }
      case "run_end": {
        const finalMsg = this.lastAssistantMessage ?? buildFinalAssistantMessage(
          current,
          this.currentText,
          this.currentThinking
        );
        this.output({
          type: "agent_end",
          messages: [finalMsg]
        });
        break;
      }
    }
  }
};

// src/runner/index.ts
function parseCliArgs(argv2) {
  const args2 = {};
  for (let i = 0; i < argv2.length; i++) {
    const arg = argv2[i];
    if (arg === "--mode" && i + 1 < argv2.length) args2.mode = argv2[++i];
    else if (arg === "--session" && i + 1 < argv2.length) args2.session = argv2[++i];
    else if (arg === "--continue") args2.continueSession = true;
    else if (arg === "--no-session") args2.noSession = true;
    else if (arg === "--provider" && i + 1 < argv2.length) args2.provider = argv2[++i];
    else if (arg === "--model" && i + 1 < argv2.length) args2.model = argv2[++i];
    else if (arg === "--thinking" && i + 1 < argv2.length) args2.thinking = argv2[++i];
    else if (arg === "--system-prompt" && i + 1 < argv2.length) args2.systemPromptPath = argv2[++i];
    else if (arg === "--append-system-prompt" && i + 1 < argv2.length) args2.appendSystemPromptPath = argv2[++i];
    else if (arg === "--extension" && i + 1 < argv2.length) args2.extension = argv2[++i];
    else if (!arg.startsWith("-") && !args2.cwd) args2.cwd = arg;
  }
  return args2;
}
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
    const pluginPkg = join3(__dirname, "..", "..", "package.json");
    if (existsSync2(pluginPkg)) {
      const parsed = JSON.parse(readFileSync2(pluginPkg, "utf8"));
      const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
      if (dep) return dep;
    }
  } catch {
  }
  return "1.0.0";
}
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(getPiDurableVersion());
  process.exit(0);
}
var args = parseCliArgs(argv);
function output(data) {
  process.stdout.write(serializeJsonLine(data));
}
var CHILD_TO_BRIDGE_FD = 3;
var BRIDGE_TO_CHILD_FD = 4;
var sendToBridge = (_msg) => {
};
try {
  sendToBridge = (msg) => {
    const str = `${JSON.stringify(msg)}
`;
    try {
      writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
    } catch {
    }
  };
} catch {
}
async function main() {
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.stdin.on("end", () => process.exit(0));
  const cwd = args.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager2.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime2.create();
  const resourceLoader = new DefaultResourceLoader2({ cwd, agentDir, settingsManager });
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
  const initialAgent = await findInitialAgentModel(
    settingsManager,
    modelRuntime,
    args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : void 0
  );
  const defaultModel = initialAgent.model ? modelRuntime.getModel(initialAgent.model.provider, initialAgent.model.modelId) ?? availableModels[0] : availableModels[0];
  const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : void 0;
  const defaultThinkingLevel = initialAgent.thinkingLevel ?? "off";
  const modelScope = {
    scopedModelIds: availableModels.map((m) => `${m.provider}/${m.id}`),
    defaultModelId
  };
  sendToBridge({ kind: "model-scope", ...modelScope });
  sendToBridge({ ready: true, kind: "ready" });
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
            sendToBridge({ kind: "reply", id: req.id, result: modelScope });
          } else if (req.method === "refresh-models") {
            sendToBridge({ kind: "reply", id: req.id, result: { refreshed: true } });
          } else if (req.method === "leaf") {
            sendToBridge({ kind: "reply", id: req.id, result: { leafId: null } });
          } else {
            sendToBridge({ kind: "reply", id: req.id, result: {} });
          }
        }
      } catch {
      }
    });
  } catch {
  }
  const success = (id, command, data) => {
    output({ id, type: "response", command, success: true, data });
  };
  const error = (id, command, message) => {
    output({ id, type: "response", command, success: false, error: message });
  };
  if (args.noSession) {
    attachJsonlLineReader(process.stdin, (line) => {
      if (!line.trim()) return;
      try {
        const cmd = JSON.parse(line);
        if (cmd.type === "get_available_models") {
          const currentModels = modelRuntime.getAvailableSnapshot();
          success(cmd.id, "get_available_models", { models: currentModels });
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
  const adapter = new BBEventAdapter((evt) => output(evt));
  const stream = await watchEvents(durable.harness, ROOT_CONVERSATION_ID2, BACKGROUND_CONTEXT2);
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
    switch (cmd.type) {
      case "prompt": {
        if (!cmd.message) {
          error(cmd.id, "prompt", "Missing message");
          return;
        }
        success(cmd.id, "prompt");
        await durable.controller.submit(cmd.message, "steer");
        break;
      }
      case "steer": {
        if (!cmd.message) {
          error(cmd.id, "steer", "Missing message");
          return;
        }
        success(cmd.id, "steer");
        await durable.controller.submit(cmd.message, "steer");
        break;
      }
      case "abort": {
        await durable.controller.abort();
        success(cmd.id, "abort");
        break;
      }
      case "compact": {
        output({ type: "compaction_start", reason: "manual" });
        await durable.controller.compact(cmd.instructions);
        output({ type: "compaction_end", reason: "manual", aborted: false });
        success(cmd.id, "compact");
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
        success(cmd.id, "get_state", {
          model: modelObj,
          thinkingLevel: agentDoc.thinkingLevel ?? "none",
          cwd: args.cwd ?? process.cwd(),
          sessionId: args.session ?? "default"
        });
        break;
      }
      case "get_available_models": {
        const currentModels = modelRuntime.getAvailableSnapshot();
        success(cmd.id, "get_available_models", { models: currentModels });
        break;
      }
      case "set_model": {
        if (!cmd.provider || !cmd.modelId) {
          error(cmd.id, "set_model", "Missing provider or modelId");
          return;
        }
        await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
        success(cmd.id, "set_model");
        break;
      }
      case "set_thinking_level": {
        await durable.controller.setThinkingLevel(cmd.level);
        success(cmd.id, "set_thinking_level");
        break;
      }
      case "get_session_stats": {
        const current = durable.view.current();
        const usageDoc = current.conversation.docs["pi.usage"] ?? {};
        const agentDoc = current.conversation.docs["pi.agent"] ?? {};
        const totalTokens = usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0);
        let contextWindow = 128e3;
        if (agentDoc.model?.provider && agentDoc.model?.modelId) {
          const m = modelRuntime.getModel(agentDoc.model.provider, agentDoc.model.modelId);
          if (m?.contextWindow) contextWindow = m.contextWindow;
        }
        success(cmd.id, "get_session_stats", {
          contextUsage: {
            tokens: totalTokens,
            contextWindow
          }
        });
        break;
      }
      default: {
        error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
        break;
      }
    }
  });
}
main().catch((err) => {
  console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
//# sourceMappingURL=index.js.map
