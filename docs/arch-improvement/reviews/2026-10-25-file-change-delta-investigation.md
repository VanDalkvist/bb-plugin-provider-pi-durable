# File-Change Delta Investigation Report

**Date:** 2026-10-25  
**Scenario:** Worker thread `thr_wwgrn2pqdu`, edits to `child-turn-guard.ts` and `session-owner.ts` around commit `9416d0d`.  
**Screenshot reference:** `/Users/vanya/.bb/thread-storage/thr_3e4z9meeqs/Attachments/image-1792944062046-dc5mcn.png`  
**Scope:** Phase A root-cause investigation (read-only; no production edits, no new repository test files, no commits).

---

## 1. Proven Symptoms (Expected vs. Observed)

From visual analysis of the provided screenshot and examination of the event logs (`bb thread log thr_wwgrn2pqdu --json --all`):

| UI Element | Observed Behavior | Expected Behavior |
|---|---|---|
| **`child-turn-guard.ts` timeline rows** | 4 separate timeline entries: <br>1. `Edited child-turn-guard.ts +8 -6` (expanded)<br>2. `Edited child-turn-guard.ts +3 -3`<br>3. `Edited child-turn-guard.ts +2 -2`<br>4. `Edited child-turn-guard.ts +1 -1` | Exactly 1 timeline entry for `child-turn-guard.ts` representing the single `edit` tool call: <br>`Edited child-turn-guard.ts +8 -6` |
| **`child-turn-guard.ts` diff card content** | Expanded diff box shows header `+1 -0` and displays only lines 1–7 with trailing `...`, truncating 4 out of 5 hunks | Unified diff showing all 5 hunks (+8 -6) across the whole file with correct line numbers and no truncation |
| **`session-owner.ts` timeline row** | Single timeline entry `Edited session-owner.ts +6 -3` (expanded) | Single timeline entry `Edited session-owner.ts +6 -3` (row header is correct) |
| **`session-owner.ts` diff card content** | Expanded diff box shows header `+1 -0` and displays only lines 1–5, discarding lines 6–32 | Unified diff showing the full hunk (+6 -3) with correct line numbers and no truncation |

---

## 2. Executed vs. Checkout Versions

During development, the installed plugin was not updated or reloaded. The live producer process ran on an earlier installed build:

| Component | Executed / Resident Runtime | Current Checkout (`main`) |
|---|---|---|
| **Plugin package** | `provider-pi-durable@0.2.52` | `provider-pi-durable@0.2.52` |
| **Git commit** | `4d02d4c7aefd84a9cc2576f28fca109d5ca34600` | `01ce56193bb92b3eb5984ba04a9d702cae449265` (+5 commits: `8cce858`, `9416d0d`, `563ae2c`, `4a3dab9`, `01ce561`) |
| **Plugin artifact path** | `~/.bb/plugin-host-artifacts/provider-pi-durable/31bfeb06.../host.mjs` (built Oct 25 14:28) | `./dist/host.js` (built Oct 25 19:24) |
| **`@get-bb/plugin-sdk`** | `0.6.60` (in `4d02d4c.../node_modules`) | `0.6.79` |
| **`@earendil-works/pi-durable`** | `1.3.0` | `1.3.0` |
| **`@earendil-works/pi-coding-agent`** | `1.3.0` | `1.3.0` |
| **`@earendil-works/pi-ai`** | `1.3.0` | `1.3.0` |
| **BB IDE Desktop** | `0.47.1` (`/Applications/bb.app/Contents/Resources/app.asar.unpacked`) | `0.47.1` (`~/Projects/bb-reference`) |
| **Upstream Pi source** | `~/Projects/pi` (packages: durable 1.3.0, coding-agent 1.3.0) | `~/Projects/pi` 1.3.0 |

*Note:* The bug exists identically in both `4d02d4c` and current checkout `01ce561`. The tool-item-shape and diff-utils logic did not change between these commits.

---

## 3. Causal Chain and Code Path

### Step 1: Upstream Native `edit` Tool Execution
In `@earendil-works/pi-coding-agent` (`packages/coding-agent/src/core/tools/edit.ts:199–208`):
```typescript
const diffResult = generateDiffString(baseContent, newContent);
const patch = generateUnifiedPatch(path, baseContent, newContent);
return {
  content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
  details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
};
```
- `diffResult.diff`: Human-readable TUI string formatted for terminal display. It prefixes lines with terminal line numbers (`+  1 ...`, `   1 ...`, `+ 11 ...`) and inserts literal ellipsis markers (`     ...`) between unchanged sections. It has **no** `diff --git` or `@@ -x,y +x,y @@` hunk headers.
- `patch`: Standard unified git diff conforming to POSIX / git diff format (`--- a/...`, `+++ b/...`, `@@ -start,count +start,count @@`).

### Step 2: Start Event Translation (Root Cause 1 — File Identity Fragmentation)
In `src/host/tool-item-shape.ts:50–70`:
```typescript
if (toolName === "edit") {
  const filePath = normalizeFilePath(args.path, fallbackCwd);
  if (!filePath) return { type: "fileChange", changes: [] };
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length > 0) {
    const changes = edits.map((edit: unknown) => {
      const e = typeof edit === "object" && edit !== null ? (edit as RawEditItem) : undefined;
      return {
        path: filePath,
        kind: "update",
        ...(typeof e?.oldText === "string" ? { oldText: e.oldText } : {}),
        ...(typeof e?.newText === "string" ? { newText: e.newText } : {}),
      };
    });
    return { type: "fileChange", changes };
  }
...
```
- **The flaw:** When `args.edits` had 4 entries (`child-turn-guard.ts`), `buildToolItemShape` created 4 entries in `item.changes`, all with the exact same `path: "src/host/child-turn-guard.ts"`.
- In BB Provider Bridge protocol and BB Server (`delta-assembler.ts:748–758` & `server/dist/start-server.js:2771414`), each entry in `changes` represents a **distinct file**, NOT an individual replacement hunk.
- BB Server projects every element of `changes` into an independent timeline row:
  `id: ${base.id}:file-change:${index2}`, `workKind: "file-change"`.
- This explains why `child-turn-guard.ts` was duplicated 4 times in the timeline.

### Step 3: End Event Translation (Root Cause 2 — TUI Display String Preferred over Unified Patch)
In `src/host/diff-utils.ts:118–125`:
```typescript
const detailsObj = typeof event.details === "object" && event.details !== null
  ? (event.details as Record<string, unknown>)
  : undefined;
const rawDiff = typeof detailsObj?.diff === "string"
  ? detailsObj.diff
  : typeof detailsObj?.patch === "string"
    ? detailsObj.patch
    : undefined;
```
- **The flaw:** The code explicitly checks `detailsObj?.diff` first. Because `@earendil-works/pi-coding-agent` always returns both `diff` and `patch`, `rawDiff` was **always** assigned `detailsObj.diff` (the TUI display string), completely discarding `detailsObj.patch` (the standard unified diff).

### Step 4: End Event Translation (Root Cause 3 — Whole-File Diff Attached Only to Index 0)
In `src/host/diff-utils.ts:145–165`:
```typescript
return {
  ...item,
  changes: item.changes.map((change: unknown, index: number) => {
    ...
    if (index === 0 && diff) {
      return { ...ch, path: normalizedPath, diff };
    }
    return { ...ch, path: normalizedPath };
  }),
};
```
- `changes[0]` received the whole-file TUI string (`diff`).
- `changes[1..3]` received `diff: undefined`.
- In `delta-assembler.ts:508–514`, because `changes[1..3]` had `diff: undefined` but possessed `oldText`/`newText`, `delta-assembler` fell back to `buildEditDiff(oldText, newText)` and synthesized snippet patches for each individual block (+3 -3, +2 -2, +1 -1).
- In BB Server (`start-server.js:getFileChangeDiffStats`):
  - `changes[0]` counted 8 `+` lines and 6 `-` lines -> stats `+8 -6`.
  - `changes[1]` counted snippet diff -> stats `+3 -3`.
  - `changes[2]` counted snippet diff -> stats `+2 -2`.
  - `changes[3]` counted snippet diff -> stats `+1 -1`.
- This explains the exact row headers in the screenshot:
  `Edited child-turn-guard.ts +8 -6`
  `Edited child-turn-guard.ts +3 -3`
  `Edited child-turn-guard.ts +2 -2`
  `Edited child-turn-guard.ts +1 -1`

### Step 5: BB UI Diff Parser Truncation (Why Inner Card Shows `+1 -0`)
In BB Desktop UI bundle (`TimelineFileDiffBlock-D8LdhuCu.js` and `dist-CXXcNKpg.js`):
1. In `TimelineFileDiffBlock.js` function `E(e)`:
   - For `changes[0]` and `session-owner.ts`, `e.diff` has NO `@@` hunk headers (it contains `+  1 ...`, `   1 ...`, `     ...`).
   - `E(e)` fails the unified diff check and falls back to `T(e)`:
     `T(e)` counts `-` lines (`r`) and `+` lines (`i`) and fabricates a single fake header:
     `@@ -1,${Math.max(r, 1)} +1,${Math.max(i, 1)} @@\n${lines.join('\n')}`.
     For `child-turn-guard.ts`, `r=6, i=8` -> `@@ -1,6 +1,8 @@`.
     For `session-owner.ts`, `r=3, i=6` -> `@@ -1,3 +1,6 @@`.
2. In `dist-CXXcNKpg.js` diff parser (`Gp`):
   - The parser iterates over lines in the fake hunk.
   - For an addition line (`+`), it increments `T++`.
   - For a context line (lines starting with space `   1 ...`), it increments **both** `T++` and `E++`.
   - Loop termination check: `if (T >= w.additionCount && E >= w.deletionCount) break;`.
   - In `child-turn-guard.ts`:
     - Line 1: `+  1 import ...` -> `T=1, E=0` (addition)
     - Lines 2–7: `   1 import ...`, `   2`, `   3 ...`, `   4 ...`, `     ...`, `   6 ...` -> context lines!
     - By line 7: `T=7, E=6` (E reached 6, which equals `deletionCount` 6).
     - On line 8 (`   7 runner...`), `T` reaches 8 and `E` reaches 7 -> **`T >= 8 && E >= 6` triggers `break`!**
     - The parser terminates the hunk after line 7, discarding the remaining 58 lines!
     - Within the parsed hunk (lines 1–7): exactly 1 added line (`+  1 import ...`) and 0 deleted lines.
     - The diff card header renders: `src/host/child-turn-guard.ts +1 -0`.
   - In `session-owner.ts`:
     - Line 1: `+ 1 import ...` -> `T=1, E=0`
     - Lines 2–6: context lines -> by line 6: `T=6, E=5` (T reached 6, E reached 3) -> **triggers `break`!**
     - The parser terminates after line 5, discarding the rest of the file.
     - Within the parsed hunk (lines 1–5): exactly 1 added line and 0 deleted lines.
     - The diff card header renders: `src/host/session-owner.ts +1 -0`.

---

## 4. Reproducible Fixture and Evidence

A semantic reproduction script was executed against the exact SQLite records from `thr_wwgrn2pqdu` (entries 1209, 1211, 1213, 1215 in `~/.bb/pi-bridge-sessions/pi_durable_1792939250219/session.sqlite`):

**Reproduction command (from any thread):**
```bash
BB_THREAD_STORAGE=/Users/vanya/.bb/thread-storage/thr_squn93nr4e node --import tsx /Users/vanya/.bb/thread-storage/thr_squn93nr4e/investigation/repro.test.mjs
```

**Output from execution:**
```text
=== CASE 1: MULTI-EDIT TOOL CALL (child-turn-guard.ts) ===
[Buggy] changes count: 4 (expected 1 file, got multiple)
[Buggy] change 0 parsePatch hunks: 0
[Buggy] changes 1..3 have diff: [ false, false, false ]
[Fixed] changes count: 1
[Fixed] patch hunks count: 5
[Fixed] totals: +8 -6 (expected +8 -6)
[Fixed] patch applies cleanly to pre-commit base? true

=== CASE 2: SINGLE-EDIT TOOL CALL (session-owner.ts) ===
[Buggy] change 0 parsePatch hunks: 0
[Fixed] patch hunks count: 1
[Fixed] totals: +6 -3 (expected +6 -3)
[Fixed] patch applies cleanly to pre-commit base? true
```

**Verification against repository baseline:**
Applying the normalized patch from `details.patch` directly against git commit `9416d0d^` via `diff.applyPatch` succeeds with zero errors (`applyPatch !== false`):
- `child-turn-guard.ts`: Patch applied cleanly = `true` (5 hunks, +8 -6; intermediate state before subsequent `Promise<any> -> Promise<unknown>` adjustment).
- `session-owner.ts`: Patch applied cleanly = `true` (1 hunk, +6 -3).

---

## 5. Severity-Ranked Findings (Finding Format)

- [P1] TUI display diff string preferred over standard unified git patch in `resolveFileChangeItem`
  - **Evidence:** `src/host/diff-utils.ts:120–124`:
    `const rawDiff = typeof detailsObj?.diff === "string" ? detailsObj.diff : typeof detailsObj?.patch === "string" ? detailsObj.patch : undefined;`
    `@earendil-works/pi-coding-agent` returns human-formatted string with line numbers and ellipses in `details.diff`, and RFC unified git diff in `details.patch`.
  - **Impact:** All file diff cards in BB UI fail unified diff parsing, fall back to heuristic header fabrication (`T(e)`), and prematurely truncate at the first unchanged context block. In the screenshot, `child-turn-guard.ts` (+8 -6) and `session-owner.ts` (+6 -3) both truncated to `+1 -0`, hiding 90% of code changes from the user.
  - **Rule:** AP-013 (Data integrity), AP-026 (API contracts / DTO boundaries)
  - **Fix decision:** `fix-now`

- [P1] Granular replacement edits mapped to multiple duplicate fileChange entries for a single file
  - **Evidence:** `src/host/tool-item-shape.ts:54–66`:
    `if (edits.length > 0) { const changes = edits.map(...) ... return { type: "fileChange", changes }; }`
    Also codified by existing test `tests/tool-delta-translator.test.ts:42–69` which asserted `changes.length === 2` for a single file.
  - **Impact:** When a single `edit` tool call performs multiple replacements in one file, BB Server creates a duplicate timeline row for each replacement. The first row displays whole-file totals with a broken/truncated diff; subsequent rows display partial snippet diffs with confusing subset stats (+3 -3, +2 -2, +1 -1).
  - **Rule:** AP-013 (Data integrity), AP-026 (API contracts / DTO boundaries), AP-028 (Testing determinism)
  - **Fix decision:** `fix-now`

---

## 6. Minimal Recommended Fix Scope (Phase B Preview)

The fix is bounded entirely to two adapter files in `bb-plugin-provider-pi-durable` and their accompanying unit tests:

1. **`src/host/diff-utils.ts` (`resolveFileChangeItem`)**:
   - Prefer `detailsObj?.patch` over `detailsObj?.diff`:
     ```typescript
     const rawDiff = typeof detailsObj?.patch === "string"
       ? detailsObj.patch
       : typeof detailsObj?.diff === "string"
         ? detailsObj.diff
         : undefined;
     ```
   - When updating changes, ensure that if `diff` is resolved for the file, it is attached to the file entry cleanly.

2. **`src/host/tool-item-shape.ts` (`buildToolItemShape`)**:
   - For `toolName === "edit"`, maintain single file identity:
     ```typescript
     if (toolName === "edit") {
       const filePath = normalizeFilePath(args.path, fallbackCwd);
       if (!filePath) {
         return { type: "fileChange", changes: [] };
       }
       return {
         type: "fileChange",
         changes: [{ path: filePath, kind: "update" }],
       };
     }
     ```
   - Retain `path` and `kind: "update"`. Do not fragment single-file disjoint edits into multiple `changes` entries.

3. **`tests/tool-delta-translator.test.ts`**:
   - Update the existing test that previously asserted `changes.length === 2` for multi-edit calls so that it asserts `changes.length === 1` with unique file identity.
   - Add test cases covering realistic `@earendil-works/pi-coding-agent` details payloads containing both `diff` (TUI string) and `patch` (unified diff), validating that all 5 hunks, correct line numbers, and totals (+8 -6) are preserved.

### RED / GREEN Cases for Phase C:
- **RED Case 1:** `buildToolItemShape("edit", { path: "src/file.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] })` must return `changes` of length 1, not 2.
- **RED Case 2:** `resolveFileChangeItem` with event details containing `{ diff: "+ 1 line\n 1 context", patch: "--- src/file.ts\n+++ src/file.ts\n@@ -1,2 +1,3 @@\n..." }` must pick `patch`, yielding a canonical diff parsed by `parsePatch` into valid hunks with correct line numbers, rather than truncating at context lines.
- **GREEN Case:** Both tests pass, full test suite (`npm test`) passes (404+ tests), `npm run typecheck` and `npm run build` exit 0, and line budget for changed files remains < 200 lines (AP-019).

---

## 7. Explicit Unknowns / Non-Issues

- **BB Core:** BB Core (`0.47.1`) is functioning as designed. It expects `fileChange.changes` to contain 1 entry per file, and `change.diff` to be a valid unified git diff. No BB Core changes or UI hacks are required.
- **Start/End Metadata & Replay:** Replay and thread streaming did not distort the payload. The raw events stored in SQLite and BB thread log matched the bridge translation 1:1.
- **Write tool:** The `write` tool is unaffected because `details` is undefined and `resolveFileChangeItem` invokes `synthesizeAddDiff`, which already generates canonical git diffs with `@@ -0,0 +1,N @@`.
