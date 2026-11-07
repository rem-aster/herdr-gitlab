// GitLab for the focused repo, through glab: this branch's merge request and pipeline, open
// merge requests, recent pipelines and issues; a merge request opens in the panel itself with
// approve, merge, worktree, threads, comments and its file diffs. Right-click anything for
// more, including the browser (which nothing else opens).
// Copies of this mod: the panel; a right-click menu (props.menu, menu.js); a dialog
// (props.dialog, dialogs.js). Lists come from one GraphQL query, polled faster while a pipeline
// runs and slower while the panel is hidden; a pipeline you started that finishes notifies.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, TextView } from "gpui-base";
import { spaces, panes, focused, theme, notify, layout, props, shared, closeOverlay, settings } from "herdr";
import * as api from "./api.js";
import { ACTIVE, ENDED, nodes, restId, refLabel, ago, took, diffRows, diffCounts } from "./util.js";
import { icon, BRAND, look, statusIcon, mergeStatus, mrColor, iconButton, pill } from "./ui.js";
import * as menu from "./menu.js";
import { Dialog } from "./dialogs.js";
import { demoState } from "./demo.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The focused pane's folder and branch, as the Files and Changes panels pick it.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on, branch: pane?.branch ?? space?.branch ?? null };
}

const repoKey = (s) => (s?.host ? `${s.host}/${s.path}` : null);
const AUTH = /401|unauth|token|not logged|auth login/i;
const FILE = { A: "ansi2", D: "ansi1", R: "ansi4", M: "blocked" };
const fileStatus = (f) => (f.new_file ? "A" : f.deleted_file ? "D" : f.renamed_file ? "R" : "M");

export default class GitLab extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.menu) { this.mode = "menu"; this.at = -1; this.handle = cx.focus_handle(); this.handle.focus(); return; }
    if (p.dialog) { this.mode = "dialog"; this.dialog = new Dialog(p.dialog, cx); return; }
    this.mode = "panel";
    this.cache = new Map(); // context → last state, so switching back shows it at once
    this.seen = new Map(); // pipeline id → last status, for "finished" notifications
    this.details = new Map(); // "<repo>!<iid>" → { mr, diffs, diffError, error, loading }
    this.expanded = new Set(); this.openThreads = new Set(); this.openIssues = new Set(); this.busy = new Set();
    this.more = new Set(); // sections showing all their rows, not the first five
    this.folded = new Set(this.stored("folded", []));
    this.view = null; // the lists; or { kind: "mr" | "diff", repo, iid, file }
    this.hovered = null; this.at = 0; this.bumped = shared("gitlab.bump");
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Comment…" });
    this.input.on("submit", (_e, cx) => this.post(cx));
    this.input.on("change", (_e, cx) => {
      const had = this.draft;
      this.draft = Boolean(this.input.value().trim());
      if (had !== this.draft) cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(5000, (cx) => {
      if (Date.now() - this.at >= this.interval()) this.refresh(cx);
    });
  }

  stored(name, fallback) {
    try { return JSON.parse(localStorage.getItem(name) ?? "null") ?? fallback; } catch { return fallback; }
  }

  // Shown unless it's the side panel's block and the panel is hidden or on another child.
  visible() {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body || !find(body, "gitlab")) return true;
    return !panel.hidden && body.active === "gitlab";
  }

  interval() {
    const open = this.view && this.details.get(this.detailKey(this.view.iid))?.mr?.headPipeline;
    const running = [this.state?.branchPipeline, open, ...(this.state?.pipelines ?? [])].some((p) => p && ACTIVE.has(p.status));
    return this.visible() ? (running ? 15000 : 60000) : running ? 60000 : 180000;
  }

  // What actions need, as plain data (popups and dialogs get it in their props).
  ctx() {
    const s = this.state;
    if (!s?.host) return null;
    return { host: s.host, path: s.path, root: s.root, on: s.on ?? null, remote: s.remote, web: s.web ?? `https://${s.host}/${s.path}`, origin: s.origin ?? `https://${s.host}`, me: s.me ?? null, main: s.main ?? null };
  }

  refresh(cx) {
    // props { demo: true }: made-up data for screenshots (demo.js).
    if (props()?.demo) { this.state = demoState(); this.context = JSON.stringify(location()); return; }
    const loc = location(), context = JSON.stringify(loc);
    if (context !== this.context) {
      this.context = context;
      this.state = this.cache.get(context) ?? null;
      this.hovered = null;
    }
    if (!loc.cwd) { this.state = { error: "No folder" }; return; }
    if (this.view) this.loadDetail(cx, this.view.iid);
    if (this.loading === context) { this.again = true; return; }
    this.loading = context;
    this.at = Date.now();
    cx.spawn(async (cx) => {
      const old = this.cache.get(context) ?? {};
      let state;
      try {
        const where = await api.locate(loc);
        if (where.error) state = { error: where.error };
        else {
          const base = { ...where, branch: loc.branch || where.branch };
          try {
            const list = await api.loadList(base, base.branch);
            state = list ? { ...base, ...list, error: null } : { ...base, error: `No project ${where.path} on ${where.host} (or no access)` };
          } catch (e) {
            const text = e.message;
            state = { ...old, ...base, error: AUTH.test(text) ? `${text.replace(/\.$/, "")}. Sign in: glab auth login --hostname ${where.host}` : text };
          }
        }
      } catch (e) { state = { ...old, error: e.message }; }
      this.cache.set(context, state);
      if (this.context === context) this.state = state;
      this.track(state);
      if (this.loading === context) this.loading = null;
      if (this.again) { this.again = false; this.refresh(cx); }
      cx.notify();
    });
  }

  detailKey(iid) { return `${repoKey(this.state)}!${iid}`; }

  loadDetail(cx, iid) {
    const ctx = this.ctx();
    if (!ctx || props()?.demo) return;
    const key = this.detailKey(iid), had = this.details.get(key) ?? {};
    if (had.loading) return;
    this.details.set(key, { ...had, loading: true });
    cx.spawn(async (cx) => {
      try { this.details.set(key, await api.loadMr(ctx, iid)); }
      catch (e) { this.details.set(key, { ...(this.details.get(key) ?? {}), loading: false, error: e.message }); }
      cx.notify();
    });
  }

  // A pipeline you started (or this branch's) that stops running posts a notification.
  track(state) {
    if (!state?.pipelines) return;
    for (const p of [...state.pipelines, state.branchPipeline].filter(Boolean)) {
      const before = this.seen.get(p.id);
      this.seen.set(p.id, p.status);
      const ended = ENDED[p.status];
      if (!before || !ACTIVE.has(before) || !ended) continue;
      if (p.user?.username !== state.me && p !== state.branchPipeline) continue;
      notify({ title: ended[0], body: `${refLabel(p)} · ${p.commit?.title ?? `#${p.iid}`}`, level: ended[1], timeout: 8000 });
    }
  }

  // ── navigation and actions ─────────────────────────────────────────────────

  showMr(iid, cx) {
    this.view = { kind: "mr", repo: repoKey(this.state), iid: String(iid) };
    this.replyTo = null;
    this.loadDetail(cx, iid);
    cx.notify();
  }

  showFile(path, cx) {
    this.view = { ...this.view, kind: "diff", file: path };
    cx.notify();
  }

  back(cx) {
    this.view = this.view?.kind === "diff" ? { ...this.view, kind: "mr", file: null } : null;
    this.replyTo = null;
    cx.notify();
  }

  // Runs an action from the panel: a spinner on its button, a notification if it fails.
  act(key, label, work, cx) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.spawn(async (cx) => {
      try { await work(); api.bump(); }
      catch (e) { notify({ title: `Couldn't ${label}`, body: e.message, level: "error" }); }
      this.busy.delete(key);
      cx.notify();
    });
    cx.notify();
  }

  post(cx) {
    const text = this.input.value().trim(), ctx = this.ctx(), iid = this.view?.iid, to = this.replyTo;
    if (!text || this.posting || !ctx || !iid) return;
    this.posting = true;
    cx.spawn(async (cx) => {
      try {
        if (to) await api.reply(ctx, iid, to.discussion, text);
        else await api.comment(ctx, iid, text);
        this.input.set_value(""); this.draft = false; this.replyTo = null;
        this.loadDetail(cx, iid);
      } catch (e) { notify({ title: "Couldn't post the comment", body: e.message, level: "error" }); }
      this.posting = false;
      cx.notify();
    });
    cx.notify();
  }

  // A right-click handler that opens a menu of `items()` about `target`.
  rightClick(items, target) {
    return (_e, cx) => {
      cx.stop_propagation();
      const ctx = this.ctx();
      if (ctx) menu.openMenu(items(ctx), target, ctx);
    };
  }

  hover(id, on, cx) {
    if (on) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    else return;
    cx.notify();
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    try { localStorage.setItem("folded", JSON.stringify([...this.folded])); } catch {}
    cx.notify();
  }

  // ── pieces ─────────────────────────────────────────────────────────────────

  section(id, label, count, t, lead) {
    const open = !this.folded.has(id);
    return h_flex().id(`sec-${id}`).h(30).pt(8).px(6).flex_none().gap(6).items_center().text_size(11).font_medium()
      .text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.fold(id, cx))
      .when(Boolean(lead), (el) => el.child(lead))
      .child(div().min_w(0).truncate().child(label))
      .when(count != null, (el) => el.child(div().flex_none().child(String(count))))
      .child(div().flex_1())
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).flex_none());
  }

  // A section's first five rows, and a row that shows the rest (or folds them again).
  firstFive(id, list, row, t) {
    const all = this.more.has(id), out = (all ? list : list.slice(0, 5)).flatMap(row);
    if (list.length > 5) out.push(div().id(`more-${id}`).px(8).py(5).flex_none().text_size(11.5).text_color(t.dim).cursor_pointer()
      .hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => { all ? this.more.delete(id) : this.more.add(id); cx.notify(); })
      .child(all ? "Show less" : `Show ${list.length - 5} more`));
    return out;
  }

  line(text, t, color) {
    return div().px(8).py(6).text_size(12).text_color(color ?? t.dim).child(text);
  }

  jobRow(job, t, key) {
    const ctx = this.ctx(), l = look(job.status, t, job), id = `${key}-job-${restId(job.id)}`, hovered = this.hovered === id;
    const quiet = job.status === "SKIPPED" || job.status === "CREATED" || job.status === "CANCELED";
    const retry = job.retryable && (job.status === "FAILED" || job.status === "CANCELED");
    const target = { ...job, url: `${ctx?.origin}${job.webPath}` };
    return h_flex().id(id).h(24).flex_none().pl(8).pr(4).gap(7).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_hover((on, cx) => this.hover(id, on, cx))
      .on_click(() => ctx && menu.showLog(ctx, job)).tooltip(`${job.name}: ${l.label}. Click for its log`)
      .on_mouse_down("right", this.rightClick(() => menu.jobItems(job), target))
      .child(statusIcon(l, 13))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(quiet ? t.dim : t.foreground).child(job.name))
      .when(!(hovered && retry), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(took(job))))
      .when(hovered && retry, (el) => el.child(iconButton(`${id}-retry`, "retry", "Retry",
        (cx) => this.act(`retry-${job.id}`, `retry ${job.name}`, () => api.retryJob(ctx, job.id), cx), t, 20)));
  }

  stages(p, t, key) {
    const out = [];
    for (const stage of nodes(p.stages)) {
      const jobs = nodes(stage.jobs).filter((j) => !j.retried).sort((a, b) => a.name.localeCompare(b.name));
      if (!jobs.length) continue;
      out.push(div().pl(8).pt(4).h(20).flex_none().text_size(10.5).text_color(t.dim).child(stage.name));
      for (const job of jobs) out.push(this.jobRow(job, t, key));
    }
    return out;
  }

  // A pipeline's header line and its jobs, for a card (this branch's, a merge request's).
  pipelineBlock(p, t, key) {
    const l = look(p.status, t, { group: p.detailedStatus?.group });
    return [
      h_flex().id(`${key}-pipeline`).h(26).px(4).gap(8).items_center().rounded(6)
        .on_mouse_down("right", this.rightClick(() => menu.pipelineItems(p), { id: p.id, url: `${this.ctx()?.origin}${p.path}` }))
        .child(statusIcon(l, 15))
        .child(div().flex_none().text_size(12).font_medium().child(`Pipeline #${p.iid}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(l.color).child(l.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child([took(p), ago(p.createdAt)].filter(Boolean).join(" · "))),
      v_flex().children(this.stages(p, t, key)),
    ];
  }

  mrMeta(mr, t, extra = []) {
    const ms = mergeStatus(mr, t), d = mr.diffStatsSummary;
    const threads = mr.resolvableDiscussionsCount ? `${mr.resolvedDiscussionsCount}/${mr.resolvableDiscussionsCount} threads` : null;
    return h_flex().gap(6).min_w(0).text_size(11).text_color(t.dim)
      .children(extra.map((x) => div().flex_none().child(x)))
      .child(div().flex_none().text_color(ms.color).child(ms.label))
      .when(Boolean(threads), (el) => el.child(div().flex_none().child(threads)))
      .when(Boolean(d), (el) => el.child(div().flex_none().text_color(t.ansi2).child(`+${d.additions}`)).child(div().flex_none().text_color(t.ansi1).child(`−${d.deletions}`)));
  }

  branchCard(s, t) {
    const mr = s.branchMr, p = s.branchPipeline;
    const card = v_flex().mx(2).mt(2).p(8).gap(6).rounded(8).border_1().border_color(t.border).bg(t.surface);
    if (mr) {
      card.child(h_flex().id("branch-mr").gap(8).items_start().p(4).rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => this.showMr(mr.iid, cx))
        .on_mouse_down("right", this.rightClick((ctx) => menu.mrItems(mr, ctx), menu.mrTarget(mr)))
        .child(svg(icon(mr.state === "merged" ? "merged" : "merge-request")).size(15).mt(1).flex_none().text_color(mrColor(mr, t)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(13).font_medium().text_color(t.foreground).child(mr.title))
          .child(this.mrMeta(mr, t, [`!${mr.iid}`]))));
    } else {
      const canCreate = Boolean(s.branch && s.main && s.branch !== s.main);
      card.child(h_flex().px(4).h(28).gap(8).items_center().text_size(12).text_color(t.dim)
        .child(div().flex_1().child(s.branch === s.main ? "Default branch" : "No merge request"))
        .when(canCreate, (el) => el.child(pill("mr-new", "Create MR", t, { icon: "plus",
          onClick: () => { const ctx = this.ctx(); if (ctx) menu.openDialog("create", { branch: s.branch, into: s.main }, ctx); } }))));
    }
    if (!p) return card.child(div().px(4).text_size(12).text_color(t.dim).child("No pipeline for this branch"));
    return card.child(div().h(1).bg(t.border)).children(this.pipelineBlock(p, t, "branch"));
  }

  mrRow(mr, s, t) {
    const pl = mr.headPipeline ? look(mr.headPipeline.status, t, { group: mr.headPipeline.detailedStatus?.group }) : null;
    const reviewing = s.me && nodes(mr.reviewers).some((r) => r.username === s.me);
    const there = api.spaceOnBranch(mr.sourceBranch);
    return h_flex().id(`mr-${mr.iid}`).py(5).px(6).gap(8).flex_none().items_start().rounded(7).cursor_pointer()
      .when(mr.sourceBranch === s.branch, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => this.showMr(mr.iid, cx))
      .on_mouse_down("right", this.rightClick((ctx) => menu.mrItems(mr, ctx), menu.mrTarget(mr)))
      .when(Boolean(pl), (el) => el.tooltip(`Pipeline ${pl.label}`))
      .child(pl ? statusIcon(pl, 14).mt(1) : svg(icon("merge-request")).size(14).mt(1).flex_none().text_color(t.dim))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).text_color(mr.draft ? t.muted : t.foreground).child(mr.title))
        .child(this.mrMeta(mr, t, [`!${mr.iid}`, mr.author?.username === s.me ? "you" : mr.author?.username, ago(mr.updatedAt)].filter(Boolean))
          .when(Boolean(reviewing), (el) => el.child(div().flex_none().text_color(t.accent).child("review")))))
      .when(Boolean(there), (el) => el.child(svg(icon("folder")).size(12).mt(2).flex_none().text_color(t.accent)));
  }

  pipelineRow(p, t) {
    const l = look(p.status, t, { group: p.detailedStatus?.group }), open = this.expanded.has(p.id), id = `pl-${restId(p.id)}`;
    const meta = [`#${p.iid}`, refLabel(p), p.commit?.shortId, took(p), ago(p.createdAt)].filter(Boolean).join(" · ");
    const row = h_flex().id(id).py(5).px(6).gap(8).flex_none().items_start().rounded(7).cursor_pointer()
      .when(open, (el) => el.bg(t.raised)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { open ? this.expanded.delete(p.id) : this.expanded.add(p.id); cx.notify(); })
      .on_mouse_down("right", this.rightClick(() => menu.pipelineItems(p), { id: p.id, url: `${this.ctx()?.origin}${p.path}` }))
      .tooltip(`Pipeline ${l.label}`)
      .child(statusIcon(l, 14).mt(1))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12.5).child(p.commit?.title ?? `Pipeline #${p.iid}`))
        .child(div().truncate().text_size(11).text_color(t.dim).child(meta)))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(11).mt(3).flex_none().text_color(t.dim));
    return open ? [row, v_flex().ml(14).pl(4).border_l(1).border_color(t.border).children(this.stages(p, t, id))] : [row];
  }

  issueRow(issue, s, t) {
    const who = nodes(issue.assignees).map((a) => (a.username === s.me ? "you" : a.username))[0] ?? issue.author?.username;
    const open = this.openIssues.has(issue.iid), target = menu.issueTarget(issue);
    const row = h_flex().id(`issue-${issue.iid}`).py(5).px(6).gap(8).flex_none().items_start().rounded(7).cursor_pointer()
      .when(open, (el) => el.bg(t.raised)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { open ? this.openIssues.delete(issue.iid) : this.openIssues.add(issue.iid); cx.notify(); })
      .on_mouse_down("right", this.rightClick(() => menu.issueItems(target), target))
      .child(svg(icon("issue")).size(14).mt(1).flex_none().text_color(t.ansi2))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().when(!open, (el) => el.truncate()).text_size(12.5).child(issue.title))
        .child(h_flex().gap(6).min_w(0).text_size(11).text_color(t.dim)
          .child(div().flex_none().child([`#${issue.iid}`, who, ago(issue.updatedAt)].filter(Boolean).join(" · ")))
          .children(nodes(issue.labels).slice(0, 3).map((lb) => div().flex_none().max_w(110).truncate().text_color(lb.color || t.muted).child(lb.title)))))
      .when(Boolean(target.space), (el) => el.child(svg(icon("folder")).size(12).mt(2).flex_none().text_color(t.accent)));
    if (!open) return [row];
    const go = { id: target.space ? "goto" : "worktree-issue" };
    return [row, v_flex().ml(28).mr(6).mb(8).gap(8)
      .child(div().text_size(12.5).text_color(issue.description?.trim() ? t.foreground : t.dim)
        .child(issue.description?.trim() ? TextView.markdown(`md-issue-${issue.iid}`, issue.description).selectable(true) : "No description"))
      .child(h_flex().gap(6)
        .child(pill(`issue-wt-${issue.iid}`, target.space ? "Go to worktree" : "Worktree…", t, { icon: "folder",
          tip: target.space ? "Go to the space on this issue's branch" : "Check out a branch for this issue as a new space",
          onClick: (cx) => { const ctx = this.ctx(); if (ctx) menu.choose(go, target, ctx, cx); } }))
        .child(pill(`issue-agent-${issue.iid}`, target.space ? "Start an agent…" : "With an agent…", t, { icon: "bot",
          tip: "An agent with the issue as its task, in the issue's worktree",
          onClick: (cx) => { const ctx = this.ctx(); if (ctx) menu.choose({ id: "agent-issue" }, target, ctx, cx); } })))];
  }

  // ── views ──────────────────────────────────────────────────────────────────

  refreshButton(t) {
    return div().id("gl-refresh").size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
      .on_click((_e, cx) => { this.refresh(cx); cx.notify(); })
      .child(this.loading ? svg(icon("running")).size(13).spin(900) : svg(icon("refresh")).size(14));
  }

  listHeader(s, t) {
    const ready = Boolean(s?.mrs), projectMenu = this.rightClick((ctx) => menu.projectItems(ctx), {});
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(icon("gitlab")).size(15).flex_none().text_color(BRAND))
      .child(div().id("gl-project").flex_1().min_w(0).truncate().font_semibold()
        .when(Boolean(s?.host), (el) => el.cursor_pointer().hover((st) => st.text_color(t.accent)).tooltip("Project links")
          .on_click(projectMenu).on_mouse_down("right", projectMenu))
        .child(s?.path ?? (this.loading ? "Loading…" : "GitLab")))
      .when(ready && s.todos > 0, (el) => el.child(h_flex().id("gl-todos").h(22).px(6).gap(4).items_center().rounded(6).text_size(11)
        .text_color(t.accent).cursor_pointer().hover((st) => st.bg(t.hover)).tooltip("Your GitLab to-do list")
        .on_click(projectMenu)
        .child(svg(icon("todo")).size(12)).child(String(s.todos))))
      .child(this.refreshButton(t));
  }

  renderList(t) {
    const s = this.state, rows = [];
    if (!s?.mrs) {
      rows.push(this.line(s?.error ?? (this.loading || !s ? "Loading…" : "Nothing to show"), t, s?.error ? t.muted : t.dim));
    } else {
      if (s.error) rows.push(this.line(s.error, t, t.ansi1));
      rows.push(this.section("branch", s.branch || "Detached HEAD", null, t, svg(icon("branch")).size(11).flex_none()));
      if (!this.folded.has("branch")) rows.push(this.branchCard(s, t));
      rows.push(this.section("mrs", "Merge requests", s.mrCount, t));
      if (!this.folded.has("mrs")) rows.push(...(s.mrs.length ? s.mrs.map((m) => this.mrRow(m, s, t)) : [this.line("No open merge requests", t)]));
      rows.push(this.section("issues", "Issues", s.issueCount, t));
      if (!this.folded.has("issues")) rows.push(...(s.issues.length ? this.firstFive("issues", s.issues, (i) => this.issueRow(i, s, t), t) : [this.line("No open issues", t)]));
      rows.push(this.section("pipelines", "Pipelines", null, t));
      if (!this.folded.has("pipelines")) rows.push(...(s.pipelines.length ? this.firstFive("pipelines", s.pipelines, (p) => this.pipelineRow(p, t), t) : [this.line("No pipelines yet", t)]));
    }
    return [this.listHeader(s, t), v_flex().id("gl-list").flex_1().min_h(0).px(6).pb(10).overflow_y_scrollbar().children(rows)];
  }

  detailHeader(t, title, extra) {
    return h_flex().h(42).flex_none().pl(8).pr(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(iconButton("gl-back", "back", "Back (Esc)", (cx) => this.back(cx), t, 26))
      .child(title)
      .child(this.refreshButton(t))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  threadCard(th, mr, t) {
    const notes = nodes(th.notes).filter((n) => !n.system);
    if (!notes.length) return null;
    const [first, ...replies] = notes, id = restId(th.id), open = this.openThreads.has(th.id);
    const collapsed = th.resolved && !open;
    const pos = first.position, where = pos?.filePath ? `${pos.filePath.split("/").pop()}:${pos.newLine ?? pos.oldLine ?? ""}` : null;
    const me = this.state?.me, canResolve = Boolean(mr.userPermissions?.updateMergeRequest || mr.author?.username === me);
    const toggleOpen = (_e, cx) => { open ? this.openThreads.delete(th.id) : this.openThreads.add(th.id); cx.notify(); };
    const note = (n, nested) => v_flex().gap(3).when(nested, (el) => el.pl(10).border_l(2).border_color(t.border))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim).child(div().font_medium().text_color(t.foreground).child(n.author?.username ?? "")).child(ago(n.createdAt)))
      .child(div().text_size(12.5).text_color(t.foreground).child(TextView.markdown(`md-note-${restId(n.id)}`, n.body ?? "").selectable(true)));
    const link = (key, label, onClick) => div().id(`${key}-${id}`).text_color(t.dim).cursor_pointer().hover((st) => st.text_color(t.foreground)).on_click(onClick).child(label);
    return v_flex().id(`th-${id}`).flex_none().p(8).gap(6).rounded(8).border_1()
      .border_color(th.resolvable && !th.resolved ? `${t.ansi3}66` : t.border).bg(t.surface)
      .on_mouse_down("right", this.rightClick(() => menu.threadItems(th, canResolve), { url: first.url, iid: mr.iid, discussion: th.id }))
      .when(collapsed, (el) => el.cursor_pointer().on_click(toggleOpen)
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .child(svg(icon("check")).size(12).flex_none().text_color(t.ansi2))
          .child(div().flex_none().child(first.author?.username ?? ""))
          .child(div().flex_1().min_w(0).truncate().child(where ? `${where} · ${first.body}` : first.body))))
      .when(!collapsed, (el) => el
        .when(Boolean(where), (el) => el.child(h_flex().id(`where-${id}`).gap(5).items_center().text_size(11).text_color(t.dim).cursor_pointer()
          .hover((st) => st.text_color(t.foreground)).tooltip(pos.filePath).on_click((_e, cx) => this.showFile(pos.filePath, cx))
          .child(svg(icon("file")).size(11).flex_none()).child(div().min_w(0).truncate().child(where))))
        .child(note(first, false))
        .when(open || replies.length <= 2, (el) => el.children(replies.map((n) => note(n, true))))
        .child(h_flex().gap(12).text_size(11.5)
          .child(link("reply", "Reply", (_e, cx) => { this.replyTo = { discussion: th.id, author: first.author?.username }; this.input.focus(); cx.notify(); }))
          .when(th.resolvable && canResolve, (el) => el.child(this.busy.has(`resolve-${th.id}`) ? div().text_color(t.dim).child("…")
            : link("resolve", th.resolved ? "Unresolve" : "Resolve", (_e, cx) => this.act(`resolve-${th.id}`, "resolve the thread", () => api.resolve(this.ctx(), mr.iid, th.id, !th.resolved), cx))))
          .when(replies.length > 2 && !open, (el) => el.child(link("more", `${replies.length} replies`, toggleOpen)))
          .when(th.resolved && open, (el) => el.child(link("fold", "Collapse", toggleOpen)))));
  }

  fileRow(f, i, mr, stats, t) {
    const st = fileStatus(f), c = stats.get(f.new_path), counts = c ? { add: c.additions, del: c.deletions } : (f._c ??= diffCounts(f.diff));
    const parts = f.new_path.split("/"), name = parts.pop();
    return h_flex().id(`file-${i}`).h(26).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.showFile(f.new_path, cx))
      .on_mouse_down("right", this.rightClick(() => menu.fileItems(), { path: f.new_path, url: `${mr.webUrl}/diffs` }))
      .tooltip(f.renamed_file ? `${f.old_path} → ${f.new_path}` : f.new_path)
      .child(div().w(12).flex_none().text_size(11).text_color(t[FILE[st]]).child(st))
      .child(h_flex().flex_1().min_w(0).text_size(12)
        .child(div().text_color(t.dim).truncate().child(parts.length ? `${parts.join("/")}/` : ""))
        .child(div().flex_none().max_w(220).truncate().child(name)))
      .when(counts.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${counts.add}`)))
      .when(counts.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${counts.del}`)));
  }

  renderMr(t) {
    const s = this.state, ctx = this.ctx(), d = this.details.get(this.detailKey(this.view.iid)), mr = d?.mr;
    const title = h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(div().flex_none().font_semibold().child(`!${this.view.iid}`))
      .when(Boolean(mr), (el) => el.child(div().flex_none().text_size(11).text_color(mrColor(mr, t)).child(mr.draft && mr.state === "opened" ? "draft" : mr.state)));
    const more = mr && ctx ? iconButton("gl-more", "more", "More", () => menu.openMenu(menu.mrItems(mr, ctx), menu.mrTarget(mr), ctx), t, 24) : null;
    const header = this.detailHeader(t, title, more);
    if (!mr) return [header, this.line(d?.error ?? "Loading…", t, d?.error ? t.ansi1 : t.dim)];

    const open = mr.state === "opened", perm = mr.userPermissions ?? {};
    const approvers = nodes(mr.approvedBy).map((u) => u.username), approved = approvers.includes(s?.me);
    const there = api.spaceOnBranch(mr.sourceBranch), ms = mergeStatus(mr, t), sum = mr.diffStatsSummary;
    const stats = new Map((mr.diffStats ?? []).map((x) => [x.path, x]));
    const threads = nodes(mr.discussions).filter((x) => nodes(x.notes).some((n) => !n.system));
    const unresolved = threads.filter((x) => x.resolvable && !x.resolved).length;

    const actions = h_flex().gap(6).flex_wrap()
      .when(open && perm.canApprove, (el) => el.child(approved
        ? pill("gl-unapprove", "Revoke approval", t, { icon: "x", busy: this.busy.has("approve"), onClick: (cx) => this.act("approve", "revoke the approval", () => api.unapprove(ctx, mr.iid), cx) })
        : pill("gl-approve", "Approve", t, { icon: "check", busy: this.busy.has("approve"), onClick: (cx) => this.act("approve", "approve", () => api.approve(ctx, mr.iid), cx) })))
      .when(open && perm.canMerge, (el) => el.child(pill("gl-merge", "Merge…", t, { icon: "merged", tone: mr.detailedMergeStatus === "MERGEABLE" ? "solid" : "plain",
        onClick: () => menu.openDialog("merge", menu.mrTarget(mr), ctx) })))
      .child(pill("gl-worktree", there ? "Go to worktree" : "Worktree", t, { icon: "folder", busy: this.busy.has("worktree"),
        tip: there ? `Go to the space on ${mr.sourceBranch}` : `Check out ${mr.sourceBranch} as a new space`,
        onClick: (cx) => this.act("worktree", "open the worktree", () => api.openWorktree(ctx, menu.mrTarget(mr)), cx) }))
      .child(pill("gl-review", "Review with agent…", t, { icon: "bot", tip: "An agent reviewing it, in its worktree",
        onClick: () => menu.openDialog("review", menu.mrTarget(mr), ctx) }));

    const rows = [
      div().text_size(14).font_semibold().child(mr.title),
      h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(svg(icon("branch")).size(11).flex_none())
        .child(div().min_w(0).truncate().child(`${mr.sourceBranch} → ${mr.targetBranch}`))
        .child(div().flex_none().child(`· ${mr.author?.username === s?.me ? "you" : mr.author?.username ?? ""} · ${ago(mr.createdAt)}`)),
      h_flex().gap(8).flex_wrap().text_size(11.5)
        .child(div().text_color(ms.color).child(ms.label))
        .child(div().text_color(approvers.length ? t.ansi2 : t.dim).child(approvers.length ? `Approved by ${approvers.map((u) => (u === s?.me ? "you" : u)).join(", ")}` : "No approvals"))
        .when(Boolean(sum), (el) => el.child(div().text_color(t.dim).child(`${sum.fileCount} files`)).child(div().text_color(t.ansi2).child(`+${sum.additions}`)).child(div().text_color(t.ansi1).child(`−${sum.deletions}`))),
      actions,
    ];
    if (mr.headPipeline) rows.push(v_flex().p(8).gap(4).rounded(8).border_1().border_color(t.border).bg(t.surface).children(this.pipelineBlock(mr.headPipeline, t, `mr${mr.iid}`)));

    rows.push(this.section("description", "Description", null, t));
    if (!this.folded.has("description")) rows.push(div().px(6).text_size(12.5).text_color(mr.description?.trim() ? t.foreground : t.dim)
      .child(mr.description?.trim() ? TextView.markdown(`md-mr-${mr.iid}`, mr.description).selectable(true) : "No description"));

    rows.push(this.section("threads", unresolved ? `Threads · ${unresolved} open` : "Threads", threads.length, t));
    if (!this.folded.has("threads")) rows.push(...(threads.length ? threads.map((x) => this.threadCard(x, mr, t)).filter(Boolean) : [this.line("No comments yet", t)]));

    rows.push(this.section("files", "Changes", d.diffs.length, t));
    if (!this.folded.has("files")) {
      if (d.diffError) rows.push(this.line(d.diffError, t, t.ansi1));
      rows.push(...d.diffs.map((f, i) => this.fileRow(f, i, mr, stats, t)));
      if (d.diffs.length >= 100) rows.push(this.line("Showing the first 100 files", t));
    }

    const body = v_flex().id("gl-mr").flex_1().min_h(0).px(10).pt(10).pb(12).gap(8).overflow_y_scrollbar()
      .on_mouse_down("right", this.rightClick((ctx) => menu.mrItems(mr, ctx), menu.mrTarget(mr)))
      .children(rows);
    return perm.createNote ? [header, body, this.commentBox(t)] : [header, body];
  }

  commentBox(t) {
    return v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
      .when(Boolean(this.replyTo), (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(svg(icon("reply")).size(12).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(`Reply to ${this.replyTo.author ?? "the thread"}`))
        .child(iconButton("gl-reply-cancel", "x", "Cancel the reply", (cx) => { this.replyTo = null; cx.notify(); }, t, 18))))
      .child(h_flex().gap(8).items_center()
        .child(div().id("gl-comment").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1()
          .border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).w_full().h_full().text_size(12.5).text_color(t.foreground)))
        .child(pill("gl-send", "", t, { icon: "send", tone: this.draft ? "solid" : "plain", disabled: !this.draft, busy: this.posting, tip: "Send (Enter)", onClick: (cx) => this.post(cx) })));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(`${t.ansi2}18`)).when(kind === "-", (e) => e.bg(`${t.ansi1}18`))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderDiff(t) {
    const d = this.details.get(this.detailKey(this.view.iid)), diffs = d?.diffs ?? [];
    const index = diffs.findIndex((x) => x.new_path === this.view.file || x.old_path === this.view.file), f = diffs[index];
    const parts = (this.view.file ?? "").split("/"), name = parts.pop();
    const c = f ? (f._c ??= diffCounts(f.diff)) : null;
    const title = h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12.5)
      .child(div().flex_none().max_w(200).truncate().font_semibold().child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
      .when(c?.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${c.add}`)))
      .when(c?.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${c.del}`)));
    const header = this.detailHeader(t, title, null);
    if (!f) return [header, this.line(!d || d.loading ? "Loading…" : "This file isn't in the diff", t)];
    if (!f.diff) return [header, this.line(f.too_large || f.collapsed ? "Too large to show here: right-click to open it in GitLab" : "No text changes (binary, or a mode change)", t)];
    f._rows ??= diffRows(f.diff);
    f._width ??= Math.max(300, ...f.diff.split("\n").slice(0, 4000).map((l) => l.length * 7 + 60));
    const rows = f._rows, list = `gl-diff-${index}`;
    return [header,
      div().id("gl-diff-area").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .on_mouse_down("right", this.rightClick(() => menu.fileItems(), { path: f.new_path, url: `${d.mr.webUrl}/diffs` }))
        .child(div().id("gl-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(f._width).h_full().child(v_virtual_list(list, rows.length, 20, (i) => String(i),
            (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical(list).viewport_from_layout().absolute().inset_0())];
  }

  // ── menus (popup copies) ───────────────────────────────────────────────────

  pick(it, cx) {
    if (this.working) return;
    const { target, ctx } = props().menu;
    if (!menu.isSlow(it.id)) {
      closeOverlay(props().overlay);
      menu.choose(it, target, ctx, cx);
      return;
    }
    // A slow one runs here, under a spinner, then the popup closes and the panel reloads.
    this.working = it;
    cx.spawn(async () => {
      try { await menu.work(it, target, ctx); api.bump(); }
      catch (e) { notify({ title: `Couldn't ${it.label.replace(/…$/, "").toLowerCase()}`, body: e.message, level: "error" }); }
      closeOverlay(props().overlay);
    });
    cx.notify();
  }

  renderMenu() {
    const t = theme(), items = props().menu.items;
    const choices = items.map((it, i) => (it.sep ? -1 : i)).filter((i) => i >= 0);
    const step = (dir) => {
      const at = choices.indexOf(this.at);
      this.at = at < 0 ? choices[dir > 0 ? 0 : choices.length - 1] : choices[(at + dir + choices.length) % choices.length];
    };
    return v_flex().id("gl-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") step(1);
        else if (e.key === "up") step(-1);
        else if (e.key === "enter" && items[this.at]) this.pick(items[this.at], cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(items.map((it, i) => (it.sep ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`mi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .text_color(it.danger ? t.ansi1 : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(it, cx))
          .child(this.working === it ? svg(icon("running")).size(14).flex_none().spin(900).text_color(t.muted)
            : svg(icon(it.icon)).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it.label)))));
  }

  // ── render ─────────────────────────────────────────────────────────────────

  render(cx) {
    if (this.mode === "menu") return this.renderMenu(cx);
    if (this.mode === "dialog") return this.dialog.render(cx);

    const bumped = shared("gitlab.bump");
    if (bumped !== this.bumped) { this.bumped = bumped; this.refresh(cx); }
    else if (JSON.stringify(location()) !== this.context) this.refresh(cx);
    // Opening the panel brings it up to date.
    const shown = this.visible();
    if (shown && !this.shown && Date.now() - this.at > 15000) this.refresh(cx);
    this.shown = shown;
    // Another repo in focus: its lists, not the other repo's merge request.
    if (this.view && this.state?.host && this.view.repo !== repoKey(this.state)) this.view = null;

    const t = theme();
    const parts = !this.view ? this.renderList(t) : this.view.kind === "diff" ? this.renderDiff(t) : this.renderMr(t);
    return v_flex().id("gitlab").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.typing) this.handle.focus();
        else if (this.view) this.back(cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(parts);
  }
}
