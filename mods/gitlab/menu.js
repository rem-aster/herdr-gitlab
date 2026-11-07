// Right-click menus as data, and what their items do. A menu opens as a popup copy of this mod
// (props { menu: { items, target, ctx } }); the browser is only ever one of its items.
// Targets are plain data with what their actions need.

import { openOverlay, run, notify } from "herdr";
import * as api from "./api.js";
import { ACTIVE, restId } from "./util.js";
import { MOD } from "./ui.js";

// GitLab 18 logs: drop each line's "<timestamp> 00O[+] " prefix and the section markers.
const TRACE_SED = [
  String.raw`s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z [0-9a-f]{2}[OE]\+? ?//`,
  String.raw`/^(\x1b\[0K)*section_(start|end):[0-9]+:[^[:space:]]*\r?$/d`,
  String.raw`/^(\x1b\[0K)+\r?$/d`,
].join("\n");

// The job's log in a terminal below the focused pane; it stays until Enter.
// Without a sed that takes -u (macOS), the log goes through raw.
export function showLog(ctx, job) {
  const script = 'glab ci trace "$1" -R "$2" 2>&1 | { sed -uE "$4" 2>/dev/null || cat; }; printf "\\n\\033[2m— end of %s, Enter closes —\\033[0m" "$3"; read _';
  run("terminal.open", { argv: ["sh", "-c", script, "sh", restId(job.id), ctx.web, job.name, TRACE_SED], folder: ctx.root, place: "down", name: `log ${job.name}` });
}

const item = (id, label, icon, extra = {}) => ({ id, label, icon, ...extra });
const SEP = { sep: true };

// What a merge request's actions need.
export const mrTarget = (mr) => ({
  iid: mr.iid, title: mr.title, url: mr.webUrl, branch: mr.sourceBranch, sourceBranch: mr.sourceBranch,
  sourceProjectId: mr.sourceProjectId, targetProjectId: mr.targetProjectId,
});

export function mrItems(mr, ctx) {
  const open = mr.state === "opened", perm = mr.userPermissions ?? {};
  const approved = (mr.approvedBy?.nodes ?? []).some((u) => u.username === ctx.me);
  return [
    ...(open && perm.canApprove ? [approved ? item("unapprove", "Revoke approval", "x") : item("approve", "Approve", "check")] : []),
    ...(open && perm.canMerge ? [item("merge", "Merge…", "merged")] : []),
    ...(open && perm.updateMergeRequest ? [mr.draft ? item("ready", "Mark as ready", "draft") : item("draft", "Mark as draft", "draft")] : []),
    SEP,
    item("worktree", api.spaceOnBranch(mr.sourceBranch) ? "Go to worktree" : "Open worktree", "folder"),
    item("review", "Review with an agent…", "bot"),
    item("copy-branch", "Copy branch name", "copy"),
    item("copy-link", "Copy link", "link"),
    item("open", "Open in GitLab", "external"),
    ...(perm.updateMergeRequest && open ? [SEP, item("close", "Close merge request…", "x", { danger: true })] : []),
    ...(perm.updateMergeRequest && mr.state === "closed" ? [SEP, item("reopen", "Reopen", "reopen")] : []),
  ];
}

export function pipelineItems(p) {
  return [
    ...(p.status === "FAILED" || p.status === "CANCELED" ? [item("retry-pipeline", "Retry failed jobs", "retry")] : []),
    ...(ACTIVE.has(p.status) ? [item("cancel-pipeline", "Cancel pipeline", "stop", { danger: true })] : []),
    SEP,
    item("copy-link", "Copy link", "link"),
    item("open", "Open in GitLab", "external"),
  ];
}

export function jobItems(job) {
  return [
    item("log", "Show log", "terminal"),
    ...(job.retryable && (job.status === "FAILED" || job.status === "CANCELED") ? [item("retry-job", "Retry", "retry")] : []),
    SEP,
    item("copy-link", "Copy link", "link"),
    item("open", "Open in GitLab", "external"),
  ];
}

export const linkItems = () => [item("copy-link", "Copy link", "link"), item("open", "Open in GitLab", "external")];

// What an issue's actions need: the space already on its branch, if any.
export const issueTarget = (issue) => ({
  iid: issue.iid, title: issue.title, description: issue.description ?? "", url: issue.webUrl,
  space: api.spaceForIssue(issue.iid)?.id ?? null,
});

export function issueItems(target) {
  return [
    target.space ? item("goto", "Go to worktree", "folder") : item("worktree-issue", "Open worktree…", "folder"),
    item("agent-issue", target.space ? "Start an agent on it…" : "Open worktree with an agent…", "bot"),
    SEP,
    ...linkItems(),
  ];
}

export function threadItems(thread, canResolve) {
  return [
    ...(thread.resolvable && canResolve ? [thread.resolved ? item("unresolve", "Unresolve thread", "reopen") : item("resolve", "Resolve thread", "check")] : []),
    SEP,
    ...linkItems(),
  ];
}

export const fileItems = () => [item("copy-path", "Copy path", "copy"), item("open", "Open diff in GitLab", "external")];

export function projectItems(ctx) {
  return [
    item("open", "Open project in GitLab", "external", { url: ctx.web }),
    item("open", "Merge requests in GitLab", "merge-request", { url: `${ctx.web}/-/merge_requests` }),
    item("open", "Pipelines in GitLab", "pipeline", { url: `${ctx.web}/-/pipelines` }),
    item("open", "Issues in GitLab", "issue", { url: `${ctx.web}/-/issues` }),
    item("open", "To-Do list in GitLab", "todo", { url: `${ctx.origin}/dashboard/todos` }),
  ];
}

export function openMenu(items, target, ctx) {
  const clean = items.filter((x, i, all) => !(x.sep && (i === 0 || all[i - 1].sep || i === all.length - 1)));
  const rows = clean.filter((x) => !x.sep).length, seps = clean.length - rows;
  openOverlay({ mod: MOD, kind: "popup", width: 236, height: 12 + rows * 31 + seps * 9, props: { menu: { items: clean, target, ctx } } });
}

export function openDialog(kind, target, ctx) {
  const [width, height] = { merge: [440, 340], close: [400, 200], create: [480, 330], worktree: [480, 330], review: [460, 250] }[kind];
  openOverlay({ mod: MOD, kind: "dialog", width, height, props: { dialog: { kind, target, ctx } } });
}

const copied = (cx, text) => {
  cx.write_to_clipboard(text);
  notify({ title: "Copied", body: text, level: "info", timeout: 1500 });
};

// Slow items: run while the popup shows a spinner, then it closes and the panel reloads.
const ACTIONS = {
  approve: (ctx, t) => api.approve(ctx, t.iid),
  unapprove: (ctx, t) => api.unapprove(ctx, t.iid),
  ready: (ctx, t) => api.setDraft(ctx, t.iid, false),
  draft: (ctx, t) => api.setDraft(ctx, t.iid, true),
  reopen: (ctx, t) => api.setState(ctx, t.iid, "reopen"),
  worktree: (ctx, t) => api.openWorktree(ctx, t),
  "retry-job": (ctx, t) => api.retryJob(ctx, t.id),
  "retry-pipeline": (ctx, t) => api.retryPipeline(ctx, t.id),
  "cancel-pipeline": (ctx, t) => api.cancelPipeline(ctx, t.id),
  resolve: (ctx, t) => api.resolve(ctx, t.iid, t.discussion, true),
  unresolve: (ctx, t) => api.resolve(ctx, t.iid, t.discussion, false),
};

export const isSlow = (id) => id in ACTIONS;
export const work = (it, target, ctx) => ACTIONS[it.id](ctx, target);

// Runs a quick item: a link, a copy, a log, or a dialog.
export function choose(it, target, ctx, cx) {
  switch (it.id) {
    case "open": cx.open_url(it.url ?? target.url); break;
    case "copy-link": copied(cx, target.url); break;
    case "copy-branch": copied(cx, target.branch); break;
    case "copy-path": copied(cx, target.path); break;
    case "log": showLog(ctx, target); break;
    case "merge": case "close": case "create": case "review": openDialog(it.id, target, ctx); break;
    case "worktree-issue": openDialog("worktree", target, ctx); break;
    case "agent-issue": openDialog("worktree", { ...target, withAgent: true }, ctx); break;
    case "goto": run("space.select", { id: target.space }); break;
  }
}
