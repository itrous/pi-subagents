import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBoundPackageFactories } from "./bound-tool-registry-runtime.ts";

export default async function registerBoundPackageMediator(pi: ExtensionAPI): Promise<void> {
	await loadBoundPackageFactories(pi);
}
