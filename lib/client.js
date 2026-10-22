// dsh-mailbox client half: one pill in the composer dock row (next to the
// cache-hit / activity stats) showing this session's mailbox identity and
// unread count.
//
// Built in the harness's lazy-CJS module format: the host serves this file
// verbatim from the package's ./client export, and __ModuleLoader__.load only
// registers the factory (materialization happens on first import).
//
// Data: the host half registers GET /dsh-mailbox/status (same origin), so the
// pill polls it and picks its own session by the slot's sessionId prop.
window.__ModuleLoader__.load({
	id: "pi-mailbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		// Matches the shipped stat pills (StatsPills.module.css): same variables,
		// same metrics, so the entry sits in the row instead of interrupting it.
		const ANCHOR_STYLE = {
			display: "inline-flex",
			minWidth: 0,
			// The dock row renders its slot entries BEFORE the ContextMeter
			// (ui-conversation InputBar: [...dock, <ContextMeter/>]); a high
			// flex order puts this pill after the "context used" meter.
			order: 100,
			fontSize: "calc(var(--dsh-content-font-size-secondary, 13px) - 1px)",
			lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
		};
		const PILL_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			padding: "1px 8px",
			maxWidth: "100%",
			borderRadius: "var(--dsw-radius-sm)",
			color: "var(--dsw-alias-label-tertiary)",
			background: "none",
			border: "none",
			font: "inherit",
			fontVariantNumeric: "tabular-nums",
			lineHeight: "inherit",
			whiteSpace: "nowrap",
		};
		const LABEL_STYLE = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
		const COUNT_STYLE = { color: "var(--dsw-alias-label-secondary)", fontWeight: 600 };

		function MailboxPill(props) {
			const sessionId = props.sessionId;
			const [entry, setEntry] = react.useState(null);
			react.useEffect(() => {
				if (!sessionId) {
					setEntry(null);
					return;
				}
				let alive = true;
				const read = async () => {
					try {
						const response = await fetch("/dsh-mailbox/status", { cache: "no-store" });
						if (!response.ok) throw new Error(String(response.status));
						const data = await response.json();
						const found = Array.isArray(data.sessions)
							? data.sessions.find((session) => session.sessionId === sessionId)
							: undefined;
						if (alive) setEntry(found ?? null);
					} catch {
						if (alive) setEntry(null);
					}
				};
				void read();
				const timer = setInterval(read, 3000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId]);

			if (entry === null || entry === undefined) return null;
			const label = entry.name || entry.address || "mailbox";
			const title =
				(entry.address || label) +
				(entry.connected ? "" : " (offline)") +
				(entry.unread ? " · " + entry.unread + " unread" : "");
			return react.createElement(
				"span",
				{ style: ANCHOR_STYLE },
				react.createElement(
					"span",
					{
						style: { ...PILL_STYLE, opacity: entry.connected ? 1 : 0.5 },
						title,
						"data-dsh-mailbox": label,
					},
					[
						react.createElement("span", { key: "icon", style: { flex: "none" }, "aria-hidden": "true" }, "📧"),
						react.createElement("span", { key: "label", style: LABEL_STYLE }, label),
						entry.unread
							? react.createElement("span", { key: "count", style: COUNT_STYLE }, String(entry.unread))
							: null,
					],
				),
			);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "mailbox", order: 2 }, MailboxPill),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
