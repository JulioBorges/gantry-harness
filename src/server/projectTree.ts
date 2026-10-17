import fs from 'node:fs';
import path from 'node:path';

export interface ProjectTreeEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}

export interface ProjectTreeListing {
  path: string;
  entries: ProjectTreeEntry[];
}

export class ProjectTreeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) {
    super(message);
    this.name = 'ProjectTreeError';
  }
}

const SEARCH_SKIP = new Set(['.git', 'node_modules']);
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_DEPTH = 8;
const MAX_SEARCH_DIRECTORIES = 4000;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function relativeSegments(relativePath: string): string[] {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (normalized.includes('\0') || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new ProjectTreeError('Caminho inválido.', 400);
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new ProjectTreeError('O caminho deve estar dentro do projeto.', 403);
  }
  return segments;
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function compareNames(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareEntries(a: ProjectTreeEntry, b: ProjectTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return compareNames(a.name, b.name) || compareNames(a.path, b.path);
}

function classify(root: string, absolute: string, dirent: fs.Dirent): 'directory' | 'file' | 'skip' {
  if (dirent.isSymbolicLink()) {
    try {
      const real = fs.realpathSync(absolute);
      if (!isInside(root, real)) return 'skip';
      return fs.statSync(real).isDirectory() ? 'directory' : 'file';
    } catch {
      return 'skip';
    }
  }
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'skip';
}

function resolveDirectory(root: string, relativePath: string): { relative: string; directory: string } {
  const segments = relativeSegments(relativePath);
  const lexical = path.resolve(root, ...segments);
  if (!isInside(root, lexical)) throw new ProjectTreeError('O caminho deve estar dentro do projeto.', 403);
  if (!fs.existsSync(lexical)) throw new ProjectTreeError('Pasta não encontrada.', 404);
  const directory = fs.realpathSync(lexical);
  if (!isInside(root, directory)) throw new ProjectTreeError('O caminho deve estar dentro do projeto.', 403);
  if (!fs.statSync(directory).isDirectory()) throw new ProjectTreeError('Pasta não encontrada.', 404);
  return { relative: segments.join('/'), directory };
}

function listDirectory(root: string, relative: string, directory: string): ProjectTreeEntry[] {
  const entries: ProjectTreeEntry[] = [];
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const kind = classify(root, path.join(directory, dirent.name), dirent);
    if (kind === 'skip') continue;
    entries.push({ name: dirent.name, path: joinRelative(relative, dirent.name), kind });
  }
  return entries.sort(compareEntries);
}

export function readProjectTree(projectPath: string, options: { path?: string; query?: string } = {}): ProjectTreeListing {
  const root = fs.realpathSync(projectPath);
  const query = options.query?.trim() ?? '';
  if (!query) {
    const located = resolveDirectory(root, options.path ?? '');
    return { path: located.relative, entries: listDirectory(root, located.relative, located.directory) };
  }

  const needle = query.toLowerCase();
  const matches: ProjectTreeEntry[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const walk = (directory: string, relative: string, depth: number): void => {
    if (matches.length >= MAX_SEARCH_RESULTS || depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_DIRECTORIES) return;
    let real: string;
    try {
      real = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (!isInside(root, real) || seen.has(real)) return;
    seen.add(real);
    visited += 1;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    const ordered = [...dirents].sort((a, b) => compareNames(a.name, b.name));
    for (const dirent of ordered) {
      if (matches.length >= MAX_SEARCH_RESULTS) return;
      const kind = classify(root, path.join(real, dirent.name), dirent);
      if (kind === 'skip') continue;
      const entryPath = joinRelative(relative, dirent.name);
      if (dirent.name.toLowerCase().includes(needle)) {
        matches.push({ name: dirent.name, path: entryPath, kind });
      }
      if (kind === 'directory' && depth < MAX_SEARCH_DEPTH && !SEARCH_SKIP.has(dirent.name)) {
        walk(path.join(real, dirent.name), entryPath, depth + 1);
      }
    }
  };

  walk(root, '', 0);
  return { path: '', entries: matches.sort(compareEntries).slice(0, MAX_SEARCH_RESULTS) };
}
