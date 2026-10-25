/** Runtime resources close in ownership order; one failed teardown must not skip later releases. */
export async function closeRuntimeResources(operations: Array<() => void | Promise<void>>): Promise<void> {
 const failures: unknown[] = [];
 for (const operation of operations) {
  try { await operation(); } catch (cause) { failures.push(cause); }
 }
 if (failures.length) throw new AggregateError(failures, "RUNTIME_CLEANUP_FAILED");
}
