import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Discovers the packages of a repository without external dependencies.
 * Supports pnpm workspaces (`pnpm-workspace.yaml`), npm/yarn workspaces
 * (`workspaces` in package.json), and single-package repos. Glob support is
 * intentionally minimal: literal directories and `dir/*` patterns, which is
 * all the Codama repositories use.
 *
 * @param {string} rootDir
 * @returns {Array<{dir: string, name: string, version: string, private: boolean, repository: string | null}>}
 */
export function discoverPackages(rootDir) {
    const patterns = readWorkspacePatterns(rootDir);
    if (patterns === null) {
        const pkg = readPackageJson(rootDir);
        return pkg ? [pkg] : [];
    }
    const dirs = new Set();
    for (const pattern of patterns) {
        if (pattern.startsWith('!')) continue;
        if (pattern.endsWith('/*')) {
            const base = join(rootDir, pattern.slice(0, -2));
            if (!existsSync(base)) continue;
            for (const entry of readdirSync(base, { withFileTypes: true })) {
                if (entry.isDirectory()) dirs.add(join(base, entry.name));
            }
        } else if (!pattern.includes('*')) {
            dirs.add(join(rootDir, pattern));
        } else {
            throw new Error(`Unsupported workspace pattern "${pattern}". Supported: literal paths and "dir/*".`);
        }
    }
    const packages = [];
    for (const dir of [...dirs].sort()) {
        const pkg = readPackageJson(dir);
        if (pkg) packages.push(pkg);
    }
    return packages;
}

/** Returns workspace glob patterns, or `null` for single-package repos. */
function readWorkspacePatterns(rootDir) {
    const pnpmWorkspace = join(rootDir, 'pnpm-workspace.yaml');
    if (existsSync(pnpmWorkspace)) {
        const patterns = parsePnpmWorkspacePackages(readFileSync(pnpmWorkspace, 'utf8'));
        if (patterns.length > 0) return patterns;
    }
    const rootPackageJsonPath = join(rootDir, 'package.json');
    if (existsSync(rootPackageJsonPath)) {
        const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8'));
        if (Array.isArray(rootPackageJson.workspaces)) return rootPackageJson.workspaces;
    }
    return null;
}

/**
 * Minimal parser for the `packages:` list of a pnpm-workspace.yaml file.
 * Handles the common `- 'pattern'` / `- "pattern"` / `- pattern` list forms.
 */
export function parsePnpmWorkspacePackages(yaml) {
    const patterns = [];
    let inPackages = false;
    for (const rawLine of yaml.split('\n')) {
        const line = rawLine.replace(/#.*$/, '').trimEnd();
        if (/^packages\s*:/.test(line)) {
            inPackages = true;
            continue;
        }
        if (inPackages) {
            const item = /^\s+-\s+(.+)$/.exec(line);
            if (item) {
                patterns.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
            } else if (line.trim() !== '') {
                inPackages = false; // Next top-level key.
            }
        }
    }
    return patterns;
}

function readPackageJson(dir) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed.name || !parsed.version) return null;
    const repository = typeof parsed.repository === 'string' ? parsed.repository : (parsed.repository?.url ?? null);
    return { dir, name: parsed.name, version: parsed.version, private: parsed.private === true, repository };
}
