// dsh-mailbox client half.
//
// Two surfaces, both fed by one poll of the host's GET /dsh-mailbox/status:
//   - a composer-dock pill (after the "context used" meter) with the session's
//     mailbox identity and unread count;
//   - the sidebar Session row's 16px leading cell: a 📧 marker while that
//     session has unread mail (archived rows never render that seat).
//
// Built in the harness's lazy-CJS module format: the host serves this file
// verbatim from the package's ./client export, and __ModuleLoader__.load only
// registers the factory (materialization happens on first import).
window.__ModuleLoader__.load({
	id: "pi-mailbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		// One poll for every mounted surface: rows and the dock share a snapshot.
		const listeners = new Set();
		let snapshot = null;
		let timer = null;

		async function refresh() {
			try {
				const response = await fetch("/dsh-mailbox/status", { cache: "no-store" });
				if (!response.ok) throw new Error(String(response.status));
				const data = await response.json();
				snapshot = Array.isArray(data.sessions) ? data.sessions : [];
			} catch {
				snapshot = null;
			}
			for (const listener of [...listeners]) listener();
		}

		function subscribe(listener) {
			listeners.add(listener);
			if (timer === null) {
				void refresh();
				timer = setInterval(refresh, 3000);
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0 && timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
		}

		function useMailbox(sessionId) {
			const [entry, setEntry] = react.useState(null);
			react.useEffect(() => {
				if (!sessionId) {
					setEntry(null);
					return;
				}
				const read = () => {
					setEntry(snapshot ? (snapshot.find((item) => item.sessionId === sessionId) ?? null) : null);
				};
				read();
				return subscribe(read);
			}, [sessionId]);
			return entry;
		}

		// Metrics of the shipped stat pills (StatsPills.module.css) and of the
		// context meter, so the dock entry sits in the row instead of breaking it.
		const ANCHOR_STYLE = {
			display: "inline-flex",
			minWidth: 0,
			// The dock row renders its slot entries BEFORE the ContextMeter; a high
			// flex order puts this pill after the "context used" reading.
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

		function titleOf(entry) {
			const label = entry.address || entry.name || "mailbox";
			return (
				label +
				(entry.connected ? "" : " (offline)") +
				(entry.unread ? " · " + entry.unread + " unread" : "")
			);
		}

		function MailboxPill(props) {
			const entry = useMailbox(props.sessionId);
			if (entry === null || entry === undefined) return null;
			const label = entry.name || entry.address || "mailbox";
			return react.createElement(
				"span",
				{ style: ANCHOR_STYLE },
				react.createElement(
					"span",
					{
						style: { ...PILL_STYLE, opacity: entry.connected ? 1 : 0.5 },
						title: titleOf(entry),
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

		const ROW_DOT_STYLE = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: "16px",
			height: "16px",
			fontSize: "11px",
			lineHeight: 1,
		};

		function MailboxRowDot(props) {
			const entry = useMailbox(props.sessionId);
			if (entry === null || entry === undefined || !entry.unread) return null;
			return react.createElement(
				"span",
				{ style: ROW_DOT_STYLE, title: titleOf(entry), "data-dsh-mailbox-row": entry.address || "" },
				"📧",
			);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "mailbox", order: 2 }, MailboxPill),
			);
			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register({ name: "sidebar.session.row.leading", id: "mailbox" }, MailboxRowDot),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
