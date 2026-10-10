// mailboxd web UI — read-only viewer.
// The connection token (if any) travels in the URL fragment (#t=...);
// it is read once here and sent as a Bearer header on every API call.

"use strict";

const token = new URLSearchParams((location.hash || "").replace(/^#/, "")).get("t") || "";

async function api(path) {
	const resp = await fetch(path, {
		headers: token ? { Authorization: "Bearer " + token } : {},
	});
	if (resp.status === 401) throw new Error("unauthorized: wrong or missing token");
	if (resp.status === 403) throw new Error("forbidden: " + (await resp.json()).error);
	if (!resp.ok) throw new Error("HTTP " + resp.status);
	return resp.json();
}

const state = {
	info: null,
	sessions: [],
	selected: null, // session address currently displayed
	selectedMail: null, // mail detail to show inside the mailbox view
};

function addr(s) {
	return s.session + "@" + (s.project || "");
}

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
	for (const c of children) {
		if (c == null) continue;
		node.append(typeof c === "string" ? document.createTextNode(c) : c);
	}
	return node;
}

function fmtTime(iso) {
	if (!iso) return "";
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

// ---------------------------------------------------------------- rendering

function renderSidebar() {
	const nav = document.getElementById("sidebar");
	nav.replaceChildren();
	const byProject = new Map();
	for (const s of state.sessions) {
		if (!byProject.has(s.project)) byProject.set(s.project, []);
		byProject.get(s.project).push(s);
	}
	if (byProject.size === 0) {
		nav.append(el("p", { class: "hint" }, "no sessions"));
		return;
	}
	for (const [project, sessions] of [...byProject.entries()].sort()) {
		const group = el("div", { class: "project" },
			el("h2", {}, project));
		for (const s of sessions.sort((a, b) => a.session < b.session ? -1 : 1)) {
			const extra = [s.agent, s.name, (s.tags || []).join(",")].filter(Boolean).join(" · ");
			const item = el("button", {
				type: "button",
				class: "session" + (addr(s) === state.selected ? " active" : ""),
			},
				el("span", { class: "mark " + (s.online ? "on" : "off") }, s.online ? "*" : "-"),
				el("span", { class: "address" }, addr(s)),
				el("span", { class: "who" }, extra),
			);
			item.addEventListener("click", () => selectSession(addr(s)));
			group.append(item);
		}
		nav.append(group);
	}
}

function renderContent() {
	const content = document.getElementById("content");
	content.replaceChildren();
	if (!state.selected) {
		content.append(el("p", { class: "hint" }, "Select a session to view its mailbox."));
		return;
	}
	if (state.mailboxError) {
		content.append(el("p", { class: "error" }, state.mailboxError));
		return;
	}
	const mb = state.mailbox;
	if (!mb) {
		content.append(el("p", { class: "hint" }, "loading…"));
		return;
	}
	const head = el("h1", {}, state.selected,
		el("span", { class: "counts" }, `${mb.totalUnread} unread / ${mb.total} mails`));

	if (state.selectedMail) {
		content.append(head, renderMailDetail(state.selectedMail));
		return;
	}
	if (mb.mails.length === 0) {
		content.append(head, el("p", { class: "hint" }, "mailbox is empty"));
	} else {
		const list = el("ul", { class: "mails" });
		for (const m of mb.mails) {
			const item = el("li", { class: m.readAt ? "read" : "unread" },
				el("span", { class: "dot" }, m.readAt ? "" : "●"),
				el("span", { class: "from" }, `${m.from.session}@${m.from.project}`),
				el("span", { class: "date" }, fmtTime(m.createdAt)),
				el("span", { class: "subject" }, m.subject),
			);
			item.addEventListener("click", () => selectMail(m));
			list.append(item);
		}
		content.append(head, list);
	}
	if (mb.nextCursor) {
		const more = el("button", { type: "button", class: "more" }, "older mails");
		more.addEventListener("click", () => loadMailbox(mb.nextCursor, true));
		content.append(more);
	}
	// session meta panel (full, unfiltered)
	const session = state.sessions.find((s) => addr(s) === state.selected);
	if (session && session.meta && Object.keys(session.meta).length > 0) {
		const panel = el("div", { class: "meta" }, el("h2", {}, "meta"));
		const table = el("table", {});
		for (const [k, v] of Object.entries(session.meta).sort()) {
			table.append(el("tr", {}, el("th", {}, k), el("td", {}, v)));
		}
		panel.append(table);
		content.append(panel);
	}
}

function renderMailDetail(mail) {
	const box = el("article", { class: "mail-detail" });
	box.append(el("h2", {}, mail.subject));
	box.append(el("p", { class: "meta-line" }, "from: ", el("strong", {}, `${mail.from.session}@${mail.from.project}`)));
	box.append(el("p", { class: "meta-line" }, "date: " + fmtTime(mail.createdAt)));
	box.append(el("p", { class: "meta-line" }, "read: " + (mail.readAt ? fmtTime(mail.readAt) : "unread")));
	if ((mail.refs || []).length > 0) {
		const refs = el("p", { class: "meta-line" }, "refs: ");
		mail.refs.forEach((r, i) => {
			if (i > 0) refs.append(", ");
			const link = el("a", { href: "#", class: "ref" }, `${r.session}@${r.project}/${r.mail}`);
			link.addEventListener("click", (ev) => {
				ev.preventDefault();
				selectSession(`${r.session}@${r.project}`, r.mail);
			});
			refs.append(link);
		});
		box.append(refs);
	}
	box.append(el("pre", { class: "body" }, mail.body));
	const back = el("button", { type: "button" }, "back to mailbox");
	back.addEventListener("click", () => {
		state.selectedMail = null;
		renderContent();
	});
	box.append(back);
	return box;
}

// ------------------------------------------------------------------ actions

async function selectSession(address, mailId) {
	state.selected = address;
	state.selectedMail = null;
	state.mailbox = null;
	state.mailboxError = null;
	renderSidebar();
	renderContent();
	await loadMailbox(null, false);
	if (mailId) await selectMail({ id: mailId });
}

async function loadMailbox(cursor, append) {
	try {
		const query = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
		const mb = await api("/api/mailbox/" + state.selected + query);
		if (append && state.mailbox) {
			state.mailbox.mails = state.mailbox.mails.concat(mb.mails);
			state.mailbox.nextCursor = mb.nextCursor;
		} else {
			state.mailbox = mb;
		}
	} catch (err) {
		state.mailboxError = String(err.message || err);
	}
	renderContent();
}

async function selectMail(m) {
	try {
		const detail = await api(`/api/mail/${state.selected}/${m.id}`);
		state.selectedMail = detail;
	} catch (err) {
		state.selectedMail = null;
		state.mailboxError = String(err.message || err);
	}
	renderContent();
}

async function refresh() {
	try {
		const [info, sessions] = await Promise.all([
			api("/api/info"),
			api("/api/sessions?includeOffline=1"),
		]);
		state.info = info;
		state.sessions = sessions.sessions || [];
		const proj = (info.projects || []).map((p) => p.id).join(", ");
		document.getElementById("daemon-info").textContent =
			`mailboxd · instance ${info.instanceId} · ${info.remote ? "remote" : "local"} · projects: ${proj || "none"}`;
		if (state.selected && !state.sessions.some((s) => addr(s) === state.selected)) {
			state.selected = null;
			state.selectedMail = null;
			state.mailbox = null;
		}
		renderSidebar();
		renderContent();
	} catch (err) {
		document.getElementById("content").replaceChildren(
			el("p", { class: "error" }, String(err.message || err)));
	}
}

document.getElementById("refresh").addEventListener("click", refresh);
refresh();
