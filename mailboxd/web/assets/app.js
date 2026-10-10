// mailboxd web UI — read-only viewer.
// The connection token (if any) travels in the URL fragment (#t=...);
// it is read once here and sent as a Bearer header on every API call.
// Navigation state also lives in the fragment (#project= / #session= /
// #mail=) so the browser back button works; writing the hash triggers
// applyParams via hashchange — navigation never mutates state directly.

"use strict";

function hashParams() {
	return new URLSearchParams((location.hash || "").replace(/^#/, ""));
}

// Addresses in the fragment are base64url-encoded: no @ / + = special
// characters in the URL. Inputs are ASCII (base36 ids), so btoa is safe.
function encRef(s) {
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decRef(s) {
	return atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
}

// The token is arbitrary, so it alone gets percent-encoded.
function writeHash(params) {
	const parts = [];
	for (const [k, v] of params.entries()) {
		parts.push(k + "=" + (k === "t" ? encodeURIComponent(v) : v));
	}
	location.hash = parts.join("&");
}

const token = hashParams().get("t") || "";

async function api(path, opts) {
	const init = opts
		? { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(opts) }
		: { headers: token ? { Authorization: "Bearer " + token } : {} };
	const resp = await fetch(path, init);
	if (resp.status === 401) throw new Error("unauthorized: wrong or missing token");
	if (resp.status === 403) throw new Error("forbidden: " + (await resp.json()).error);
	if (!resp.ok) throw new Error("HTTP " + resp.status);
	return resp.json();
}

const state = {
	info: null,
	sessions: [],
	selectedProject: null, // project id currently entered (null = overview)
	selected: null, // session address currently displayed
	selectedMail: null, // thread detail of the open mail
	mailbox: null, // inbox listing of the selected session
	mailboxError: null,
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
		const info = ((state.info && state.info.projects) || []).find((p) => p.id === project) || {};
		const where = [info.host, info.path].filter(Boolean).join("  ");
		const head = el("h2", {}, project);
		if (where) head.append(el("span", { class: "where", title: where }, where));
		const group = el("div", { class: "project" + (project === state.selectedProject ? " active" : "") }, head);
		head.addEventListener("click", () => selectProject(project));
		for (const s of sessions.sort((a, b) => (a.session < b.session ? -1 : 1))) {
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

function sessionCounts(project) {
	const list = state.sessions.filter((s) => s.project === project);
	return { total: list.length, online: list.filter((s) => s.online).length };
}

function renderContent() {
	const content = document.getElementById("content");
	content.replaceChildren();
	if (state.selectedMail) {
		const head = el("h1", {}, state.selected,
			el("span", { class: "counts" }, state.selectedMail.mail.subject));
		content.append(head, renderThread(state.selectedMail));
		return;
	}
	if (state.selected) {
		if (state.mailboxError) {
			content.append(el("p", { class: "error" }, state.mailboxError));
			return;
		}
		const mb = state.mailbox;
		if (!mb) {
			content.append(el("h1", {}, state.selected), el("p", { class: "hint" }, "loading…"));
			return;
		}
		// header, then meta, then the toolbar, then the mail list (newest first)
		const head = el("h1", {}, state.selected,
			el("span", { class: "counts" }, `${mb.totalUnread} unread / ${mb.total} mails`));
		content.append(head);

		renderMetaPanel(content);

		const delBtn = el("button", { type: "button", class: "danger" }, "delete this mailbox");
		delBtn.addEventListener("click", async () => {
			if (!confirm("Delete ALL mails and meta of " + state.selected + "? This cannot be undone.")) return;
			try {
				await api("/api/delete", { address: state.selected });
				selectProject(state.selectedProject); // the session is gone; back to the project
				refresh();
			} catch (err) {
				alert(String(err.message || err));
			}
		});
		const sendBtn = el("button", { type: "button" }, "send mail to this session");
		const slot = el("div", {});
		sendBtn.addEventListener("click", () => {
			if (slot.firstChild) {
				slot.replaceChildren();
				return;
			}
			slot.append(composeForm(state.selected, "", [], () => refresh()));
		});
		const toolbar = el("div", { class: "toolbar" }, sendBtn, delBtn);
		content.append(toolbar, slot);

		if (mb.mails.length === 0) {
			content.append(el("p", { class: "hint" }, "mailbox is empty"));
		} else {
			// API returns newest first; keep a defensive local sort
			const sorted = [...mb.mails].sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : x.id < y.id ? 1 : -1));
			const list = el("ul", { class: "mails" });
			for (const m of sorted) {
				const item = el("li", { class: m.readAt ? "read" : "unread" },
					el("span", { class: "dot" }, m.readAt ? "" : "●"),
					el("span", { class: "from" }, `${m.from.session}@${m.from.project}`),
					el("span", { class: "date" }, fmtTime(m.createdAt)),
					el("span", { class: "subject" }, m.subject),
				);
				item.addEventListener("click", () => selectMail(m));
				list.append(item);
			}
			content.append(list);
		}
		if (mb.nextCursor) {
			const more = el("button", { type: "button", class: "more" }, "older mails");
			more.addEventListener("click", () => loadMailbox(mb.nextCursor, true));
			content.append(more);
		}
		return;
	}
	if (state.selectedProject) {
		renderProjectDetail(content);
		return;
	}
	renderProjectOverview(content);
}

function renderProjectOverview(content) {
	content.append(el("h1", {}, "Projects"));
	const projects = (state.info && state.info.projects) || [];
	if (projects.length === 0) {
		content.append(el("p", { class: "hint" }, "no projects registered"));
		return;
	}
	const table = el("table", { class: "overview" },
		el("tr", {}, el("th", {}, "project"), el("th", {}, "host"), el("th", {}, "path"), el("th", {}, "sessions")));
	for (const p of projects) {
		const counts = sessionCounts(p.id);
		const row = el("tr", { class: "row" },
			el("td", { class: "mono" }, p.id),
			el("td", {}, p.host || "—"),
			el("td", { class: "mono path" }, p.path || "(central storage)"),
			el("td", {}, counts.online + " online / " + counts.total),
		);
		row.addEventListener("click", () => selectProject(p.id));
		table.append(row);
	}
	content.append(table);
}

async function renderProjectDetail(content) {
	const project = state.selectedProject; // capture for the stale check
	const info = ((state.info && state.info.projects) || []).find((p) => p.id === project) || {};
	const counts = sessionCounts(project);
	content.append(el("h1", {}, project,
		el("span", { class: "counts" }, counts.online + " online / " + counts.total + " sessions")));
	const where = [info.host, info.path].filter(Boolean).join("  ");
	if (where) content.append(el("p", { class: "hint where" }, where));

	let threads;
	try {
		threads = (await api("/api/threads/" + project)).threads || [];
	} catch (err) {
		if (state.selectedProject !== project) return; // stale response
		content.append(el("p", { class: "error" }, String(err.message || err)));
		return;
	}
	if (state.selectedProject !== project) return; // stale response
	if (threads.length === 0) {
		content.append(el("p", { class: "hint" }, "no conversations"));
		return;
	}
	const table = el("table", { class: "overview" },
		el("tr", {}, el("th", {}, ""), el("th", {}, "subject"), el("th", {}, "from"), el("th", {}, "mailbox"), el("th", {}, "replies"), el("th", {}, "last activity")));
	for (const t of threads) {
		const row = el("tr", { class: "row" + (t.mail.readAt ? "" : " unread") },
			el("td", { class: "dot" }, t.mail.readAt ? "" : "●"),
			el("td", { class: "subject" }, t.mail.subject),
			el("td", { class: "mono" }, t.mail.from.session + "@" + t.mail.from.project),
			el("td", { class: "mono path" }, t.owner),
			el("td", {}, String(t.replies)),
			el("td", {}, fmtTime(t.lastReplyAt || t.mail.createdAt)),
		);
		row.addEventListener("click", () => selectSession(t.owner, t.mail.id));
		table.append(row);
	}
	content.append(table);
	const back = el("button", { type: "button" }, "back to projects");
	back.addEventListener("click", () => selectProject(null));
	content.append(back);
}

function renderMetaPanel(content) {
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

// thread rendering: Reddit-style nesting — direct replies one level below
// the parent, replies-to-replies one level deeper

function refKeyOf(ref) {
	return ref.project + "/" + ref.session + "/" + ref.mail;
}

function entryKeyOf(entry) {
	// entry.owner = "session@project" (ids are base36, no "@" inside)
	const at = entry.owner.indexOf("@");
	return entry.owner.slice(at + 1) + "/" + entry.owner.slice(0, at) + "/" + entry.mail.id;
}

function renderThread(detail) {
	// index every thread mail by its ref
	const byRef = new Map();
	const rootKey = entryKeyOf({ owner: detail.owner, mail: detail.mail });
	byRef.set(rootKey, { owner: detail.owner, mail: detail.mail, children: [] });
	for (const r of detail.replies || []) {
		byRef.set(entryKeyOf(r), { owner: r.owner, mail: r.mail, children: [] });
	}
	const root = byRef.get(rootKey);
	// attach each reply to the thread mail it references (first resolvable
	// ref; a reply is in the closure only because at least one ref resolves)
	for (const r of detail.replies || []) {
		const node = byRef.get(entryKeyOf(r));
		let parent = root;
		for (const ref of r.mail.refs || []) {
			const p = byRef.get(refKeyOf(ref));
			if (p) {
				parent = p;
				break;
			}
		}
		parent.children.push(node);
	}
	const box = el("article", { class: "mail-detail" });
	box.append(renderThreadNode(root, 0));
	const back = el("button", { type: "button" }, "back to mailbox");
	back.addEventListener("click", closeMail);
	box.append(back);
	return box;
}

function renderThreadNode(node, depth) {
	const mail = node.mail;
	const article = el("article", { class: "reply" + (depth === 0 ? " root" : "") });
	const head = el("div", { class: "reply-head" },
		el("span", { class: "from" }, mail.from.session + "@" + mail.from.project),
		el("span", { class: "date" }, fmtTime(mail.createdAt)),
		el("span", { class: "spacer" }),
		el("button", { type: "button", class: "reply-btn" }, "reply"),
	);
	if (depth > 0) {
		head.addEventListener("click", (ev) => {
			if (ev.target.classList.contains("reply-btn")) return;
			selectSession(node.owner, mail.id);
		});
		head.title = "open this mail's own thread";
	}
	article.append(
		head,
		el("h3", {}, mail.subject),
		el("pre", { class: "body" }, mail.body),
		el("div", { class: "reply-slot" }),
	);
	article.querySelector(".reply-btn").addEventListener("click", (ev) => {
		ev.stopPropagation();
		const slot = article.querySelector(".reply-slot");
		if (slot.firstChild) {
			slot.replaceChildren();
			return;
		}
		slot.append(replyComposeForm(node, () => refresh()));
	});
	if (node.children.length > 0) {
		// oldest first within each level
		node.children.sort((a, b) => (a.mail.createdAt < b.mail.createdAt ? -1 : a.mail.createdAt > b.mail.createdAt ? 1 : a.mail.id < b.mail.id ? -1 : 1));
		const kids = el("div", { class: "children" });
		for (const child of node.children) {
			kids.append(renderThreadNode(child, depth + 1));
		}
		article.append(kids);
	}
	return article;
}

// compose/reply form: sends as user@<project> via POST /api/send (the
// web UI's only write capability)
function composeForm(to, subject, refs, onSent) {
	const form = el("form", { class: "compose" });
	const subj = el("input", { type: "text", placeholder: "subject", value: subject || "", required: "" });
	const body = el("textarea", { placeholder: "body", rows: "5", required: "" });
	const status = el("span", { class: "hint" });
	const send = el("button", { type: "submit" }, "send");
	const cancel = el("button", { type: "button" }, "cancel");
	form.append(subj, body, el("div", { class: "actions" }, send, cancel, status));
	cancel.addEventListener("click", () => form.remove());
	form.addEventListener("submit", async (ev) => {
		ev.preventDefault();
		send.disabled = true;
		status.textContent = "sending…";
		try {
			await api("/api/send", { to, subject: subj.value, body: body.value, refs });
			form.remove();
			onSent();
		} catch (err) {
			status.textContent = "";
			send.disabled = false;
			form.append(el("p", { class: "error" }, String(err.message || err)));
		}
	});
	return form;
}

function replyComposeForm(node, onSent) {
	const mail = node.mail;
	const to = mail.from.session + "@" + mail.from.project;
	const subject = /^Re: /u.test(mail.subject) ? mail.subject : "Re: " + mail.subject;
	const refs = [node.owner + "/" + mail.id];
	return composeForm(to, subject, refs, onSent);
}

// ------------------------------------------------- hash-driven navigation
//
// Every navigation writes the hash; hashchange -> applyParams does the
// actual state mutation and rendering. Back/forward replay old hashes.

function selectProject(project) {
	const p = hashParams();
	if (project) p.set("project", project);
	else p.delete("project");
	p.delete("session");
	p.delete("mail");
	writeHash(p);
}

function selectSession(address, mailId) {
	const p = hashParams();
	p.delete("project");
	if (mailId) {
		p.delete("session");
		p.set("mail", encRef(address + "/" + mailId));
	} else {
		p.delete("mail");
		p.set("session", encRef(address));
	}
	writeHash(p);
}

function selectMail(m) {
	const p = hashParams();
	p.delete("session");
	p.set("mail", encRef(state.selected + "/" + m.id));
	writeHash(p);
}

function closeMail() {
	const p = hashParams();
	p.delete("mail");
	p.set("session", state.selected);
	writeHash(p);
}

function projectOfOwner(owner) {
	const at = owner.indexOf("@");
	return at > 0 ? owner.slice(at + 1) : owner;
}

function applyParams() {
	const p = hashParams();
	let mailParam = null;
	let sessionParam = null;
	try {
		if (p.get("mail")) mailParam = decRef(p.get("mail"));
		if (p.get("session")) sessionParam = decRef(p.get("session"));
	} catch {
		mailParam = null; // malformed encoding: fall through to lower states
		sessionParam = null;
	}
	const projectParam = p.get("project");

	if (mailParam) {
		const slash = mailParam.lastIndexOf("/");
		if (slash > 0) {
			const owner = mailParam.slice(0, slash);
			const mailId = mailParam.slice(slash + 1);
			state.selectedProject = projectOfOwner(owner);
			state.selected = owner;
			state.selectedMail = null;
			state.mailbox = null;
			state.mailboxError = null;
			renderSidebar();
			renderContent();
			openThread(owner, mailId);
			return;
		}
	}
	if (sessionParam) {
		state.selectedProject = projectOfOwner(sessionParam);
		state.selected = sessionParam;
		state.selectedMail = null;
		state.mailbox = null;
		state.mailboxError = null;
		renderSidebar();
		renderContent();
		loadMailbox(null, false);
		return;
	}
	if (projectParam) {
		state.selectedProject = projectParam;
		state.selected = null;
		state.selectedMail = null;
		state.mailbox = null;
		state.mailboxError = null;
		renderSidebar();
		renderContent();
		return;
	}
	state.selectedProject = null;
	state.selected = null;
	state.selectedMail = null;
	state.mailbox = null;
	state.mailboxError = null;
	renderSidebar();
	renderContent();
}

// ------------------------------------------------------------------ actions

async function loadMailbox(cursor, append) {
	const target = state.selected; // capture for the stale check
	try {
		const query = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
		const mb = await api("/api/mailbox/" + target + query);
		if (state.selected !== target) return; // stale response
		if (append && state.mailbox) {
			state.mailbox.mails = state.mailbox.mails.concat(mb.mails);
			state.mailbox.nextCursor = mb.nextCursor;
		} else {
			state.mailbox = mb;
		}
	} catch (err) {
		if (state.selected !== target) return; // stale response
		state.mailboxError = String(err.message || err);
	}
	renderContent();
}

async function openThread(owner, mailId) {
	try {
		const detail = await api(`/api/thread/${owner}/${mailId}`);
		if (state.selected !== owner) return; // stale response
		state.selectedMail = detail;
	} catch (err) {
		if (state.selected !== owner) return; // stale response
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
	} catch (err) {
		document.getElementById("content").replaceChildren(
			el("p", { class: "error" }, String(err.message || err)));
		return;
	}
	applyParams();
}

window.addEventListener("hashchange", applyParams);
document.getElementById("refresh").addEventListener("click", refresh);
refresh();
