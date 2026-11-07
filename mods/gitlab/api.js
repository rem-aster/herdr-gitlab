// Everything that talks to git and GitLab. GitLab goes through glab (its login, its hosts):
// `glab api graphql` for reading, `glab api` (REST) for most actions.
// `ctx` is plain data, so popups and dialogs get it in their props:
// { host, path, root, on, remote, web, origin, me, main }.

import { exec, setShared, spaces, panes, run, home } from "herdr";
import { firstLine, nodes, restId, slug, parseRemote } from "./util.js";

const PIPELINE = `fragment pipeline on Pipeline {
  id iid status ref path createdAt startedAt duration
  detailedStatus { group }
  user { username } commit { shortId title }
  stages { nodes { name jobs { nodes { id name status allowFailure retried retryable webPath duration startedAt } } } }
}`;

const MR = `fragment mr on MergeRequest {
  id iid title state draft webUrl createdAt updatedAt sourceBranch targetBranch detailedMergeStatus userNotesCount
  sourceProjectId targetProjectId resolvableDiscussionsCount resolvedDiscussionsCount
  author { username } reviewers { nodes { username } } approvedBy { nodes { username } }
  userPermissions { canMerge canApprove updateMergeRequest createNote }
  diffStatsSummary { additions deletions fileCount }
}`;

export const LIST_QUERY = `query($path: ID!, $branch: String!) {
  currentUser { username todos(state: pending) { count } }
  project(fullPath: $path) {
    webUrl
    repository { rootRef }
    mergeRequests(state: opened, first: 20, sort: UPDATED_DESC) { count nodes { ...mr headPipeline { iid status detailedStatus { group } } } }
    branchMr: mergeRequests(sourceBranches: [$branch], first: 1, sort: CREATED_DESC) { nodes { ...mr headPipeline { ...pipeline } } }
    branchPipelines: pipelines(ref: $branch, first: 1) { nodes { ...pipeline } }
    pipelines(first: 12) { nodes { ...pipeline } }
    issues(state: opened, first: 15, sort: UPDATED_DESC) { count nodes { iid title description webUrl updatedAt author { username } assignees { nodes { username } } labels { nodes { title color } } } }
  }
}
${MR}
${PIPELINE}`;

const MR_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      ...mr description diffHeadSha commitCount squash forceRemoveSourceBranch autoMergeEnabled
      headPipeline { ...pipeline }
      diffStats { path additions deletions }
      discussions(first: 100) { nodes { id resolvable resolved notes { nodes { id body system createdAt url author { username } position { filePath newLine oldLine } } } } }
    }
  }
}
${MR}
${PIPELINE}`;

const project = (ctx) => `projects/${encodeURIComponent(ctx.path)}`;

async function glab(ctx, args) {
  const r = await exec("glab", args, { cwd: ctx.root, on: ctx.on }).catch(() => null);
  if (!r) throw new Error("glab isn't installed: https://gitlab.com/gitlab-org/cli");
  return r;
}

// GitLab's message: a string, { field: [reasons] }, a GraphQL error, or glab's own line.
function problem(r, body) {
  const m = body?.errors?.[0]?.message ?? body?.message ?? body?.error;
  if (typeof m === "string") return new Error(m);
  if (m && typeof m === "object") return new Error(Object.entries(m).map(([k, v]) => `${k} ${[].concat(v).join(", ")}`).join("; "));
  return new Error(firstLine(r.stderr || r.stdout) || `glab exited with ${r.code}`);
}

// Strings go as -f (raw), the rest as -F (typed: booleans, numbers).
const fieldArgs = (fields) => Object.entries(fields).filter(([, v]) => v !== undefined && v !== null)
  .flatMap(([k, v]) => [typeof v === "string" ? "-f" : "-F", `${k}=${v}`]);

export async function graphql(ctx, query, vars = {}) {
  const r = await glab(ctx, ["api", "graphql", "--hostname", ctx.host, "-f", `query=${query}`, ...fieldArgs(vars)]);
  let body = null;
  try { body = JSON.parse(r.stdout); } catch { body = null; }
  if (r.code !== 0 || !body?.data || body.errors?.length) throw problem(r, body);
  return body.data;
}

export async function rest(ctx, method, endpoint, fields = {}) {
  const r = await glab(ctx, ["api", "--hostname", ctx.host, "-X", method, endpoint, ...fieldArgs(fields)]);
  let body = null;
  try { body = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { body = null; }
  if (r.code !== 0) throw problem(r, body);
  return body;
}

// After an action anywhere (a popup, a dialog), every copy of the panel reloads.
export const bump = () => setShared("gitlab.bump", Date.now());

// The repo a folder belongs to and its GitLab project, from the git remote.
export async function locate({ cwd, on }) {
  const git = async (args, dir) => {
    const r = await exec("git", ["--no-optional-locks", ...args], { cwd: dir, on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim() };
  };
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return { error: "Not a git repository" };
  const root = top.out;
  let remote = "origin", url = await git(["remote", "get-url", "origin"], root);
  if (!url.ok) {
    remote = (await git(["remote"], root)).out.split("\n").filter(Boolean)[0];
    if (!remote) return { root, error: "This repository has no remote" };
    url = await git(["remote", "get-url", remote], root);
  }
  const repo = parseRemote(url.out);
  if (!repo) return { root, error: `Unrecognized remote: ${url.out}` };
  if (/(^|\.)github\.com$/.test(repo.host)) return { root, error: "A GitHub remote: this panel shows GitLab projects" };
  const branch = (await git(["branch", "--show-current"], root)).out;
  return { root, on, remote, host: repo.host, path: repo.path, branch };
}

export async function loadList(ctx, branch) {
  const data = await graphql(ctx, LIST_QUERY, { path: ctx.path, branch: branch ?? "" });
  const p = data.project;
  if (!p) return null;
  const branchMr = nodes(p.branchMr)[0] ?? null;
  return {
    web: p.webUrl,
    origin: /^(https?:\/\/[^/]+)/.exec(p.webUrl)?.[1] ?? `https://${ctx.host}`,
    main: p.repository?.rootRef ?? null,
    me: data.currentUser?.username ?? null,
    todos: data.currentUser?.todos?.count ?? 0,
    branchMr,
    branchPipeline: branchMr?.headPipeline ?? nodes(p.branchPipelines)[0] ?? null,
    mrs: nodes(p.mergeRequests), mrCount: p.mergeRequests?.count ?? 0,
    // A [skip ci] commit's pipeline is all noise.
    pipelines: nodes(p.pipelines).filter((x) => x.status !== "SKIPPED"),
    issues: nodes(p.issues), issueCount: p.issues?.count ?? 0,
  };
}

// One merge request with its threads, plus its diffs (REST: the first 100 files).
export async function loadMr(ctx, iid) {
  const [data, diffs] = await Promise.all([
    graphql(ctx, MR_QUERY, { path: ctx.path, iid: String(iid) }),
    rest(ctx, "GET", `${project(ctx)}/merge_requests/${iid}/diffs?per_page=100`).catch((e) => ({ error: e.message })),
  ]);
  const mr = data.project?.mergeRequest;
  if (!mr) throw new Error(`No merge request !${iid}`);
  return { mr, diffs: Array.isArray(diffs) ? diffs : [], diffError: diffs?.error ?? null };
}

// What the merge dialog needs: the MR as it is now and the project's merge settings.
export async function mergeInfo(ctx, iid) {
  const [data, settings] = await Promise.all([
    graphql(ctx, `query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) {
      iid title state draft sourceBranch targetBranch diffHeadSha detailedMergeStatus commitCount squash forceRemoveSourceBranch
      headPipeline { status } } } }`, { path: ctx.path, iid: String(iid) }),
    rest(ctx, "GET", project(ctx)),
  ]);
  const mr = data.project?.mergeRequest;
  if (!mr) throw new Error(`No merge request !${iid}`);
  return { mr, settings: settings ?? {} };
}

// ── actions ──────────────────────────────────────────────────────────────────

export const approve = (ctx, iid) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/approve`);
export const unapprove = (ctx, iid) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/unapprove`);
export const setState = (ctx, iid, event) => rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}`, { state_event: event });

// `sha`: merges only what was reviewed. `auto`: when the pipeline succeeds (both spellings:
// auto_merge since 17.11, merge_when_pipeline_succeeds before).
export const merge = (ctx, iid, { sha, squash, removeSource, auto }) =>
  rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}/merge`, {
    sha, squash, should_remove_source_branch: removeSource,
    ...(auto ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}),
  });

export async function setDraft(ctx, iid, draft) {
  const data = await graphql(ctx, `mutation($path: ID!, $iid: String!, $draft: Boolean!) {
    mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: $draft }) { errors } }`,
  { path: ctx.path, iid: String(iid), draft });
  const errors = data.mergeRequestSetDraft?.errors ?? [];
  if (errors.length) throw new Error(errors[0]);
}

export const comment = (ctx, iid, body) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/notes`, { body });
export const reply = (ctx, iid, discussion, body) => rest(ctx, "POST", `${project(ctx)}/merge_requests/${iid}/discussions/${restId(discussion)}/notes`, { body });
export const resolve = (ctx, iid, discussion, resolved) => rest(ctx, "PUT", `${project(ctx)}/merge_requests/${iid}/discussions/${restId(discussion)}`, { resolved });

export const retryJob = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/jobs/${restId(id)}/retry`);
export const retryPipeline = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/pipelines/${restId(id)}/retry`);
export const cancelPipeline = (ctx, id) => rest(ctx, "POST", `${project(ctx)}/pipelines/${restId(id)}/cancel`);

// Pushes the branch (a no-op when it's up to date), then opens the merge request.
export async function createMr(ctx, { branch, target, title, description, draft, removeSource }) {
  const push = await exec("git", ["push", "-u", ctx.remote, branch], { cwd: ctx.root, on: ctx.on });
  if (push.code !== 0) {
    const lines = String(push.stderr || push.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    throw new Error(lines.find((l) => /^(error|fatal|!)/.test(l)) ?? lines.at(-1) ?? "git push failed");
  }
  return rest(ctx, "POST", `${project(ctx)}/merge_requests`, {
    source_branch: branch, target_branch: target, title: draft ? `Draft: ${title}` : title,
    description: description || undefined, remove_source_branch: removeSource,
  });
}

// A title and description from the branch's commits, as GitLab would suggest.
export async function draftText(ctx, branch, target) {
  const r = await exec("git", ["log", "--format=%s%x1f%b%x1e", `${ctx.remote}/${target}..${branch}`], { cwd: ctx.root, on: ctx.on });
  const commits = r.code === 0 ? r.stdout.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => c.split("\x1f")) : [];
  if (commits.length === 1) return { title: commits[0][0], description: (commits[0][1] ?? "").trim(), count: 1 };
  return { title: commits.at(-1)?.[0] ?? branch, description: commits.map(([s]) => `- ${s}`).reverse().join("\n"), count: commits.length };
}

// ── worktrees ────────────────────────────────────────────────────────────────

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

export const spaceOnBranch = (branch) => spaces().find((s) => s.branch === branch) ?? null;

// `start` ({ argv, task }): an agent with its first message, in a new tab of the space.
function goTo(path, on, start) {
  const inside = (p) => Boolean(p) && (p === path || p.startsWith(`${path}/`));
  const s = spaces().find((x) => (x.machine ?? null) === (on ?? null) && inside(place(x)));
  if (!s) return run("space.new", { folder: path, ...(on ? { machine: on } : {}), ...(start ?? {}) });
  run("space.select", { id: s.id });
  if (start) run("tab.new", { space: s.id, folder: path, ...start });
}

// A branch as a space: its checkout if there is one, else a new worktree in
// ~/.herdr/worktrees/<repo>/<branch> (where Herdr's own worktree dialog puts them).
// No local branch: the remote's is tracked; `from.mr` fetches a fork's merge-request ref instead;
// `from.base` starts a new branch from <remote>/<base> when the remote doesn't have it either
// (untracked, so pull and push don't go to the base). `from.start`: an agent to start there.
async function checkout(ctx, branch, from = {}) {
  const git = async (args) => {
    const r = await exec("git", args, { cwd: ctx.root, on: ctx.on });
    return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: firstLine(r.stderr || r.stdout) };
  };
  const list = await git(["worktree", "list", "--porcelain"]);
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return goTo(path, ctx.on, from.start);
  }

  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error(common.err || "Not a git repository");
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const userHome = ctx.on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: ctx.on })).stdout.trim() : home();
  const path = `${userHome}/.herdr/worktrees/${main.split("/").pop()}/${slug(branch)}`;

  const local = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
  let add;
  if (from.mr) {
    const f = await git(["fetch", ctx.remote, `refs/merge-requests/${from.mr}/head:refs/heads/${branch}`]);
    if (!f.ok && !local) throw new Error(f.err || `Couldn't fetch !${from.mr}`);
    add = ["worktree", "add", path, branch];
  } else if (local) {
    await git(["fetch", ctx.remote, `${branch}:${branch}`]); // fast-forward only: a diverged branch stays
    add = ["worktree", "add", path, branch];
  } else {
    const f = await git(["fetch", ctx.remote, `+refs/heads/${branch}:refs/remotes/${ctx.remote}/${branch}`]);
    if (f.ok) add = ["worktree", "add", "--track", "-b", branch, path, `${ctx.remote}/${branch}`];
    else if (from.base) {
      const b = await git(["fetch", ctx.remote, `+refs/heads/${from.base}:refs/remotes/${ctx.remote}/${from.base}`]);
      if (!b.ok) throw new Error(b.err || `Couldn't fetch ${from.base}`);
      add = ["worktree", "add", "--no-track", "-b", branch, path, `${ctx.remote}/${from.base}`];
    } else throw new Error(f.err || `Couldn't fetch ${branch}`);
  }
  const r = await git(add);
  if (!r.ok) throw new Error(r.err || "git worktree add failed");
  // Unnamed, so the space follows the checkout and nests under its repo in the sidebar.
  run("space.new", { folder: path, ...(ctx.on ? { machine: ctx.on } : {}), ...(from.start ?? {}) });
}

// A merge request's branch; a fork's is checked out from its merge-request ref as mr-<iid>.
// `start`: an agent to start there (see checkout).
export function openWorktree(ctx, mr, start) {
  const fork = String(mr.sourceProjectId) !== String(mr.targetProjectId);
  return fork ? checkout(ctx, `mr-${mr.iid}`, { mr: mr.iid, start }) : checkout(ctx, mr.sourceBranch, { start });
}

// What a review task says about a merge request.
export async function mrBrief(ctx, iid) {
  const data = await graphql(ctx, `query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) {
    iid title description webUrl sourceBranch targetBranch } } }`, { path: ctx.path, iid: String(iid) });
  const mr = data.project?.mergeRequest;
  if (!mr) throw new Error(`No merge request !${iid}`);
  return mr;
}

// An issue's branch: the one named, else a new one from the default branch; `start` as above.
export const openIssueWorktree = (ctx, branch, base, start) => checkout(ctx, branch, { base, start });

// A branch already made for the issue ("<iid>-…"): a local one (latest first), else the remote's.
export async function findIssueBranch(ctx, iid) {
  const opts = { cwd: ctx.root, on: ctx.on };
  const local = await exec("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", `refs/heads/${iid}-*`], opts);
  const mine = local.code === 0 ? local.stdout.split("\n").filter(Boolean)[0] : null;
  if (mine) return mine;
  const remote = await exec("git", ["ls-remote", "--heads", ctx.remote, `refs/heads/${iid}-*`], opts);
  const ref = remote.code === 0 ? remote.stdout.split("\n").filter(Boolean)[0]?.split("\t")[1] : null;
  return ref ? ref.replace(/^refs\/heads\//, "") : null;
}

// The space on an issue's branch, if one is open.
export const spaceForIssue = (iid) => spaces().find((s) => s.branch?.startsWith(`${iid}-`)) ?? null;
