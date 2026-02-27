/**
 * Path resolution utilities for the shell.
 * The virtual filesystem uses absolute paths from the root (e.g., '/foo/bar'),
 * but the underlying FS implementation expects normalized relative paths (e.g., 'foo/bar').
 */

/**
 * Resolves a given path against a current working directory.
 *
 * Handles:
 * - Absolute paths (starting with '/')
 * - Relative paths
 * - '.' and '..' segments
 *
 * @param cwd The current working directory (must be an absolute path).
 * @param path The path to resolve.
 * @returns The new, resolved absolute path.
 */
export function resolve(cwd: string, path: string): string {
  if (path.startsWith('/')) {
    // It's an absolute path, so we start from the root.
    cwd = '/';
  }

  const parts = path.split('/').filter(p => p !== '');
  const cwdParts = cwd.split('/').filter(p => p !== '');
  
  let finalParts = [...cwdParts];

  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      if (finalParts.length > 0) {
        finalParts.pop();
      }
    } else {
      finalParts.push(part);
    }
  }

  return '/' + finalParts.join('/');
}

/**
 * Converts an absolute virtual path to a normalized relative path for the FS backend.
 * @param absolutePath An absolute path like '/foo/bar'.
 * @returns A relative path like 'foo/bar', or '' for the root.
 */
export function toRelative(absolutePath: string): string {
  return absolutePath.slice(1);
}
