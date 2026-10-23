/**
 * Settings schema.
 *
 * Design: one descriptor table is the single source of truth. `DEFAULT_SETTINGS`, the validator and
 * the IDE settings UI are all derived from it, so a new setting cannot be half-wired.
 * Collection-shaped settings (providers, mcp.servers) have dedicated validators below.
 */

import type { ModelCapabilities, ProtocolId, ProviderQuirks } from '../../providers/types.ts';
import { isProtocolId } from '../../providers/types.ts';
import type { SandboxFallback, SandboxNetwork, SandboxProfile } from '../../security/sandbox.ts';

export type AgentModeId = 'ask' | 'plan' | 'agent' | 'spec' | 'vivecode';

/** Runtime validation for values crossing the daemon/IDE boundary. */
export function isAgentModeId(value: unknown): value is AgentModeId {
	return value === 'ask' || value === 'plan' || value === 'agent' || value === 'spec' || value === 'vivecode';
}
export type AutoStrategy = 'quality' | 'balanced' | 'economy' | 'custom';
export type TerminalPolicy = 'ask-always' | 'ask-dangerous' | 'trusted';
export type TerminalAutoApprove = 'never' | 'safe' | 'safe-and-modify' | 'always';
/** '' = let the model decide; otherwise a reasoning budget for models that support extended thinking. */
export type ReasoningEffortSetting = '' | 'minimal' | 'low' | 'medium' | 'high';
export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'off';

export interface ModelConfigEntry {
	id: string;
	displayName?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	inputCostPerMTok?: number;
	outputCostPerMTok?: number;
	cacheReadCostPerMTok?: number;
	cacheWriteCostPerMTok?: number;
	capabilities?: Partial<ModelCapabilities>;
	tags?: string[];
	enabled: boolean;
	quotaPerDay?: number;
	notes?: string;
}

export interface ProviderConfig {
	id: string;
	name: string;
	protocol: ProtocolId;
	baseUrl: string;
	/** Name of the secret in the secret store. NEVER the key itself. */
	apiKeyRef?: string;
	headers?: Record<string, string>;
	query?: Record<string, string>;
	timeoutMs?: number;
	maxRetries?: number;
	quirks?: ProviderQuirks;
	extraBody?: Record<string, unknown>;
	enabled: boolean;
	models: ModelConfigEntry[];
}

export interface McpServerConfig {
	id: string;
	name: string;
	enabled: boolean;
	transport: 'stdio' | 'http' | 'sse';
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	autoApproveTools?: string[];
	timeoutMs?: number;
}

export interface ForjaSettings {
	general: {
		defaultMode: AgentModeId;
		/** 'auto' or 'providerId/modelId'. */
		defaultModel: string;
		locale: string;
		/** OpenCode model ids hidden by the user; refresh must not silently restore them. */
		hiddenOpenCodeModels: string[];
	};
	browser: {
		/** Keep integrated-browser cookies and local storage between launches. */
		persistSessions: boolean;
	};
	providers: ProviderConfig[];
	auto: {
		enabled: boolean;
		strategy: AutoStrategy;
		/** Empty means "every enabled model may participate". */
		allowedModels: string[];
		minModel: string;
		maxModel: string;
		allowEscalation: boolean;
		allowDeescalation: boolean;
		maxEscalations: number;
		prioritizeSpeed: boolean;
		prioritizeLongContext: boolean;
		learnFromUsage: boolean;
		showRoutingDecisions: boolean;
		qualityFloor: number;
		weights: { quality: number; cost: number; latency: number };
		costLimitPerTaskUsd: number;
		tokenLimitPerTask: number;
		shadowRouter: string;
	};
	agent: {
		maxSteps: number;
		maxToolCallsPerStep: number;
		autoApproveEdits: boolean;
		autoApproveTerminal: TerminalAutoApprove;
		verifyWithTests: boolean;
		verifyCommands: string[];
		maxParallelSubagents: number;
		useWorktrees: boolean;
		resumeInterrupted: boolean;
		/** '' lets the model decide; otherwise a reasoning budget for models that support it. */
		reasoningEffort: ReasoningEffortSetting;
	};
	tools: {
		disabled: string[];
		maxOutputChars: number;
		terminalTimeoutMs: number;
		maxFileReadBytes: number;
	};
	ocr: {
		enabled: boolean;
		pythonCommand: string;
		device: 'auto' | 'cpu' | 'gpu';
		language: string;
		maxInputMb: number;
		timeoutMs: number;
	};
	web: {
		enabled: boolean;
		searchEndpoint: string;
		allowedDomains: string[];
		maxResponseBytes: number;
		timeoutMs: number;
	};
	context: {
		budgetShare: number;
		maxFilesPerQuery: number;
		compactionThreshold: number;
		includeGitDiff: boolean;
		indexOnOpen: boolean;
		maxIndexedFiles: number;
		semanticRetrieval: boolean;
	};
	security: {
		terminalPolicy: TerminalPolicy;
		sandboxProfile: SandboxProfile;
		sandboxNetwork: SandboxNetwork;
		sandboxFallback: SandboxFallback;
		allowOutsideWorkspace: boolean;
		allowedExternalPaths: string[];
		blockedPaths: string[];
		secretScanning: boolean;
		blockSecretsInContext: boolean;
		confirmDependencyInstall: boolean;
		/** Explicit opt-in before repository-controlled automation may execute. */
		trustWorkspace: boolean;
	};
	privacy: { telemetry: boolean; storePrompts: boolean; shareRouterMetrics: boolean };
	mcp: { servers: McpServerConfig[] };
	skills: { enabled: boolean; directories: string[] };
	specs: { enabled: boolean; directory: string; requireApproval: boolean };
	powers: { enabled: boolean; registryUrl: string; autoUpdate: boolean };
	interop: {
		claudeCode: boolean;
		opencode: boolean;
		kiro: boolean;
		cursor: boolean;
		includeUserFiles: boolean;
	};
	advanced: { daemonSocket: string; requestTimeoutMs: number; maxRetries: number };
	developer: {
		explainRouting: boolean;
		requestInspector: boolean;
		logLevel: LogLevelName;
		mockProvider: boolean;
		showMockModels: boolean;
	};
}

export type SettingType = 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'object';

export interface SettingDescriptor {
	/** Dotted path without the `forja.` prefix, e.g. `auto.strategy`. */
	readonly path: string;
	/** Fully qualified key used by the IDE settings registry. */
	readonly key: string;
	readonly type: SettingType;
	readonly default: unknown;
	readonly description: string;
	readonly enumValues?: readonly string[];
	readonly minimum?: number;
	readonly maximum?: number;
	/** Element type for arrays of primitives. */
	readonly itemType?: 'string' | 'number';
}

interface Leaf {
	readonly path: string;
	readonly type: SettingType;
	readonly def: unknown;
	readonly desc: string;
	readonly enumValues?: readonly string[];
	readonly min?: number;
	readonly max?: number;
	readonly itemType?: 'string' | 'number';
}

const LEAVES: readonly Leaf[] = [
	{ path: 'general.defaultMode', type: 'enum', def: 'agent', enumValues: ['ask', 'plan', 'agent', 'spec', 'vivecode'], desc: 'Mode a new agent session starts in.' },
	{ path: 'general.defaultModel', type: 'string', def: 'auto', desc: 'Model used for new sessions: "auto" for the router, or "providerId/modelId".' },
	{ path: 'general.locale', type: 'string', def: '', desc: 'Language the agent should reply in. Empty follows the IDE locale.' },
	{ path: 'general.hiddenOpenCodeModels', type: 'array', itemType: 'string', def: [], desc: 'OpenCode free model ids removed from the picker until the user restores them.' },
	{ path: 'browser.persistSessions', type: 'boolean', def: true, desc: 'Keep integrated-browser cookies and local storage between Tessarion launches. Disable for temporary browser sessions.' },

	{ path: 'auto.enabled', type: 'boolean', def: true, desc: 'Allow the Auto router to pick models automatically.' },
	{ path: 'auto.strategy', type: 'enum', def: 'balanced', enumValues: ['quality', 'balanced', 'economy', 'custom'], desc: 'How Auto trades quality against cost. "custom" uses the weights below.' },
	{ path: 'auto.allowedModels', type: 'array', itemType: 'string', def: [], desc: 'Models Auto may choose from, as "providerId/modelId". Empty means every enabled model.' },
	{ path: 'auto.minModel', type: 'string', def: '', desc: 'Never route below this model, even for trivial work.' },
	{ path: 'auto.maxModel', type: 'string', def: '', desc: 'Never escalate above this model.' },
	{ path: 'auto.allowEscalation', type: 'boolean', def: true, desc: 'Let Auto move to a stronger model when a task turns out to be harder than expected.' },
	{ path: 'auto.allowDeescalation', type: 'boolean', def: true, desc: 'Let Auto drop back to a cheaper model once the hard part is done.' },
	{ path: 'auto.maxEscalations', type: 'number', def: 3, min: 0, max: 10, desc: 'Maximum number of escalations within a single task.' },
	{ path: 'auto.prioritizeSpeed', type: 'boolean', def: false, desc: 'Prefer faster models when quality is close.' },
	{ path: 'auto.prioritizeLongContext', type: 'boolean', def: false, desc: 'Prefer larger context windows when candidates are otherwise comparable.' },
	{ path: 'auto.learnFromUsage', type: 'boolean', def: true, desc: 'Record local success metrics per model and use them in future routing.' },
	{ path: 'auto.showRoutingDecisions', type: 'boolean', def: true, desc: 'Show which model Auto picked, and why, in the chat.' },
	{ path: 'auto.qualityFloor', type: 'number', def: 0.6, min: 0, max: 1, desc: 'Minimum estimated success probability a model must reach to be eligible.' },
	{ path: 'auto.weights.quality', type: 'number', def: 1, min: 0, max: 10, desc: 'Weight of expected quality in the routing utility.' },
	{ path: 'auto.weights.cost', type: 'number', def: 0.5, min: 0, max: 10, desc: 'Weight of cost in the routing utility.' },
	{ path: 'auto.weights.latency', type: 'number', def: 0.2, min: 0, max: 10, desc: 'Weight of latency in the routing utility.' },
	{ path: 'auto.costLimitPerTaskUsd', type: 'number', def: 0, min: 0, max: 1000, desc: 'Stop a task when its estimated cost exceeds this amount. 0 disables the limit.' },
	{ path: 'auto.tokenLimitPerTask', type: 'number', def: 0, min: 0, max: 100_000_000, desc: 'Stop a task after this many tokens. 0 disables the limit.' },
	{ path: 'auto.shadowRouter', type: 'string', def: '', desc: 'Candidate router version to evaluate in the background without spending calls.' },


	{ path: 'agent.maxSteps', type: 'number', def: 60, min: 1, max: 1000, desc: 'Maximum agent steps in a normal task. In ViveCode this is the soft checkpoint interval, not a hard stop.' },
	{ path: 'agent.maxToolCallsPerStep', type: 'number', def: 8, min: 1, max: 64, desc: 'Maximum tool calls the agent may run in a single step.' },
	{ path: 'agent.autoApproveEdits', type: 'boolean', def: false, desc: 'Apply file edits without asking. Diffs remain reviewable and revertable.' },
	{ path: 'agent.autoApproveTerminal', type: 'enum', def: 'safe', enumValues: ['never', 'safe', 'safe-and-modify', 'always'], desc: 'Which command risk levels may run without confirmation.' },
	{ path: 'agent.verifyWithTests', type: 'boolean', def: true, desc: 'Run the project checks after changes and fix what fails before finishing.' },
	{ path: 'agent.verifyCommands', type: 'array', itemType: 'string', def: [], desc: 'Commands used to verify changes. Empty means detect them from the project.' },
	{ path: 'agent.maxParallelSubagents', type: 'number', def: 3, min: 1, max: 12, desc: 'How many subagents may work at the same time.' },
	{ path: 'agent.useWorktrees', type: 'boolean', def: false, desc: 'Isolate parallel subagents in git worktrees and merge their results afterwards.' },
	{ path: 'agent.resumeInterrupted', type: 'boolean', def: true, desc: 'Offer to resume a task that was interrupted when the window closed.' },
	{ path: 'agent.reasoningEffort', type: 'enum', def: '', enumValues: ['', 'minimal', 'low', 'medium', 'high'], desc: 'Reasoning budget for models that support extended thinking. Empty lets the model decide.' },

	{ path: 'tools.disabled', type: 'array', itemType: 'string', def: [], desc: 'Tool names the agent may not use.' },
	{ path: 'tools.maxOutputChars', type: 'number', def: 60_000, min: 1_000, max: 2_000_000, desc: 'Maximum characters kept from a single tool result.' },
	{ path: 'tools.terminalTimeoutMs', type: 'number', def: 120_000, min: 1_000, max: 3_600_000, desc: 'Default timeout for commands the agent runs.' },
	{ path: 'tools.maxFileReadBytes', type: 'number', def: 1_000_000, min: 1_000, max: 50_000_000, desc: 'Largest file the agent will read in one call.' },

	{ path: 'ocr.enabled', type: 'boolean', def: true, desc: 'Enable local PaddleOCR for images and PDFs. OCR text stays local until an agent uses it as context.' },
	{ path: 'ocr.pythonCommand', type: 'string', def: 'python3', desc: 'Python executable with PaddleOCR installed. Use an absolute virtual-environment path when needed.' },
	{ path: 'ocr.device', type: 'enum', def: 'auto', enumValues: ['auto', 'cpu', 'gpu'], desc: 'OCR inference device. Auto uses CUDA only when PaddlePaddle supports it.' },
	{ path: 'ocr.language', type: 'string', def: 'es', desc: 'Default PaddleOCR language code for extraction.' },
	{ path: 'ocr.maxInputMb', type: 'number', def: 25, min: 1, max: 500, desc: 'Maximum image or PDF size accepted by one OCR call.' },
	{ path: 'ocr.timeoutMs', type: 'number', def: 120_000, min: 5_000, max: 3_600_000, desc: 'Timeout for one local OCR extraction.' },

	{ path: 'web.enabled', type: 'boolean', def: true, desc: 'Enable controlled web search and page retrieval tools.' },
	{ path: 'web.searchEndpoint', type: 'string', def: 'https://html.duckduckgo.com/html/', desc: 'HTML search endpoint. Change this to use an approved internal or commercial search service.' },
	{ path: 'web.allowedDomains', type: 'array', itemType: 'string', def: [], desc: 'Public domains web tools may access. Empty permits any public HTTPS or HTTP host after SSRF checks.' },
	{ path: 'web.maxResponseBytes', type: 'number', def: 2_000_000, min: 10_000, max: 20_000_000, desc: 'Maximum bytes accepted from one web response before it is stopped.' },
	{ path: 'web.timeoutMs', type: 'number', def: 20_000, min: 1_000, max: 120_000, desc: 'Timeout for one web request, including redirects.' },

	{ path: 'context.budgetShare', type: 'number', def: 0.6, min: 0.1, max: 0.95, desc: 'Fraction of the model context window the agent may fill with gathered context.' },
	{ path: 'context.maxFilesPerQuery', type: 'number', def: 24, min: 1, max: 200, desc: 'Maximum files pulled into context by a single retrieval pass.' },
	{ path: 'context.compactionThreshold', type: 'number', def: 0.85, min: 0.3, max: 0.95, desc: 'Context fill level that triggers summarizing the conversation into a checkpoint.' },
	{ path: 'context.includeGitDiff', type: 'boolean', def: true, desc: 'Include the working-tree diff in the agent context when the repo is dirty.' },
	{ path: 'context.indexOnOpen', type: 'boolean', def: true, desc: 'Start building the repository map when a workspace opens.' },
	{ path: 'context.maxIndexedFiles', type: 'number', def: 60_000, min: 100, max: 1_000_000, desc: 'Upper bound on files in the repository map.' },
	{ path: 'context.semanticRetrieval', type: 'boolean', def: false, desc: 'Also use embedding search when an embedding provider is configured.' },

	{ path: 'security.terminalPolicy', type: 'enum', def: 'ask-dangerous', enumValues: ['ask-always', 'ask-dangerous', 'trusted'], desc: 'When to ask before running a command.' },
	{ path: 'security.sandboxProfile', type: 'enum', def: 'workspace-write', enumValues: ['read-only', 'workspace-write', 'full-access'], desc: 'Kernel-enforced terminal boundary. Workspace-write is isolated on Linux; full-access disables the sandbox.' },
	{ path: 'security.sandboxNetwork', type: 'enum', def: 'disabled', enumValues: ['disabled', 'enabled'], desc: 'Network state inside a restricted terminal sandbox. Disabled is the safe default; enabled permits unrestricted egress.' },
	{ path: 'security.sandboxFallback', type: 'enum', def: 'deny', enumValues: ['deny', 'allow'], desc: 'What to do when the selected sandbox cannot be enforced. Deny is safer; allow uses the host process only after explicit configuration.' },
	{ path: 'security.allowOutsideWorkspace', type: 'boolean', def: false, desc: 'Allow file tools to touch paths outside the workspace.' },
	{ path: 'security.allowedExternalPaths', type: 'array', itemType: 'string', def: [], desc: 'Extra absolute paths the agent may read or write outside the workspace.' },
	{ path: 'security.blockedPaths', type: 'array', itemType: 'string', def: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '.ssh/**', '.aws/credentials', '**/credentials.json', '**/.netrc', '**/*.keystore', '**/*.jks'], desc: 'Glob patterns the agent may never read, even inside the workspace.' },
	{ path: 'security.secretScanning', type: 'boolean', def: true, desc: 'Scan everything sent to a model provider and mask detected secrets.' },
	{ path: 'security.blockSecretsInContext', type: 'boolean', def: true, desc: 'Refuse to send a block of context when a high-confidence secret is found in it.' },
	{ path: 'security.confirmDependencyInstall', type: 'boolean', def: true, desc: 'Ask before installing or upgrading dependencies.' },
	{ path: 'security.trustWorkspace', type: 'boolean', def: false, desc: 'Allow this workspace to run repository-provided hooks, powers and inherited MCP servers. Keep off for code you did not create or review.' },

	{ path: 'privacy.telemetry', type: 'boolean', def: false, desc: 'Send anonymous usage telemetry. Off by default; source code is never sent.' },
	{ path: 'privacy.storePrompts', type: 'boolean', def: true, desc: 'Keep prompts and replies in the local session history.' },
	{ path: 'privacy.shareRouterMetrics', type: 'boolean', def: false, desc: 'Share local routing metrics. Off by default; metrics stay on this machine.' },

	{ path: 'skills.enabled', type: 'boolean', def: true, desc: 'Load skills from the workspace and user skill directories.' },
	{ path: 'skills.directories', type: 'array', itemType: 'string', def: ['.skills'], desc: 'Directories scanned for skills, relative to the workspace or absolute.' },

	{ path: 'specs.enabled', type: 'boolean', def: true, desc: 'Enable the spec workflow (requirements, design, tasks).' },
	{ path: 'specs.directory', type: 'string', def: '.ai/specs', desc: 'Where specs are stored inside the workspace.' },
	{ path: 'specs.requireApproval', type: 'boolean', def: true, desc: 'Require approval of each spec phase before moving on.' },

	{ path: 'powers.enabled', type: 'boolean', def: true, desc: 'Let installed powers contribute instructions, MCP servers and steering.' },
	{ path: 'powers.registryUrl', type: 'string', def: 'https://prod.download.desktop.kiro.dev/powers/default_registry.json', desc: 'Catalogue of installable powers. Point this at your own to publish internal powers.' },
	{ path: 'powers.autoUpdate', type: 'boolean', def: false, desc: 'Reinstall installed powers when the catalogue publishes a newer commit.' },

	// Reading, never writing: the other agent keeps working, and removing Forja mutates nothing.
	{ path: 'interop.claudeCode', type: 'boolean', def: true, desc: 'Adopt CLAUDE.md, .claude/agents, .claude/commands, .claude/skills and .mcp.json.' },
	{ path: 'interop.opencode', type: 'boolean', def: true, desc: 'Adopt AGENTS.md, .opencode/agent, .opencode/command and opencode.json MCP servers.' },
	{ path: 'interop.kiro', type: 'boolean', def: true, desc: 'Adopt .kiro/steering, .kiro/skills and .kiro/settings/mcp.json.' },
	{ path: 'interop.cursor', type: 'boolean', def: true, desc: 'Adopt .cursor/rules, .cursorrules and .cursor/mcp.json.' },
	{ path: 'interop.includeUserFiles', type: 'boolean', def: false, desc: 'Also read the other agents\' user-level configuration (~/.claude, ~/.config/opencode).' },

	{ path: 'advanced.daemonSocket', type: 'string', def: '', desc: 'Override the agent daemon socket path. Empty uses the platform default.' },
	{ path: 'advanced.requestTimeoutMs', type: 'number', def: 300_000, min: 5_000, max: 3_600_000, desc: 'Timeout for a single model request.' },
	{ path: 'advanced.maxRetries', type: 'number', def: 2, min: 0, max: 10, desc: 'Retries for a failed model request before falling back to another provider.' },

	{ path: 'developer.explainRouting', type: 'boolean', def: false, desc: 'Show the full routing computation for every decision.' },
	{ path: 'developer.requestInspector', type: 'boolean', def: false, desc: 'Record normalized provider requests and responses for inspection. Keys are never stored.' },
	{ path: 'developer.logLevel', type: 'enum', def: 'info', enumValues: ['trace', 'debug', 'info', 'warn', 'error', 'off'], desc: 'Verbosity of the agent logs.' },
	{ path: 'developer.mockProvider', type: 'boolean', def: false, desc: 'Register the built-in mock provider for testing without spending tokens.' },
	{ path: 'developer.showMockModels', type: 'boolean', def: false, desc: 'Show the mock provider models in the model picker. Off by default — mock models are for tests, not normal use.' }
];

/** Collection settings are not leaves; they are validated by dedicated functions. */
const COLLECTION_PATHS = ['providers', 'mcp.servers'] as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function getPath(target: unknown, path: string): unknown {
	let current: unknown = target;
	for (const segment of path.split('.')) {
		if (typeof current !== 'object' || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split('.');
	let current = target;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i] as string;
		const next = current[segment];
		if (typeof next !== 'object' || next === null || Array.isArray(next)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[segments[segments.length - 1] as string] = value;
}

function buildDefaults(): ForjaSettings {
	const out: Record<string, unknown> = {};
	for (const leaf of LEAVES) {
		setPath(out, leaf.path, Array.isArray(leaf.def) ? [...leaf.def] : leaf.def);
	}
	setPath(out, 'providers', []);
	setPath(out, 'mcp.servers', []);
	return out as unknown as ForjaSettings;
}

export const DEFAULT_SETTINGS: ForjaSettings = buildDefaults();

export function settingsSchemaDescriptors(): SettingDescriptor[] {
	return LEAVES.map((leaf) => ({
		path: leaf.path,
		key: `forja.${leaf.path}`,
		type: leaf.type,
		default: leaf.def,
		description: leaf.desc,
		...(leaf.enumValues ? { enumValues: leaf.enumValues } : {}),
		...(leaf.min !== undefined ? { minimum: leaf.min } : {}),
		...(leaf.max !== undefined ? { maximum: leaf.max } : {}),
		...(leaf.itemType ? { itemType: leaf.itemType } : {})
	}));
}

function coerceLeaf(leaf: Leaf, raw: unknown, problems: string[]): unknown {
	const label = `forja.${leaf.path}`;
	switch (leaf.type) {
		case 'boolean': {
			if (typeof raw === 'boolean') { return raw; }
			if (raw === 'true') { return true; }
			if (raw === 'false') { return false; }
			problems.push(`${label}: expected a boolean, got ${describe(raw)}. Using ${String(leaf.def)}.`);
			return leaf.def;
		}
		case 'number': {
			const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
			if (!Number.isFinite(value)) {
				problems.push(`${label}: expected a number, got ${describe(raw)}. Using ${String(leaf.def)}.`);
				return leaf.def;
			}
			let clamped = value;
			if (leaf.min !== undefined && clamped < leaf.min) { clamped = leaf.min; }
			if (leaf.max !== undefined && clamped > leaf.max) { clamped = leaf.max; }
			if (clamped !== value) {
				problems.push(`${label}: ${value} is out of range, clamped to ${clamped}.`);
			}
			return clamped;
		}
		case 'enum': {
			if (typeof raw === 'string' && leaf.enumValues?.includes(raw)) { return raw; }
			problems.push(`${label}: ${describe(raw)} is not one of ${leaf.enumValues?.join(', ')}. Using ${String(leaf.def)}.`);
			return leaf.def;
		}
		case 'string': {
			if (typeof raw === 'string') { return raw; }
			if (typeof raw === 'number' || typeof raw === 'boolean') { return String(raw); }
			problems.push(`${label}: expected a string, got ${describe(raw)}. Using the default.`);
			return leaf.def;
		}
		case 'array': {
			if (!Array.isArray(raw)) {
				problems.push(`${label}: expected an array, got ${describe(raw)}. Using the default.`);
				return Array.isArray(leaf.def) ? [...leaf.def] : [];
			}
			const wanted = leaf.itemType ?? 'string';
			const items = raw.filter((item) => typeof item === wanted);
			if (items.length !== raw.length) {
				problems.push(`${label}: dropped ${raw.length - items.length} item(s) that were not ${wanted}s.`);
			}
			return items;
		}
		default:
			return raw ?? leaf.def;
	}
}

function describe(value: unknown): string {
	if (value === null) { return 'null'; }
	if (value === undefined) { return 'nothing'; }
	if (Array.isArray(value)) { return `an array(${value.length})`; }
	const type = typeof value;
	return type === 'object' ? 'an object' : `${type} ${JSON.stringify(value)}`;
}

function normalizeStringMap(raw: unknown): Record<string, string> | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'string') {
			out[key] = value;
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			out[key] = String(value);
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function positive(raw: unknown, max: number): number | undefined {
	const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
	if (!Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.min(value, max);
}

/** Prices may legitimately be zero. Limits and token counts still use `positive`. */
function nonNegative(raw: unknown, max: number): number | undefined {
	const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
	if (!Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.min(value, max);
}

function normalizeCapabilities(raw: unknown): Partial<ModelCapabilities> | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	const booleans = [
		'supportsTools', 'supportsStreaming', 'supportsVision', 'supportsReasoning',
		'supportsPromptCaching', 'supportsParallelToolCalls', 'supportsSystemPrompt', 'supportsTemperature'
	];
	for (const key of booleans) {
		if (typeof source[key] === 'boolean') { out[key] = source[key]; }
	}
	for (const key of ['contextWindow', 'maxOutputTokens']) {
		const value = positive(source[key], 100_000_000);
		if (value !== undefined) { out[key] = Math.round(value); }
	}
	return Object.keys(out).length > 0 ? (out as Partial<ModelCapabilities>) : undefined;
}

const QUIRK_KEYS: readonly (keyof ProviderQuirks)[] = [
	'noTools', 'systemAsUser', 'noSamplingParams', 'legacyMaxTokens', 'noStreamUsage', 'noStreaming',
	'singleToolCall', 'mergeConsecutiveRoles', 'forceStreamFlag', 'simplifyToolSchema'
];

function normalizeQuirks(raw: unknown): ProviderQuirks | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of QUIRK_KEYS) {
		if (typeof source[key] === 'boolean') { out[key] = source[key]; }
	}
	for (const key of ['chatPath', 'modelsPath', 'reasoningField']) {
		if (typeof source[key] === 'string') { out[key] = source[key]; }
	}
	return Object.keys(out).length > 0 ? (out as ProviderQuirks) : undefined;
}

function normalizeModelEntry(raw: unknown, providerId: string, problems: string[]): ModelConfigEntry | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		problems.push(`providers.${providerId}.models: skipped an entry that was not an object.`);
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const id = typeof source['id'] === 'string' ? source['id'].trim() : '';
	if (!id) {
		problems.push(`providers.${providerId}.models: skipped an entry without an "id".`);
		return undefined;
	}
	const entry: ModelConfigEntry = {
		id,
		enabled: source['enabled'] !== false,
		...(typeof source['displayName'] === 'string' ? { displayName: source['displayName'] } : {}),
		...(positive(source['contextWindow'], 100_000_000) !== undefined ? { contextWindow: Math.round(positive(source['contextWindow'], 100_000_000) as number) } : {}),
		...(positive(source['maxOutputTokens'], 10_000_000) !== undefined ? { maxOutputTokens: Math.round(positive(source['maxOutputTokens'], 10_000_000) as number) } : {}),
		...(nonNegative(source['inputCostPerMTok'], 100_000) !== undefined ? { inputCostPerMTok: nonNegative(source['inputCostPerMTok'], 100_000) as number } : {}),
		...(nonNegative(source['outputCostPerMTok'], 100_000) !== undefined ? { outputCostPerMTok: nonNegative(source['outputCostPerMTok'], 100_000) as number } : {}),
		...(nonNegative(source['cacheReadCostPerMTok'], 100_000) !== undefined ? { cacheReadCostPerMTok: nonNegative(source['cacheReadCostPerMTok'], 100_000) as number } : {}),
		...(nonNegative(source['cacheWriteCostPerMTok'], 100_000) !== undefined ? { cacheWriteCostPerMTok: nonNegative(source['cacheWriteCostPerMTok'], 100_000) as number } : {}),
		...(normalizeCapabilities(source['capabilities']) ? { capabilities: normalizeCapabilities(source['capabilities']) } : {}),
		...(Array.isArray(source['tags']) ? { tags: source['tags'].filter((t): t is string => typeof t === 'string') } : {}),
		...(positive(source['quotaPerDay'], 100_000_000) !== undefined ? { quotaPerDay: Math.round(positive(source['quotaPerDay'], 100_000_000) as number) } : {}),
		...(typeof source['notes'] === 'string' ? { notes: source['notes'] } : {})
	};
	return entry;
}

export function normalizeProviders(raw: unknown, problems: string[]): ProviderConfig[] {
	if (raw === undefined) { return []; }
	if (!Array.isArray(raw)) {
		problems.push('forja.providers: expected an array of providers. Ignoring it.');
		return [];
	}
	const out: ProviderConfig[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			problems.push('forja.providers: skipped an entry that was not an object.');
			continue;
		}
		const source = item as Record<string, unknown>;
		const id = typeof source['id'] === 'string' ? source['id'].trim() : '';
		if (!ID_PATTERN.test(id)) {
			problems.push(`forja.providers: skipped a provider with an invalid id ${describe(source['id'])}.`);
			continue;
		}
		if (seen.has(id.toLowerCase())) {
			problems.push(`forja.providers: duplicate provider id "${id}" ignored.`);
			continue;
		}
		const protocolRaw = source['protocol'];
		if (!isProtocolId(protocolRaw)) {
			problems.push(`forja.providers.${id}: unknown protocol ${describe(protocolRaw)}. Skipped.`);
			continue;
		}
		const baseUrl = typeof source['baseUrl'] === 'string' ? source['baseUrl'].trim().replace(/\/+$/, '') : '';
		if (!baseUrl && protocolRaw !== 'mock') {
			problems.push(`forja.providers.${id}: missing baseUrl. Skipped.`);
			continue;
		}
		const models: ModelConfigEntry[] = [];
		const modelIds = new Set<string>();
		if (Array.isArray(source['models'])) {
			for (const modelRaw of source['models']) {
				const entry = normalizeModelEntry(modelRaw, id, problems);
				if (!entry) { continue; }
				if (modelIds.has(entry.id)) {
					problems.push(`forja.providers.${id}: duplicate model id "${entry.id}" ignored.`);
					continue;
				}
				modelIds.add(entry.id);
				models.push(entry);
			}
		}
		seen.add(id.toLowerCase());
		out.push(buildProvider(id, source, protocolRaw, baseUrl, models));
	}
	return out;
}

function buildProvider(
	id: string,
	source: Record<string, unknown>,
	protocol: ProtocolId,
	baseUrl: string,
	models: ModelConfigEntry[]
): ProviderConfig {
	const headers = normalizeStringMap(source['headers']);
	const query = normalizeStringMap(source['query']);
	const quirks = normalizeQuirks(source['quirks']);
	const timeoutMs = positive(source['timeoutMs'], 3_600_000);
	const maxRetries = typeof source['maxRetries'] === 'number' && source['maxRetries'] >= 0
		? Math.min(Math.round(source['maxRetries']), 10)
		: undefined;
	const extraBody = typeof source['extraBody'] === 'object' && source['extraBody'] !== null && !Array.isArray(source['extraBody'])
		? (source['extraBody'] as Record<string, unknown>)
		: undefined;
	return {
		id,
		name: typeof source['name'] === 'string' && source['name'].trim() ? source['name'].trim() : id,
		protocol,
		baseUrl,
		enabled: source['enabled'] !== false,
		models,
		...(typeof source['apiKeyRef'] === 'string' ? { apiKeyRef: source['apiKeyRef'] } : {}),
		...(headers ? { headers } : {}),
		...(query ? { query } : {}),
		...(quirks ? { quirks } : {}),
		...(timeoutMs !== undefined ? { timeoutMs: Math.round(timeoutMs) } : {}),
		...(maxRetries !== undefined ? { maxRetries } : {}),
		...(extraBody ? { extraBody } : {})
	};
}

export function normalizeMcpServers(raw: unknown, problems: string[]): McpServerConfig[] {
	if (raw === undefined) { return []; }
	if (!Array.isArray(raw)) {
		problems.push('forja.mcp.servers: expected an array. Ignoring it.');
		return [];
	}
	const out: McpServerConfig[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const server = normalizeMcpServer(item, problems);
		if (!server) { continue; }
		if (seen.has(server.id)) {
			problems.push(`forja.mcp.servers: duplicate server id "${server.id}" ignored.`);
			continue;
		}
		seen.add(server.id);
		out.push(server);
	}
	return out;
}

function normalizeMcpServer(raw: unknown, problems: string[]): McpServerConfig | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		problems.push('forja.mcp.servers: skipped an entry that was not an object.');
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const id = typeof source['id'] === 'string' ? source['id'].trim() : '';
	if (!ID_PATTERN.test(id)) {
		problems.push(`forja.mcp.servers: skipped a server with an invalid id ${describe(source['id'])}.`);
		return undefined;
	}
	const transportRaw = source['transport'];
	const transport: McpServerConfig['transport'] =
		transportRaw === 'http' || transportRaw === 'sse' || transportRaw === 'stdio'
			? transportRaw
			: typeof source['url'] === 'string' ? 'http' : 'stdio';
	const command = typeof source['command'] === 'string' ? source['command'] : undefined;
	const url = typeof source['url'] === 'string' ? source['url'] : undefined;
	if (transport === 'stdio' && !command) {
		problems.push(`forja.mcp.servers.${id}: stdio transport needs a "command". Skipped.`);
		return undefined;
	}
	if (transport !== 'stdio' && !url) {
		problems.push(`forja.mcp.servers.${id}: ${transport} transport needs a "url". Skipped.`);
		return undefined;
	}
	const env = normalizeStringMap(source['env']);
	const headers = normalizeStringMap(source['headers']);
	const timeoutMs = positive(source['timeoutMs'], 600_000);
	return {
		id,
		name: typeof source['name'] === 'string' && source['name'].trim() ? source['name'].trim() : id,
		enabled: source['enabled'] !== false,
		transport,
		...(command ? { command } : {}),
		...(Array.isArray(source['args']) ? { args: source['args'].filter((a): a is string => typeof a === 'string') } : {}),
		...(typeof source['cwd'] === 'string' ? { cwd: source['cwd'] } : {}),
		...(env ? { env } : {}),
		...(url ? { url } : {}),
		...(headers ? { headers } : {}),
		...(Array.isArray(source['autoApproveTools']) ? { autoApproveTools: source['autoApproveTools'].filter((a): a is string => typeof a === 'string') } : {}),
		...(timeoutMs !== undefined ? { timeoutMs: Math.round(timeoutMs) } : {})
	};
}

/**
 * Normalizes arbitrary input into usable settings. Never throws: bad config must degrade, not
 * prevent the IDE from starting.
 */
export function validateSettings(input: unknown): { settings: ForjaSettings; problems: string[] } {
	const problems: string[] = [];
	const source = typeof input === 'object' && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined;
	if (input !== undefined && !source) {
		problems.push(`forja: settings must be an object, got ${describe(input)}. Using defaults.`);
	}
	const out: Record<string, unknown> = {};
	for (const leaf of LEAVES) {
		const raw = source ? getPath(source, leaf.path) : undefined;
		setPath(out, leaf.path, raw === undefined ? (Array.isArray(leaf.def) ? [...leaf.def] : leaf.def) : coerceLeaf(leaf, raw, problems));
	}
	setPath(out, 'providers', normalizeProviders(source ? getPath(source, 'providers') : undefined, problems));
	setPath(out, 'mcp.servers', normalizeMcpServers(source ? getPath(source, 'mcp.servers') : undefined, problems));

	if (source) {
		for (const key of Object.keys(source)) {
			const known = LEAVES.some((leaf) => leaf.path === key || leaf.path.startsWith(`${key}.`))
				|| (COLLECTION_PATHS as readonly string[]).some((path) => path === key || path.startsWith(`${key}.`));
			if (!known) {
				problems.push(`forja.${key}: unknown setting ignored.`);
			}
		}
	}
	return { settings: out as unknown as ForjaSettings, problems };
}

function stripPrefix(dottedKey: string): string {
	return dottedKey.startsWith('forja.') ? dottedKey.slice('forja.'.length) : dottedKey;
}

export function getSettingValue(settings: ForjaSettings, dottedKey: string): unknown {
	return getPath(settings, stripPrefix(dottedKey));
}

/** Deep-sets a value, returning a new object; the input is not mutated. */
export function setSettingValue<T extends object>(target: T, dottedKey: string, value: unknown): T {
	const clone = structuredClone(target) as Record<string, unknown>;
	setPath(clone, stripPrefix(dottedKey), value);
	return clone as T;
}

export function isKnownSettingKey(dottedKey: string): boolean {
	const path = stripPrefix(dottedKey);
	return LEAVES.some((leaf) => leaf.path === path) || (COLLECTION_PATHS as readonly string[]).includes(path);
}

export function describeSetting(dottedKey: string): SettingDescriptor | undefined {
	const path = stripPrefix(dottedKey);
	return settingsSchemaDescriptors().find((descriptor) => descriptor.path === path);
}
