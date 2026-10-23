/**
 * Project command detection.
 *
 * The agent must not guess `npm test` and then declare victory when the project uses pytest. So we
 * read the actual project manifests and derive the real commands for typecheck / lint / test / build.
 * Detection is cached per workspace by manifest mtime.
 *
 * Order matters: the most specific evidence wins (a `scripts.test` in package.json beats a guess
 * based on a dependency being present).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, readJsonFile } from '../platform/fsx.ts';

export type CheckKind = 'typecheck' | 'lint' | 'test' | 'build' | 'format';

export interface ProjectCommand {
	readonly kind: CheckKind;
	readonly command: string;
	/** Where the evidence came from, shown to the user so detection is auditable. */
	readonly source: string;
	/** Lower runs first. Cheap checks before expensive ones. */
	readonly order: number;
}

export interface ProjectProfile {
	readonly root: string;
	readonly ecosystems: readonly string[];
	readonly commands: readonly ProjectCommand[];
	readonly packageManager: string | undefined;
}

interface PackageJson {
	scripts?: Record<string, string>;
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	packageManager?: string;
	workspaces?: unknown;
}

async function detectPackageManager(root: string, pkg: PackageJson | undefined): Promise<string> {
	if (pkg?.packageManager) {
		const name = pkg.packageManager.split('@')[0];
		if (name) {
			return name;
		}
	}
	if (await pathExists(join(root, 'pnpm-lock.yaml'))) { return 'pnpm'; }
	if (await pathExists(join(root, 'yarn.lock'))) { return 'yarn'; }
	if (await pathExists(join(root, 'bun.lockb'))) { return 'bun'; }
	if (await pathExists(join(root, 'bun.lock'))) { return 'bun'; }
	return 'npm';
}

function runner(packageManager: string, script: string): string {
	// `npm run` needs `--` to forward flags; pnpm/yarn/bun do not. Keep it simple and consistent.
	return packageManager === 'npm' ? `npm run ${script}` : `${packageManager} run ${script}`;
}

/** Script names projects conventionally use, in order of how likely they are to be the real one. */
const SCRIPT_CANDIDATES: Record<CheckKind, readonly string[]> = {
	typecheck: ['typecheck', 'type-check', 'tsc', 'check-types', 'types'],
	lint: ['lint', 'eslint', 'lint:check', 'check'],
	test: ['test:unit', 'test', 'tests', 'jest', 'vitest'],
	build: ['build', 'compile', 'bundle'],
	format: ['format:check', 'format', 'prettier']
};

async function detectNode(root: string, commands: ProjectCommand[]): Promise<string | undefined> {
	const pkg = await readJsonFile<PackageJson>(join(root, 'package.json'));
	if (!pkg) {
		return undefined;
	}
	const packageManager = await detectPackageManager(root, pkg);
	const scripts = pkg.scripts ?? {};
	const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

	const orders: Record<CheckKind, number> = { typecheck: 10, lint: 20, test: 30, build: 40, format: 15 };
	for (const kind of ['typecheck', 'lint', 'test', 'build'] as CheckKind[]) {
		const found = (SCRIPT_CANDIDATES[kind] ?? []).find((name) => typeof scripts[name] === 'string');
		if (found) {
			commands.push({
				kind,
				command: runner(packageManager, found),
				source: `package.json scripts.${found}`,
				order: orders[kind]
			});
		}
	}
	// Fallbacks from dependencies when no script exists.
	if (!commands.some((command) => command.kind === 'typecheck') && 'typescript' in dependencies) {
		const hasConfig = await pathExists(join(root, 'tsconfig.json'));
		if (hasConfig) {
			commands.push({
				kind: 'typecheck',
				command: `${packageManager === 'npm' ? 'npx' : packageManager === 'bun' ? 'bunx' : `${packageManager} exec`} tsc --noEmit`,
				source: 'typescript dependency + tsconfig.json',
				order: 10
			});
		}
	}
	if (!commands.some((command) => command.kind === 'test')) {
		const framework = ['vitest', 'jest', 'mocha', 'ava'].find((name) => name in dependencies);
		if (framework) {
			const flags = framework === 'vitest' ? ' run' : '';
			commands.push({
				kind: 'test',
				command: `${packageManager === 'npm' ? 'npx' : packageManager === 'bun' ? 'bunx' : `${packageManager} exec`} ${framework}${flags}`,
				source: `${framework} dependency`,
				order: 30
			});
		}
	}
	return packageManager;
}

/** Python test files, by the two conventions pytest and unittest actually discover. */
async function findPythonTests(root: string): Promise<{ any: boolean; usesPytestLayout: boolean }> {
	const dirs = ['', 'tests', 'test', 'src'];
	let any = false;
	let usesPytestLayout = false;
	for (const dir of dirs) {
		let entries;
		try {
			entries = await readdir(join(root, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.py')) {
				continue;
			}
			if (/^test_.*\.py$/.test(entry.name) || /_test\.py$/.test(entry.name) || /^conftest\.py$/.test(entry.name)) {
				any = true;
				if (dir === 'tests' || dir === 'test' || entry.name === 'conftest.py') {
					usesPytestLayout = true;
				}
			}
		}
	}
	return { any, usesPytestLayout };
}

async function detectPython(root: string, commands: ProjectCommand[]): Promise<boolean> {
	const python = process.platform === 'win32' ? 'py -3' : 'python3';
	const hasPyproject = await pathExists(join(root, 'pyproject.toml'));
	const hasRequirements = await pathExists(join(root, 'requirements.txt'));
	const hasSetup = await pathExists(join(root, 'setup.py')) || await pathExists(join(root, 'setup.cfg'));
	const tests = await findPythonTests(root);

	// A bare `test/` or `tests/` directory is not evidence of Python — plenty of Node, Rust and Go
	// projects have one. Claiming otherwise adds a `pytest` command that always fails, and a
	// permanently failing check tells the agent its correct fix did not work.
	if (!hasPyproject && !hasRequirements && !hasSetup && !tests.any) {
		return false;
	}

	const hasManifest = hasPyproject || hasRequirements || hasSetup;
	const alreadyHasTestCommand = commands.some((command) => command.kind === 'test');
	// In a polyglot repository run both suites, but only when Python is a declared part of the project.
	// A stray `test_something.py` next to a Node app should not add a check that can fail on its own.
	if (tests.any && (hasManifest || !alreadyHasTestCommand)) {
		// unittest is in the standard library; pytest may not be installed. Only reach for pytest when the
		// layout says the project is organised around it.
		commands.push(tests.usesPytestLayout
			? { kind: 'test', command: `${python} -m pytest -q`, source: 'python test layout', order: 30 }
			: { kind: 'test', command: `${python} -m unittest discover`, source: 'python test files', order: 30 });
	}
	if (hasPyproject) {
		commands.push({ kind: 'lint', command: `${python} -m ruff check .`, source: 'pyproject.toml', order: 20 });
		commands.push({ kind: 'typecheck', command: `${python} -m mypy .`, source: 'pyproject.toml', order: 10 });
	}
	return true;
}

async function detectOthers(root: string, commands: ProjectCommand[], ecosystems: string[]): Promise<void> {
	const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
	const checks: { file: string; ecosystem: string; entries: Omit<ProjectCommand, 'source'>[] }[] = [
		{
			file: 'Cargo.toml', ecosystem: 'rust', entries: [
				{ kind: 'typecheck', command: 'cargo check', order: 10 },
				{ kind: 'lint', command: 'cargo clippy -- -D warnings', order: 20 },
				{ kind: 'test', command: 'cargo test', order: 30 },
				{ kind: 'build', command: 'cargo build', order: 40 }
			]
		},
		{
			file: 'go.mod', ecosystem: 'go', entries: [
				{ kind: 'typecheck', command: 'go vet ./...', order: 10 },
				{ kind: 'test', command: 'go test ./...', order: 30 },
				{ kind: 'build', command: 'go build ./...', order: 40 }
			]
		},
		{
			file: 'pom.xml', ecosystem: 'java-maven', entries: [
				{ kind: 'test', command: 'mvn -q test', order: 30 },
				{ kind: 'build', command: 'mvn -q -DskipTests package', order: 40 }
			]
		},
		{
			file: 'build.gradle', ecosystem: 'java-gradle', entries: [
				{ kind: 'test', command: `${gradleWrapper} test`, order: 30 },
				{ kind: 'build', command: `${gradleWrapper} build -x test`, order: 40 }
			]
		},
		{
			file: 'Gemfile', ecosystem: 'ruby', entries: [
				{ kind: 'test', command: 'bundle exec rspec', order: 30 }
			]
		},
		{
			file: 'composer.json', ecosystem: 'php', entries: [
				{ kind: 'test', command: 'vendor/bin/phpunit', order: 30 }
			]
		},
		{
			file: 'mix.exs', ecosystem: 'elixir', entries: [
				{ kind: 'test', command: 'mix test', order: 30 },
				{ kind: 'build', command: 'mix compile', order: 40 }
			]
		},
		{
			file: 'pubspec.yaml', ecosystem: 'dart', entries: [
				{ kind: 'test', command: 'dart test', order: 30 },
				{ kind: 'lint', command: 'dart analyze', order: 20 }
			]
		}
	];
	for (const check of checks) {
		if (!(await pathExists(join(root, check.file)))) {
			continue;
		}
		ecosystems.push(check.ecosystem);
		for (const entry of check.entries) {
			// Never shadow a command we already found from a more specific source.
			if (commands.some((existing) => existing.kind === entry.kind)) {
				continue;
			}
			commands.push({ ...entry, source: check.file });
		}
	}
}

const cache = new Map<string, { profile: ProjectProfile; expires: number }>();

/** Detects the project's real verification commands. Cached for a short while per workspace. */
export async function detectProject(root: string, options: { force?: boolean } = {}): Promise<ProjectProfile> {
	const cached = cache.get(root);
	if (!options.force && cached && cached.expires > Date.now()) {
		return cached.profile;
	}
	const commands: ProjectCommand[] = [];
	const ecosystems: string[] = [];

	const packageManager = await detectNode(root, commands);
	if (packageManager) {
		ecosystems.push('node');
	}
	if (await detectPython(root, commands)) {
		ecosystems.push('python');
	}
	await detectOthers(root, commands, ecosystems);

	commands.sort((a, b) => a.order - b.order);
	const profile: ProjectProfile = { root, ecosystems, commands, packageManager };
	cache.set(root, { profile, expires: Date.now() + 30_000 });
	return profile;
}

export function invalidateProjectCache(root?: string): void {
	if (root) {
		cache.delete(root);
	} else {
		cache.clear();
	}
}

/** The verification sequence for this project, honouring an explicit user override. */
export async function verificationCommands(
	root: string,
	override: readonly string[]
): Promise<ProjectCommand[]> {
	if (override.length > 0) {
		return override.map((command, index) => ({
			kind: 'test' as CheckKind,
			command,
			source: 'forja.agent.verifyCommands',
			order: index
		}));
	}
	const profile = await detectProject(root);
	return [...profile.commands];
}
