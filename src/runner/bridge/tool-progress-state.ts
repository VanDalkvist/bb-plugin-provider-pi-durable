export interface ActiveToolSlot {
	output: string;
	details?: unknown;
}

export type ToolOutputUpdate =
	| { set: string }
	| { trimStart?: number; append?: string };

export class ToolProgressState {
	private readonly active = new Map<string | number, ActiveToolSlot>();

	public applyOutputUpdate(
		callId: string | number,
		output?: ToolOutputUpdate,
	): string | undefined {
		if (!output) {
			return this.active.get(callId)?.output;
		}
		let current = this.active.get(callId)?.output ?? "";
		if ("set" in output) {
			current = output.set;
		} else {
			const trim = typeof output.trimStart === "number" ? Math.max(0, output.trimStart) : 0;
			const append = typeof output.append === "string" ? output.append : "";
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

	public setDetails(callId: string | number, details: unknown): void {
		const existing = this.active.get(callId);
		if (existing) {
			existing.details = details;
		} else {
			this.active.set(callId, { output: "", details });
		}
	}

	public getDetails(callId: string | number): unknown {
		return this.active.get(callId)?.details;
	}

	public getRetainedOutput(callId: string | number): string | undefined {
		return this.active.get(callId)?.output;
	}

	public take(callId: string | number): { output?: string; details?: unknown } {
		const slot = this.active.get(callId);
		this.active.delete(callId);
		return slot ? { output: slot.output, details: slot.details } : {};
	}

	public clear(): void {
		this.active.clear();
	}

	public seedFromSnapshot(
		tools?: readonly { callId: string | number; output?: unknown; details?: unknown }[],
		nestedTools?: readonly { callId: string | number; output?: unknown; details?: unknown }[],
	): void {
		const all = [...(tools ?? []), ...(nestedTools ?? [])];
		for (const t of all) {
			if (t && t.callId !== undefined) {
				const outputStr = typeof t.output === "string" ? t.output : "";
				this.active.set(t.callId, { output: outputStr, details: t.details });
			}
		}
	}
}
