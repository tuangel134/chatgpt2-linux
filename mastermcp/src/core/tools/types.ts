/**
 * Tool runtime contracts.
 *
 * One registry serves three sources of tools: built-ins, MCP servers and skills. They all expose the
 * same shape so the agent loop, the policy gate and the UI never care where a tool came from.
 */

import type { Logger } from '../platform/logger.ts';
import type { GitService } from '../platform/git.ts';
import type { BackgroundProcessRegistry } from '../platform/process.ts';
import type { WorkspaceBoundary } from '../security/workspace-boundary.ts';
import type { RiskClass } from '../security/command-classifier.ts';
import type { ForjaSettings } from '../platform/config/schema.ts';
import type { PatchResult } from './patch-engine.ts';

/** Where a tool came from. Shown in the UI and used by the policy gate. */
export type ToolSource = 'builtin' | 'mcp' | 'skill';

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	/** JSON Schema for the arguments object. */
	readonly parameters: Record<string, unknown>;
	readonly source: ToolSource;
	/** Baseline risk. `terminal_execute` refines this per command at call time. */
	readonly risk: RiskClass;
	/** True when the tool changes the workspace; drives checkpointing and diff review. */
	readonly mutates: boolean;
	/** True when the tool is safe to run in parallel with others. */
	readonly parallelSafe: boolean;
	/** Tools hidden from Ask mode, which must not modify anything. */
	readonly readOnly: boolean;
	/** For MCP tools: the server that owns them. */
	readonly serverId?: string;
}

/** A change the agent made to a file, ready to be shown as a reviewable diff. */
export interface FileChangeRecord {
	readonly path: string;
	readonly kind: 'create' | 'modify' | 'delete' | 'move';
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
	/** Content before the change, for rollback. Undefined when the file did not exist. */
	readonly contentBefore: string | undefined;
	readonly contentAfter: string | undefined;
	readonly oldPath?: string;
}

export interface ToolResult {
	/** Text handed back to the model. Already truncated to the configured budget. */
	readonly output: string;
	readonly isError?: boolean;
	/** Structured payload for the UI; never sent to the model verbatim. */
	readonly data?: Record<string, unknown>;
	/** File changes produced by this call, for the diff review UI and checkpoints. */
	readonly changes?: readonly FileChangeRecord[];
	/** True when output was cut; the model is told so it can ask for more. */
	readonly truncated?: boolean;
}

/** Asks the user to approve something. Resolves false when denied. */
export type ConfirmFn = (request: {
	readonly title: string;
	readonly detail: string;
	readonly risk: RiskClass;
	readonly kind: 'command' | 'edit' | 'delete' | 'dependency' | 'external-path' | 'mcp';
	readonly command?: string;
	readonly paths?: readonly string[];
}) => Promise<boolean>;

export interface ToolContext {
	readonly workspaceRoot: string;
	readonly boundary: WorkspaceBoundary;
	readonly settings: ForjaSettings;
	readonly logger: Logger;
	readonly git: GitService | undefined;
	readonly processes: BackgroundProcessRegistry;
	readonly signal: AbortSignal;
	/** Session and step, for logs and checkpoint attribution. */
	readonly sessionId: string;
	readonly stepIndex: number;
	/** Undefined in headless/auto-approve contexts; then policy alone decides. */
	readonly confirm: ConfirmFn | undefined;
	/** Diagnostics provider, wired to the IDE when running inside it. */
	readonly diagnostics: (() => Promise<readonly Diagnostic[]>) | undefined;
	/** Editor state, only available inside the IDE. */
	readonly editor: EditorState | undefined;
	/** Calls Code OSS language providers when an IDE client is attached. */
	readonly codeIntelligence?: (request: CodeIntelligenceRequest) => Promise<CodeIntelligenceResult>;
	/** Records a file change so the runtime can checkpoint and show diffs. */
	readonly onFileChange: ((change: FileChangeRecord) => void) | undefined;
	/** Host paths a direct connector must never mutate, even with host terminal access. */
	readonly protectedHostPaths?: readonly string[];
	/** Explicit host capabilities for Master MCP terminal calls. Omitted for normal editor tools. */
	readonly hostTerminalPermissions?: Readonly<{
		readonly home: boolean;
		readonly ssh: boolean;
		readonly docker: boolean;
		readonly mounts: boolean;
		readonly systemWrite: boolean;
		readonly sudo: boolean;
		readonly devices: boolean;
	}>;
}

export interface Diagnostic {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly severity: 'error' | 'warning' | 'info' | 'hint';
	readonly message: string;
	readonly source?: string;
	readonly code?: string;
}

export interface EditorState {
	readonly activeFile?: string;
	readonly selection?: { path: string; startLine: number; endLine: number; text: string };
	readonly openFiles?: readonly string[];
}

/** Semantic query delegated to the language providers attached to the IDE. */
export type CodeIntelligenceOperation = 'definition' | 'references' | 'hover' | 'documentSymbols' | 'workspaceSymbols';

export interface CodeIntelligenceRequest {
	readonly operation: CodeIntelligenceOperation;
	/** Workspace-relative file. Required except for workspaceSymbols. */
	readonly path?: string;
	/** One-based source position for definition, references and hover. */
	readonly line?: number;
	readonly column?: number;
	readonly query?: string;
	readonly maxResults: number;
}

export interface CodeIntelligenceLocation {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly endLine?: number;
	readonly endColumn?: number;
	readonly name?: string;
	readonly kind?: string;
	readonly detail?: string;
}

export interface CodeIntelligenceResult {
	readonly available: boolean;
	readonly operation: CodeIntelligenceOperation;
	readonly locations?: readonly CodeIntelligenceLocation[];
	readonly markdown?: string;
	readonly message?: string;
}

export interface Tool extends ToolDefinition {
	execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type { PatchResult };
