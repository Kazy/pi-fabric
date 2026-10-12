// Pi's entry for this package. Pi's loader transforms this .ts file and maps
// @earendil-works/pi-coding-agent to the host's own copy. It imports the bundled
// .js files natively, and in a standalone Bun binary those resolve the package
// from pi-fabric's own node_modules: a second ExtensionRunner class that the
// host never instantiates. Advertise the host class the way
// src/durable/worker-host.ts does, so tool capture patches it.
// build.mjs copies this file verbatim next to dist/extension-bootstrap.js.
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const key = Symbol.for("pi-fabric.host-extension-runners.v1");
const holder = globalThis as typeof globalThis & { [key: symbol]: Set<unknown> | undefined };
(holder[key] ??= new Set()).add(ExtensionRunner);

export { default } from "./extension-bootstrap.js";
