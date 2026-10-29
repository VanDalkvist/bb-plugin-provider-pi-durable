import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";

export interface ControlChannelController {
	close(): void;
}

export function startRunnerControlChannel(
	sessionDir: string,
	harness: Harness,
	onNotice?: (message: string) => void,
): ControlChannelController {
	const controlFile = join(sessionDir, "control.jsonl");
	let fileOffset = 0;
	let isClosed = false;
	let watcher: FSWatcher | null = null;

	const processPendingLines = async (): Promise<void> => {
		if (isClosed || !existsSync(controlFile)) return;
		try {
			const content = readFileSync(controlFile, "utf8");
			if (content.length <= fileOffset) return;
			const newChunk = content.slice(fileOffset);
			fileOffset = content.length;

			const lines = newChunk.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const msg = JSON.parse(trimmed) as { type?: string; taskId?: number };
					if (msg.type === "abort_task" && typeof msg.taskId === "number") {
						await harness.abortTask(msg.taskId as unknown as TaskId, BACKGROUND_CONTEXT);
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
		},
	};
}
