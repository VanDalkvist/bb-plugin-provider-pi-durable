import { useState, useEffect } from "react";

export function useViewClock(hasActive: boolean): number {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!hasActive) return;
		const timer = setInterval(() => {
			setNow(Date.now());
		}, 1000);
		if (typeof (timer as any)?.unref === "function") {
			(timer as any).unref();
		}
		return () => clearInterval(timer);
	}, [hasActive]);

	return now;
}
