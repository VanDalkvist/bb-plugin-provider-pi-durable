import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export interface SchemaValidationResult {
	readonly isValid: boolean;
	readonly errors?: readonly string[];
}

export class SchemaPort {
	coerce(schema: unknown, value: unknown): unknown {
		if (!value || typeof value !== "object" || !schema) {
			return value;
		}

		// Fast TypeBox Convert with fallback
		try {
			return Value.Convert(schema as TSchema, value);
		} catch {
			return value;
		}
	}

	validate(schema: unknown, value: unknown): SchemaValidationResult {
		if (!schema) {
			return { isValid: true };
		}

		try {
			const s = schema as TSchema;
			const isValid = Value.Check(s, value);
			if (isValid) {
				return { isValid: true };
			}

			const errors: string[] = [];
			for (const err of Value.Errors(s, value)) {
				const errObj = err as { path?: string; message?: string };
				const rawPath = errObj.path;
				const path = rawPath ? rawPath.replace(/^\//, "") : "root";
				errors.push(`- ${path}: ${errObj.message ?? "validation error"}`);
			}
			return { isValid: false, errors };
		} catch (err) {
			return {
				isValid: false,
				errors: [`- schema: ${err instanceof Error ? err.message : String(err)}`],
			};
		}
	}
}
