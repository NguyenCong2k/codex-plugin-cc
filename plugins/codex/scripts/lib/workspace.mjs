import { ensureGitRepository } from "./git.mjs";

const roots = new Map();

export function resolveWorkspaceRoot(cwd) {
  if (roots.has(cwd)) return roots.get(cwd);
  try {
    const root = ensureGitRepository(cwd);
    roots.set(cwd, root);
    return root;
  } catch {
    roots.set(cwd, cwd);
    return cwd;
  }
}
