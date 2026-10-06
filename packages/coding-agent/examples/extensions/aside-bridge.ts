/**
 * Aside Bridge Extension
 *
 * File-based bridge between the Aside browser agent (or any local process) and live pi sessions.
 * The browser agent picks a session, drops a Markdown message into its inbox, and reads the reply
 * the coding agent writes to the outbox.
 *
 * Layout under ~/.pi/aside-bridge/:
 *   sessions/<sessionId>.json       one file per live session: sessionId, name, cwd, pid, startedAt
 *   inbox/<sessionId>/<msgId>.md    message to inject as a user message
 *   inbox/<sessionId>/done/         claimed messages
 *   outbox/<sessionId>/<msgId>.md   reply written by the agent
 *
 * Writers should create the message under another name (for example <msgId>.md.tmp) and rename it
 * to <msgId>.md, so a half-written file is never claimed.
 *
 * Usage:
 *   pi --extension examples/extensions/aside-bridge.ts
 *   ls ~/.pi/aside-bridge/sessions/
 *   echo "Summarize the failing tests" > /tmp/0001.md.tmp
 *   mv /tmp/0001.md.tmp ~/.pi/aside-bridge/inbox/<sessionId>/0001.md
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@at-inc/pi";

const ROOT = path.join(os.homedir(), ".pi", "aside-bridge");
const POLL_MS = 2000;

export default function (pi: ExtensionAPI) {
	let sessionId: string | undefined;
	let timer: NodeJS.Timeout | undefined;

	const registryFile = (id: string) => path.join(ROOT, "sessions", `${id}.json`);

	const poll = (ctx: ExtensionContext, id: string) => {
		const inbox = path.join(ROOT, "inbox", id);
		let names: string[];
		try {
			names = fs
				.readdirSync(inbox)
				.filter((name) => name.endsWith(".md"))
				.sort();
		} catch (error) {
			ctx.ui.notify(`aside-bridge: cannot read inbox: ${String(error)}`, "warning");
			return;
		}

		for (const name of names) {
			const claimed = path.join(inbox, "done", name);
			try {
				// rename is atomic, so concurrent pollers cannot deliver the same message twice
				fs.renameSync(path.join(inbox, name), claimed);
			} catch {
				continue;
			}
			const body = fs.readFileSync(claimed, "utf8");
			const msgId = name.slice(0, -".md".length);
			const replyPath = path.join(ROOT, "outbox", id, `${msgId}.md`);
			const text =
				`[Aside bridge message ${msgId}, relayed by the Aside browser agent]\n\n${body}\n\n` +
				`When done, write your full reply (Markdown) to ${replyPath} with the write tool, then continue as normal.`;
			pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			ctx.ui.notify(`aside-bridge: delivered ${msgId}`, "info");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// Print and JSON modes are one-shot runs; only interactive sessions accept relayed messages.
		if (!ctx.hasUI) return;
		const id = ctx.sessionManager.getSessionId();
		sessionId = id;
		fs.mkdirSync(path.join(ROOT, "inbox", id, "done"), { recursive: true });
		fs.mkdirSync(path.join(ROOT, "outbox", id), { recursive: true });
		fs.mkdirSync(path.join(ROOT, "sessions"), { recursive: true });
		const entry = {
			sessionId: id,
			name: pi.getSessionName() ?? null,
			cwd: ctx.cwd,
			pid: process.pid,
			startedAt: new Date().toISOString(),
		};
		fs.writeFileSync(registryFile(id), JSON.stringify(entry, null, 2));
		timer = setInterval(() => poll(ctx, id), POLL_MS);
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		timer = undefined;
		if (sessionId) fs.rmSync(registryFile(sessionId), { force: true });
		sessionId = undefined;
	});
}
