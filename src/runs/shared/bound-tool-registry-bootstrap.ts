import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeBoundToolRegistryBootstrap } from "./bound-tool-registry-runtime.ts";

export default function boundToolRegistryBootstrap(_pi: ExtensionAPI): void {
	initializeBoundToolRegistryBootstrap();
}
