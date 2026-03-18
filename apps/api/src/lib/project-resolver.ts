import fs from "node:fs";
import path from "node:path";

export interface ResolvedProjectInfo {
  projectId: string;
  projectName: string;
  projectPath: string;
}

export function resolveProjectInfoFromCwd(cwd: string): ResolvedProjectInfo {
  const resolvedCwd = path.resolve(cwd);
  const projectPath = findProjectPath(resolvedCwd);

  return {
    projectId: Buffer.from(projectPath).toString("base64url"),
    projectName: path.basename(projectPath) || projectPath,
    projectPath
  };
}

function findProjectPath(cwd: string): string {
  let current = cwd;

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return cwd;
    }

    current = parent;
  }
}
