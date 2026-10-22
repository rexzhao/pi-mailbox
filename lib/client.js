// dsh-mailbox client half.
//
// Surfaces, all fed by one poll of the host's GET /dsh-mailbox/status:
//   - composer-dock pill (after the "context used" meter): identity + unread;
//   - sidebar Session row leading cell: 📧 while that session has unread mail;
//   - sidebar Session row hover card: address / online / unread;
//   - a /mailbox popup (bare invocation) that lists mailbox actions and every
//     known login name, so picking runs "/mailbox login <name>" for you.
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

		// ---- shared mailbox snapshot: one poll, many subscribers ----
		const listeners = new Set();
		let snapshot = null;
		let timer = null;

		async function refresh() {
			try {
				const response = await fetch("/dsh-mailbox/status", { cache: "no-store" });
				if (!response.ok) throw new Error(String(response.status));
				const data = await response.json();
				snapshot = Array.isArray(data.mailboxes) ? data.mailboxes : [];
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

		function titleOf(entry) {
			const names = Array.isArray(entry.identities)
				? entry.identities.map((identity) => identity.address || identity.name)
				: [];
			const head = names.length > 0 ? names.join(", ") : entry.address || entry.name || "mailbox";
			const parts = [head];
			if (!entry.connected) parts.push("offline");
			if (entry.unread) parts.push(entry.unread + " unread");
			if (entry.archived) parts.push("archived");
			return parts.join(" · ");
		}

		// ---- composer dock pill (after the context meter) ----
		const ANCHOR_STYLE = {
			display: "inline-flex",
			minWidth: 0,
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
			const entry = useMailbox(props.sessionId);
			if (entry === null || entry === undefined) return null;
			const label = entry.name || entry.address || "mailbox";
			const extra = Array.isArray(entry.identities) ? entry.identities.length - 1 : 0;
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
						react.createElement("span", { key: "label", style: LABEL_STYLE }, extra > 0 ? label + " +" + extra : label),
						entry.unread
							? react.createElement("span", { key: "count", style: COUNT_STYLE }, String(entry.unread))
							: null,
					],
				),
			);
		}

		// ---- sidebar row leading marker ----
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

		// ---- sidebar row hover card ----
		const HOVER_STYLE = {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis",
		};

		function MailboxHover(props) {
			const entry = useMailbox(props.sessionId);
			if (entry === null || entry === undefined) return null;
			const identities =
				Array.isArray(entry.identities) && entry.identities.length > 0
					? entry.identities
					: [{ name: entry.name, address: entry.address, connected: entry.connected, unread: entry.unread }];
			return react.createElement(
				"div",
				{
					style: {
						...HOVER_STYLE,
						flexDirection: "column",
						alignItems: "flex-start",
						gap: "2px",
						whiteSpace: "normal",
					},
					"data-dsh-mailbox-hover": entry.name,
				},
				identities.map((identity) =>
					react.createElement(
						"div",
						{ key: identity.name, style: { display: "flex", alignItems: "center", gap: "6px" } },
						"📧 " +
							(identity.address || identity.name) +
							(identity.connected ? "" : " · offline") +
							(identity.unread ? " · " + identity.unread + " unread" : ""),
					),
				),
			);
		}

		// ---- /mailbox popup: actions + login names ----
		async function mailboxOptions(session) {
			const options = [
				{ id: "/mailbox list mail", label: "List mail", detail: "Show this session's inbox" },
				{ id: "/mailbox logout", label: "Logout", detail: "Leave every held mailbox" },
				{ id: "/mailbox start service", label: "Start service", detail: "Spawn the mailbox daemon" },
			];
			try {
				const response = await fetch("/dsh-mailbox/status", { cache: "no-store" });
				const data = await response.json();
				const rows = Array.isArray(data.mailboxes) ? data.mailboxes : [];
				const own = session && session.sessionId ? rows.find((row) => row.sessionId === session.sessionId) : undefined;
				const held = (own && Array.isArray(own.identities) ? own.identities : []).filter((identity) => identity.name);
				const heldNames = new Set(held.map((identity) => identity.name.toLowerCase()));
				const known = new Map();
				for (const row of rows) {
					for (const identity of Array.isArray(row.identities) ? row.identities : []) {
						if (!identity.name || identity.name === "user") continue;
						const key = identity.name.toLowerCase();
						if (!known.has(key)) known.set(key, identity);
					}
				}
				for (const identity of known.values()) {
					if (heldNames.has(identity.name.toLowerCase())) continue;
					options.push({
						id: "/mailbox login " + identity.name,
						label: "Login " + identity.name,
						detail:
							(identity.connected ? "online" : "offline") +
							(identity.unread ? " · " + identity.unread + " unread" : ""),
						group: { name: "login", label: "Login" },
					});
				}
				for (const identity of held) {
					options.push({
						id: "/mailbox logout " + identity.name,
						label: "Logout " + identity.name,
						detail: identity.unread ? identity.unread + " unread" : "held identity",
						group: { name: "logout", label: "Held identities" },
					});
				}
			} catch {
				// an empty catalog still offers the fixed actions
			}
			return options;
		}

		function registerPopup(ctx) {
			ctx.inject(["commandUi"], (scope) => {
				const commandUi = scope.commandUi;
				if (commandUi === undefined || typeof commandUi.decorate !== "function") return;
				commandUi.decorate({
					name: "mailbox",
					ui: {
						kind: "popupSelect",
						searchLabels: () => ({
							placeholder: "Mailbox action or login name",
							empty: "No mailbox actions",
							noResults: "No matching action",
						}),
						options: (session) => mailboxOptions(session),
						onSelect: async (option, session) => {
							await ctx.remote.commands.execute(session.sessionId, option.id, []);
						},
					},
				});
			});
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "mailbox", order: 2 }, MailboxPill),
			);
			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register({ name: "sidebar.session.row.leading", id: "mailbox" }, MailboxRowDot),
			);
			ctx.slots.inject("sidebar.session.row.hover", () =>
				ctx.slots.register({ name: "sidebar.session.row.hover", id: "mailbox" }, MailboxHover),
			);
			try {
				registerPopup(ctx);
			} catch {
				// the popup is a convenience; the other surfaces keep working
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "remote"];
		return module.exports;
	},
});
