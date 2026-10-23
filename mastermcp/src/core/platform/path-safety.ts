import { posix, win32 } from 'node:path';

/** Resolve containment with the target operating system's path semantics. */
export function isPathWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
	const paths = platform === 'win32' ? win32 : posix;
	const relative = paths.relative(paths.resolve(root), paths.resolve(candidate));
	if (relative === '') return true;
	return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}
