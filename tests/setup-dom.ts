import { JSDOM } from "jsdom";

export function setupDom(): void {
	if (typeof globalThis.document !== "undefined") return;

	const dom = new JSDOM("<!doctype html><html><body></body></html>", {
		url: "http://localhost",
		pretendToBeVisual: true,
	});

	const win = dom.window;
	(globalThis as any).window = win;
	(globalThis as any).document = win.document;
	Object.defineProperty(globalThis, "navigator", {
		value: win.navigator,
		configurable: true,
		writable: true,
	});

	const copyKeys = [
		"HTMLElement",
		"HTMLInputElement",
		"HTMLSelectElement",
		"HTMLButtonElement",
		"HTMLDivElement",
		"HTMLSpanElement",
		"Node",
		"Element",
		"DocumentFragment",
		"MutationObserver",
		"Event",
		"CustomEvent",
		"UIEvent",
		"MouseEvent",
		"KeyboardEvent",
	];

	for (const key of copyKeys) {
		(globalThis as any)[key] = (win as any)[key];
	}

	(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
	(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0);
	(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
}
