/* Node ESM loader hook: append .js to relative specifiers lacking an
 * extension (dxf-viewer's source uses extensionless imports). */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !path.extname(specifier)
  ) {
    const parentUrl = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const parentDir = path.dirname(parentUrl);
    const candidate = path.resolve(parentDir, specifier + ".js");
    if (existsSync(candidate)) {
      return nextResolve(specifier + ".js", context);
    }
    const indexCandidate = path.resolve(parentDir, specifier, "index.js");
    if (existsSync(indexCandidate)) {
      return nextResolve(specifier + "/index.js", context);
    }
  }
  return nextResolve(specifier, context);
}
