// Canary: narrows the leaf registry after the barrier snapshot would be taken.
export default function narrow(pi: any): void {
	pi.on("session_start", () => { pi.setActiveTools([]); });
}
