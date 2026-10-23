import type { Tool } from './tools/types.ts';
import { readFileTool, readFilesTool, patchFileTool, createFileTool, writeFileTool, deleteFileTool, moveFileTool } from './tools/file-tools.ts';
import { searchTextTool, searchFilesTool, searchSymbolTool, listDirectoryTool } from './tools/search-tools.ts';
import { terminalExecuteTool, hostTerminalExecuteTool, terminalBackgroundTool, processStatusTool, killProcessTool, runTestsTool, detectProjectTool } from './tools/terminal-tools.ts';
import { MASTER_MCP_ADB_TOOLS } from './tools/adb-tools.ts';
import { gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBlameTool, gitStageTool, gitCommitTool, gitCreateBranchTool, gitSwitchBranchTool } from './tools/git-tools.ts';
import { webFetchTool, webSearchTool } from './tools/web-tools.ts';

/** Direct workspace capabilities exported by Lite. There is no local model, IDE or mobile layer. */
export const LITE_TOOLS: readonly Tool[] = [
	readFileTool, readFilesTool, listDirectoryTool, searchTextTool, searchFilesTool, searchSymbolTool,
	patchFileTool, createFileTool, writeFileTool, deleteFileTool, moveFileTool,
	terminalExecuteTool, terminalBackgroundTool, processStatusTool, killProcessTool, runTestsTool, detectProjectTool,
	gitStatusTool, gitDiffTool, gitLogTool, gitShowTool, gitBlameTool, gitStageTool, gitCommitTool, gitCreateBranchTool, gitSwitchBranchTool,
	webFetchTool, webSearchTool
];

export const LITE_TOOL_MAP = new Map(LITE_TOOLS.map((tool) => [tool.name, tool]));

/** Host-user tools are intentionally outside the normal workspace catalog. */
export const LITE_HOST_TOOLS: readonly Tool[] = [hostTerminalExecuteTool, ...MASTER_MCP_ADB_TOOLS];
export const LITE_HOST_TOOL_MAP = new Map(LITE_HOST_TOOLS.map((tool) => [tool.name, tool]));
