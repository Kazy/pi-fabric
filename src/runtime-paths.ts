import fs from "node:fs";
import path from "node:path";

export interface FabricRuntimePaths {
  extension: string;
  worker: string;
  residentHost: string;
  skills: string;
}

// Pi removes duplicate extension paths by real path only. A child that loads the bootstrap
// with -e and the package entry from settings gets two Fabric instances that both register
// fabric_exec. Name the package entry instead, so both sources are one path.
export const childExtensionPath = (entryPath: string): string => {
  if (path.basename(entryPath, path.extname(entryPath)) !== "extension-bootstrap") return entryPath;
  const packageEntry = path.join(path.dirname(entryPath), "extension-entry.ts");
  return fs.existsSync(packageEntry) ? packageEntry : entryPath;
};
