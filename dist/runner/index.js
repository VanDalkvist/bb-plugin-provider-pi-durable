import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);

// src/runner/index.ts
import { writeSync } from "node:fs";
import { Socket } from "node:net";

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
  formatSkillsForPrompt,
  loadProjectContextFiles,
  loadSkills
} from "@earendil-works/pi-coding-agent";

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

// src/runner/prompt.ts
var KEYS = ["preamble", "tools", "rules", "docs", "project_context", "skills", "append_prompt", "cwd"];
function createPiPrompt(settings, fallbackCwd, options = {}) {
  const resources = /* @__PURE__ */ new Map();
  const load = (cwd) => {
    let found = resources.get(cwd);
    if (found === void 0) {
      const agentDir = getAgentDir();
      found = {
        contextFiles: loadProjectContextFiles({ cwd, agentDir }),
        skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills
      };
      resources.set(cwd, found);
    }
    return found;
  };
  let appendedContent = "";
  if (options.appendSystemPromptPath && existsSync(options.appendSystemPromptPath)) {
    try {
      appendedContent = readFileSync(options.appendSystemPromptPath, "utf8").trim();
    } catch (err) {
      console.error(`Warning: failed to read append-system-prompt: ${err}`);
    }
  }
  let systemPromptOverride = "";
  if (options.systemPromptPath && existsSync(options.systemPromptPath)) {
    try {
      systemPromptOverride = readFileSync(options.systemPromptPath, "utf8").trim();
    } catch (err) {
      console.error(`Warning: failed to read system-prompt: ${err}`);
    }
  }
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
    const sections = {};
    if (systemPromptOverride) {
      sections.preamble = systemPromptOverride;
    }
    if (contextFiles && contextFiles.length > 0) {
      sections.project_context = contextFiles.map((cf) => `<project_instructions path="${cf.path}">
${cf.content}
</project_instructions>`).join("\n\n");
    }
    if (skills && skills.length > 0) {
      sections.skills = formatSkillsForPrompt(skills);
    }
    if (appendedContent) {
      sections.append_prompt = appendedContent;
    }
    sections.cwd = `<cwd>
${cwd}
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
      thinkingLevel: cli.thinking ?? resolved.thinkingLevel ?? "none"
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
        thinkingLevel: defaultThinkingLevel ?? "none"
      };
    }
  }
  const available = modelRuntime.getAvailableSnapshot();
  if (available.length > 0) {
    return {
      model: { provider: available[0].provider, modelId: available[0].id },
      thinkingLevel: "none"
    };
  }
  return {};
}

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
    first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
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
import { ModelRuntime as ModelRuntime2, SettingsManager as SettingsManager2 } from "@earendil-works/pi-coding-agent";

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

// src/runner/bridge/bb-event-adapter.ts
function resolveToolCallArgs(callId, current) {
  const live = current.conversation.docs["pi.live"] ?? {};
  const activeCalls = live.generation?.message?.content?.filter(
    (b) => b.type === "toolCall"
  );
  if (activeCalls) {
    const matched = activeCalls.find((c) => c.id === callId || c.callId === callId);
    if (matched?.arguments && typeof matched.arguments === "object") {
      return matched.arguments;
    }
  }
  const entries = Object.values(current.conversation.entries ?? {});
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind === "pi.assistant" && Array.isArray(entry?.model)) {
      for (const msg of entry.model) {
        if (Array.isArray(msg?.content)) {
          for (const part of msg.content) {
            if (part.type === "toolCall" && (part.id === callId || part.callId === callId)) {
              if (part.arguments && typeof part.arguments === "object") {
                return part.arguments;
              }
            }
          }
        }
      }
    }
  }
  const slot = (live.tools ?? []).find((s) => (s.callId ?? String(s.id)) === callId);
  if (slot?.args && typeof slot.args === "object") {
    return slot.args;
  }
  return {};
}
var BBEventAdapter = class {
  output;
  inTurn = false;
  lastGenerationText = "";
  lastThinkingText = "";
  seenTools = /* @__PURE__ */ new Map();
  constructor(output2) {
    this.output = output2;
  }
  sync(current) {
    const live = current.conversation.docs["pi.live"] ?? {};
    const hasActiveTools = (live.tools ?? []).some(
      (s) => s.status === "running" || s.status === "pending"
    );
    const isBusy = live.run?.status === "running" || live.generation !== void 0 || hasActiveTools;
    if (isBusy && !this.inTurn) {
      this.inTurn = true;
      this.lastGenerationText = "";
      this.lastThinkingText = "";
      this.seenTools.clear();
      this.output({ type: "agent_start" });
      this.output({ type: "turn_start" });
    }
    if (live.generation?.message?.content) {
      let currentText = "";
      let currentThinking = "";
      for (const block of live.generation.message.content) {
        if (block.type === "text") {
          currentText += block.text ?? "";
        } else if (block.type === "thinking") {
          currentThinking += block.thinking ?? "";
        }
      }
      if (currentThinking.length > this.lastThinkingText.length) {
        const delta = currentThinking.slice(this.lastThinkingText.length);
        this.lastThinkingText = currentThinking;
        this.output({
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta
          }
        });
      }
      if (currentText.length > this.lastGenerationText.length) {
        const delta = currentText.slice(this.lastGenerationText.length);
        this.lastGenerationText = currentText;
        this.output({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta
          }
        });
      }
    }
    for (const slot of live.tools ?? []) {
      const callId = slot.callId ?? String(slot.id);
      const prev = this.seenTools.get(callId);
      if (!prev) {
        const toolArgs = resolveToolCallArgs(callId, current);
        const toolName = slot.toolName ?? "unknown";
        this.output({
          type: "tool_execution_start",
          toolCallId: callId,
          toolName,
          args: toolArgs
        });
        const resultStr = typeof slot.result === "string" ? slot.result : "";
        this.seenTools.set(callId, { status: slot.status, resultLen: resultStr.length });
      } else if (slot.status === "running" && typeof slot.result === "string" && slot.result.length > prev.resultLen) {
        const partial = slot.result.slice(prev.resultLen);
        this.seenTools.set(callId, { status: slot.status, resultLen: slot.result.length });
        this.output({
          type: "tool_execution_update",
          toolCallId: callId,
          toolName: slot.toolName ?? "unknown",
          partialResult: partial
        });
      }
      if ((slot.status === "completed" || slot.status === "failed") && prev?.status !== slot.status) {
        const isError = slot.status === "failed" || slot.isError === true;
        this.seenTools.set(callId, {
          status: slot.status,
          resultLen: typeof slot.result === "string" ? slot.result.length : 0
        });
        this.output({
          type: "tool_execution_end",
          toolCallId: callId,
          toolName: slot.toolName ?? "unknown",
          result: slot.result ?? null,
          isError
        });
      }
    }
    if (!isBusy && this.inTurn) {
      this.inTurn = false;
      this.output({ type: "turn_end" });
      const finalContent = [];
      if (this.lastThinkingText) {
        finalContent.push({ type: "thinking", thinking: this.lastThinkingText });
      }
      if (this.lastGenerationText) {
        finalContent.push({ type: "text", text: this.lastGenerationText });
      }
      const usageDoc = current.conversation.docs["pi.usage"] ?? {};
      const finalMsg = {
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
      this.output({
        type: "agent_end",
        messages: [finalMsg]
      });
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
    else if (arg === "--provider" && i + 1 < argv2.length) args2.provider = argv2[++i];
    else if (arg === "--model" && i + 1 < argv2.length) args2.model = argv2[++i];
    else if (arg === "--thinking" && i + 1 < argv2.length) args2.thinking = argv2[++i];
    else if (arg === "--system-prompt" && i + 1 < argv2.length) args2.systemPromptPath = argv2[++i];
    else if (arg === "--append-system-prompt" && i + 1 < argv2.length) args2.appendSystemPromptPath = argv2[++i];
    else if (!arg.startsWith("-") && !args2.cwd) args2.cwd = arg;
  }
  return args2;
}
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log("1.0.4");
  process.exit(0);
}
var args = parseCliArgs(argv);
function output(data) {
  process.stdout.write(serializeJsonLine(data));
}
var hasFd3 = Boolean(process.env.BB_PI_BRIDGE_FD3 || process.env.PI_RPC_BRIDGE_CHANNEL);
var sendToBridge = (payload) => {
  if (!hasFd3) return;
  try {
    writeSync(3, `${JSON.stringify(payload)}
`);
  } catch {
  }
};
async function main() {
  const modelRuntime = await ModelRuntime2.create();
  const settingsManager = SettingsManager2.create(args.cwd ?? process.cwd());
  const models = modelRuntime.getAvailableSnapshot();
  const initialAgent = await findInitialAgentModel(
    settingsManager,
    modelRuntime,
    args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : void 0
  );
  sendToBridge({
    kind: "model-scope",
    scopedModelIds: models.map((m) => `${m.provider}/${m.id}`),
    defaultModelId: initialAgent.model ? `${initialAgent.model.provider}/${initialAgent.model.modelId}` : void 0
  });
  if (process.env.BB_PI_BRIDGE_FD4) {
    try {
      const fd4Socket = new Socket({ fd: 4, readable: true, writable: false });
      attachJsonlLineReader(fd4Socket, (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg?.kind === "ping") sendToBridge({ kind: "pong" });
        } catch {
        }
      });
    } catch {
    }
  }
  sendToBridge({ ready: true, kind: "ready" });
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
  durable.view.subscribe(() => {
    try {
      adapter.sync(durable.view.current());
    } catch (err) {
      console.error(`Adapter sync error: ${err}`);
    }
  });
  const success = (id, command, data) => {
    output({ id, type: "response", command, success: true, data });
  };
  const error = (id, command, message) => {
    output({ id, type: "response", command, success: false, error: message });
  };
  attachJsonlLineReader(process.stdin, async (line) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (!cmd || typeof cmd !== "object" || !cmd.type) return;
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
        success(cmd.id, "get_state", {
          model: agentDoc.model,
          thinkingLevel: agentDoc.thinkingLevel,
          cwd: current.session.cwd,
          sessionId: current.session.id
        });
        break;
      }
      case "get_session_stats": {
        const current = durable.view.current();
        const usageDoc = current.conversation.docs["pi.usage"] ?? {};
        const tokens = usageDoc.totalTokens ?? (usageDoc.input ?? 0) + (usageDoc.output ?? 0);
        const agentDoc = current.conversation.docs["pi.agent"] ?? {};
        const modelRef = agentDoc?.model;
        const modelMeta = modelRef ? durable.modelRuntime.getModel(modelRef.provider, modelRef.modelId) : void 0;
        const contextWindow = modelMeta?.contextWindow ?? 1048576;
        success(cmd.id, "get_session_stats", {
          contextUsage: { tokens, contextWindow }
        });
        break;
      }
      case "set_model": {
        const modelsList = durable.modelRuntime.getAvailableSnapshot();
        const target = modelsList.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
        if (!target) {
          error(cmd.id, "set_model", `Model not found: ${cmd.provider}/${cmd.modelId}`);
          return;
        }
        await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
        success(cmd.id, "set_model", target);
        break;
      }
      case "set_thinking_level": {
        if (cmd.level) {
          await durable.controller.setThinkingLevel(cmd.level);
        } else {
          await durable.controller.cycleThinking();
        }
        success(cmd.id, "set_thinking_level");
        break;
      }
      case "get_available_models": {
        success(cmd.id, "get_available_models", durable.modelRuntime.getAvailableSnapshot());
        break;
      }
      default: {
        error(cmd.id, cmd.type, `Unknown command: ${cmd.type}`);
        break;
      }
    }
  });
  const cleanup = async () => {
    try {
      await durable.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
main().catch((err) => {
  console.error("Durable runner initialization failed:", err);
  process.exit(1);
});
//# sourceMappingURL=index.js.map
