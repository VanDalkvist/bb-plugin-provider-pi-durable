import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packageJsonPath = path.join(rootDir, "package.json");

test("package.json integrity: dependencies and devDependencies are strictly disjoint (AP-010, AP-026)", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  const deps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});

  const intersection = deps.filter((dep) => devDeps.includes(dep));
  assert.deepEqual(
    intersection,
    [],
    `Found duplicate dependencies across dependencies and devDependencies: ${intersection.join(", ")}. In npm, duplicates in devDependencies cause packages to be omitted under --omit=dev, breaking clean marketplace builds.`
  );
});

test("package.json integrity: @get-bb/plugin-sdk is strictly in dependencies (SawyerHood review blocker)", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  assert.ok(
    pkg.dependencies && pkg.dependencies["@get-bb/plugin-sdk"],
    "@get-bb/plugin-sdk must be present in production dependencies"
  );
  assert.equal(
    pkg.devDependencies && pkg.devDependencies["@get-bb/plugin-sdk"],
    undefined,
    "@get-bb/plugin-sdk must NOT be present in devDependencies"
  );
});

test("package.json integrity: @get-bb/plugin-sdk is strictly pinned to 0.6.79 and engines meet baseline", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  assert.equal(pkg.dependencies?.["@get-bb/plugin-sdk"], "0.6.79", "@get-bb/plugin-sdk must be exact 0.6.79");
  assert.equal(pkg.engines?.bbPluginSdk, ">=0.6.79", "engines.bbPluginSdk must require >=0.6.79");
  assert.equal(pkg.engines?.bb, ">=0.47.1", "engines.bb must require >=0.47.1");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-durable"], "1.3.0", "Pi Durable must remain exact installed 1.3.0");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], "1.3.0", "Pi Coding Agent must remain exact installed 1.3.0");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-codemode"], "1.3.0", "Pi Codemode must remain exact installed 1.3.0");
  assert.equal(pkg.overrides?.["@earendil-works/chord"], "1.3.0", "chord override must be exact 1.3.0");
  assert.equal(pkg.overrides?.["@earendil-works/pi-ai"], "1.3.0", "pi-ai override must be exact 1.3.0");
});

test("package.json integrity: manifest entries point to canonical source paths", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  assert.equal(pkg.bb?.server, "./server.ts", "bb.server must point to ./server.ts to prevent circular build bundling");
  assert.equal(pkg.bb?.host, "./src/host/index.ts", "bb.host must point to ./src/host/index.ts");

  assert.ok(fs.existsSync(path.join(rootDir, pkg.bb.server)), "server entrypoint file must exist on disk");
  assert.ok(fs.existsSync(path.join(rootDir, pkg.bb.host)), "host entrypoint file must exist on disk");
});

test("package.json integrity: runtime dependencies contain all modules imported by host and runner", () => {
  const content = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content);

  const deps = Object.keys(pkg.dependencies || {});
  assert.ok(deps.includes("@get-bb/plugin-sdk"), "missing @get-bb/plugin-sdk");
  assert.ok(deps.includes("@earendil-works/pi-durable"), "missing @earendil-works/pi-durable");
  assert.ok(deps.includes("@earendil-works/pi-coding-agent"), "missing @earendil-works/pi-coding-agent");
  assert.ok(deps.includes("@earendil-works/pi-codemode"), "missing @earendil-works/pi-codemode");
  assert.strictEqual(pkg.dependencies["@earendil-works/pi-durable"], "1.3.0");
  assert.strictEqual(pkg.dependencies["@earendil-works/pi-coding-agent"], "1.3.0");
  assert.strictEqual(pkg.dependencies["@earendil-works/pi-codemode"], "1.3.0");
  assert.ok(deps.includes("proper-lockfile"), "missing proper-lockfile");
  assert.ok(deps.includes("zod"), "missing zod");
  assert.strictEqual(pkg.overrides?.["@earendil-works/chord"], "1.3.0");
  assert.strictEqual(pkg.overrides?.["@earendil-works/pi-ai"], "1.3.0");
});

test("server.ts registers current settings, rpc, and provider without legacy disposal", async () => {
  const plugin = (await import("../server.ts")).default;
  let registeredSettings: any = null;
  let registeredRpc: any = null;
  let registeredProvider: any = null;

  const fakeHost = {
    storage: {
      kv: {
        get: async () => undefined,
        set: async () => {},
      },
    },
    settings: {
      define(settings: any) {
        registeredSettings = settings;
      },
    },
    rpc: {
      register(contract: any, handlers: any) {
        registeredRpc = { contract, handlers };
      },
    },
    providers: {
      register(declaration: any) {
        registeredProvider = declaration;
        return { dispose() {} };
      },
    },
  };

  await plugin(fakeHost as any);

  assert.ok(registeredSettings?.hideThinking, "hideThinking setting must be defined");
  assert.ok(registeredRpc?.handlers?.diagnostics_get, "diagnostics_get rpc must be registered");
  assert.equal(registeredProvider?.id, "pi-durable", "pi-durable provider must be registered");
  assert.equal(typeof registeredProvider?.deriveProviderOptions, "function");
});
