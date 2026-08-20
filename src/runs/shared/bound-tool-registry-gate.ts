import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBoundToolRegistryGate } from "./bound-tool-registry-runtime.ts";

export default function boundToolRegistryGate(pi: ExtensionAPI): void {
	registerBoundToolRegistryGate(pi);
}
