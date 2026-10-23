/**
 * Argument validation for tool calls.
 *
 * Models get tool arguments wrong constantly: a string where an array belongs, a stringified number,
 * a missing required field, a made-up extra field. Validating here converts those into a specific
 * error message the model can act on, which is far cheaper than letting a tool fail obscurely
 * halfway through.
 *
 * Deliberately a small subset of JSON Schema — the part we actually use in tool definitions.
 */

import { errors } from '../platform/errors.ts';

export interface PropertySchema {
	readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
	readonly description?: string;
	readonly enum?: readonly string[];
	readonly items?: PropertySchema;
	readonly properties?: Record<string, PropertySchema>;
	readonly required?: readonly string[];
	readonly default?: unknown;
	readonly minimum?: number;
	readonly maximum?: number;
}

export interface ObjectSchema {
	readonly type: 'object';
	readonly properties: Record<string, PropertySchema>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
}

/** Builds a schema object, keeping tool definitions readable. */
export function objectSchema(
	properties: Record<string, PropertySchema>,
	required: readonly string[] = []
): Record<string, unknown> {
	return {
		type: 'object',
		properties,
		...(required.length > 0 ? { required: [...required] } : {}),
		additionalProperties: false
	};
}

export const str = (description: string, extra: Partial<PropertySchema> = {}): PropertySchema =>
	({ type: 'string', description, ...extra });
export const num = (description: string, extra: Partial<PropertySchema> = {}): PropertySchema =>
	({ type: 'number', description, ...extra });
export const int = (description: string, extra: Partial<PropertySchema> = {}): PropertySchema =>
	({ type: 'integer', description, ...extra });
export const bool = (description: string, extra: Partial<PropertySchema> = {}): PropertySchema =>
	({ type: 'boolean', description, ...extra });
export const arr = (description: string, items: PropertySchema): PropertySchema =>
	({ type: 'array', description, items });

function typeName(value: unknown): string {
	if (value === null) { return 'null'; }
	if (Array.isArray(value)) { return 'array'; }
	return typeof value;
}

/**
 * Coerces a value to the declared type when the intent is unambiguous.
 * `"5"` → 5 and `"true"` → true are safe and extremely common from models; `"abc"` → NaN is not,
 * and fails instead.
 */
function coerce(value: unknown, schema: PropertySchema, path: string, problems: string[]): unknown {
	switch (schema.type) {
		case 'string': {
			if (typeof value === 'string') { return value; }
			if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
			problems.push(`${path} must be a string, got ${typeName(value)}`);
			return undefined;
		}
		case 'number':
		case 'integer': {
			const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
			if (!Number.isFinite(parsed)) {
				problems.push(`${path} must be a number, got ${typeName(value)}`);
				return undefined;
			}
			const rounded = schema.type === 'integer' ? Math.round(parsed) : parsed;
			if (schema.minimum !== undefined && rounded < schema.minimum) {
				problems.push(`${path} must be at least ${schema.minimum}`);
				return undefined;
			}
			if (schema.maximum !== undefined && rounded > schema.maximum) {
				problems.push(`${path} must be at most ${schema.maximum}`);
				return undefined;
			}
			return rounded;
		}
		case 'boolean': {
			if (typeof value === 'boolean') { return value; }
			if (value === 'true') { return true; }
			if (value === 'false') { return false; }
			problems.push(`${path} must be a boolean, got ${typeName(value)}`);
			return undefined;
		}
		case 'array': {
			// A single value where an array is expected is a very common model slip.
			const list = Array.isArray(value) ? value : value === undefined ? undefined : [value];
			if (!list) {
				problems.push(`${path} must be an array`);
				return undefined;
			}
			if (!schema.items) {
				return list;
			}
			const out: unknown[] = [];
			for (const [index, item] of list.entries()) {
				const coerced = coerce(item, schema.items, `${path}[${index}]`, problems);
				if (coerced !== undefined) {
					out.push(coerced);
				}
			}
			return out;
		}
		case 'object': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				problems.push(`${path} must be an object, got ${typeName(value)}`);
				return undefined;
			}
			if (!schema.properties) {
				return value;
			}
			return validateAgainst(value as Record<string, unknown>, {
				type: 'object',
				properties: schema.properties,
				...(schema.required ? { required: schema.required } : {})
			}, path, problems);
		}
		default:
			return value;
	}
}

function validateAgainst(
	input: Record<string, unknown>,
	schema: ObjectSchema,
	prefix: string,
	problems: string[]
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const required = new Set(schema.required ?? []);

	for (const [key, property] of Object.entries(schema.properties)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const raw = input[key];
		if (raw === undefined || raw === null) {
			if (required.has(key)) {
				problems.push(`${path} is required (${property.description ?? property.type})`);
			} else if (property.default !== undefined) {
				out[key] = property.default;
			}
			continue;
		}
		if (property.enum && property.enum.length > 0) {
			const asString = typeof raw === 'string' ? raw : String(raw);
			if (!property.enum.includes(asString)) {
				problems.push(`${path} must be one of: ${property.enum.join(', ')}`);
				continue;
			}
			out[key] = asString;
			continue;
		}
		const coerced = coerce(raw, property, path, problems);
		if (coerced !== undefined) {
			out[key] = coerced;
		}
	}

	// Unknown keys are dropped rather than rejected: models add stray fields, and failing the call
	// over a harmless extra is worse than ignoring it. We still tell the model, once.
	const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
	if (unknown.length > 0 && schema.additionalProperties === false) {
		problems.push(`unknown argument${unknown.length > 1 ? 's' : ''} ignored: ${unknown.join(', ')}`);
	}
	return out;
}

export interface ValidationResult {
	readonly args: Record<string, unknown>;
	readonly problems: readonly string[];
}

/** Validates and coerces; collects every problem so one round trip fixes all of them. */
export function validateArgs(input: unknown, schema: Record<string, unknown>): ValidationResult {
	const source = typeof input === 'object' && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
	const problems: string[] = [];
	if (input !== undefined && Object.keys(source).length === 0 && typeof input !== 'object') {
		problems.push('arguments must be a JSON object');
	}
	const args = validateAgainst(source, schema as unknown as ObjectSchema, '', problems);
	return { args, problems };
}

/** Throws when validation found blocking problems. Used by tools that cannot proceed partially. */
export function requireValid(input: unknown, schema: Record<string, unknown>, toolName: string): Record<string, unknown> {
	const { args, problems } = validateArgs(input, schema);
	const blocking = problems.filter((problem) => !problem.startsWith('unknown argument'));
	if (blocking.length > 0) {
		throw errors.invalidArgument(`${toolName}: ${blocking.join('; ')}`, { problems: blocking });
	}
	return args;
}
