// Dialogs opened as copies of this mod (props { dialog: { kind, target, ctx } }):
// merge (with its options), close (a confirm), create (a new merge request), worktree (an
// issue's branch as a space, maybe with an agent on it), review (a merge request's branch as a
// space with an agent reviewing it).
// Enter confirms, Esc closes. Each runs its action itself, then the panel reloads.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, notify, theme, knownAgents, run } from "herdr";
import * as api from "./api.js";
import { ACTIVE, issueBranch, issueTask, mrTask } from "./util.js";
import { pill, toggle, mergeStatus } from "./ui.js";

const CAN_WAIT = new Set(["CI_STILL_RUNNING", "CI_MUST_PASS", "CHECKING", "UNCHECKED"]);

export class Dialog {
  constructor(spec, cx) {
    this.kind = spec.kind; this.target = spec.target; this.ctx = spec.ctx;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.busy = false; this.error = ""; this.ready = false;
    if (this.kind === "merge") this.loadMerge(cx);
    if (this.kind === "create") this.loadCreate(cx);
    if (this.kind === "worktree") this.loadWorktree(cx);
    if (this.kind === "review") this.loadReview(cx);
    if (this.kind === "close") this.ready = true;
  }

  close() { closeOverlay(props().overlay); }

  loadMerge(cx) {
    cx.spawn(async (cx) => {
      try {
        const { mr, settings } = await api.mergeInfo(this.ctx, this.target.iid);
        const squash = settings.squash_option;
        this.mr = mr;
        this.squashFixed = squash === "always" ? "required" : squash === "never" ? "off in this project" : null;
        this.squash = squash === "always" || squash === "default_on" || (squash !== "never" && Boolean(mr.squash));
        this.removeSource = mr.forceRemoveSourceBranch ?? settings.remove_source_branch_after_merge ?? true;
        this.auto = ACTIVE.has(mr.headPipeline?.status ?? "");
        this.ready = true;
      } catch (e) { this.error = e.message; }
      cx.notify();
    });
  }

  loadCreate(cx) {
    this.input = InputState.new({ placeholder: "Title" });
    this.input.on("submit", (_e, cx) => this.confirm(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.draft = false; this.removeSource = true;
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const text = await api.draftText(this.ctx, this.target.branch, this.target.into);
        this.description = text.description; this.commits = text.count;
        if (!this.input.value()) this.input.set_value(text.title);
      } catch (e) { this.error = e.message; }
      this.ready = true;
      cx.notify();
    });
  }

  // The issue's branch if there is one already, else "<iid>-<title>"; and the agents that can
  // start there with the issue as their task (the most picked first). With the issue's space
  // open already (target.space), only the agent: a new tab there.
  loadWorktree(cx) {
    this.input = InputState.new({ placeholder: "Branch", value: issueBranch(this.target.iid, this.target.title) });
    this.input.on("submit", (_e, cx) => this.confirm(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.withAgent = Boolean(this.target.withAgent || this.target.space);
    this.agents = [];
    if (!this.target.space) cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      const [found] = await Promise.all([
        this.target.space ? null : api.findIssueBranch(this.ctx, this.target.iid).catch(() => null),
        this.loadAgents(),
      ]);
      this.existing = found;
      if (found) this.input.set_value(found);
      this.ready = true;
      cx.notify();
    });
  }

  // The merge request as the task (with its description), and the agents.
  loadReview(cx) {
    this.withAgent = true;
    this.agents = [];
    cx.spawn(async (cx) => {
      try { [this.brief] = await Promise.all([api.mrBrief(this.ctx, this.target.iid), this.loadAgents()]); }
      catch (e) { this.error = e.message; }
      this.ready = Boolean(this.brief);
      cx.notify();
    });
  }

  // The agents installed where the repo is, the most picked first.
  async loadAgents() {
    const all = await knownAgents({ on: this.ctx.on }).catch(() => []);
    this.agents = all.filter((a) => a.installed);
    this.agent = this.agents[0]?.key ?? null;
  }

  // The chosen agent and its first message, or null.
  start() {
    const agent = this.withAgent ? this.agents.find((a) => a.key === this.agent) : null;
    if (!agent) return null;
    return { argv: agent.run, task: this.kind === "review" ? mrTask(this.brief, this.ctx.remote) : issueTask(this.target) };
  }

  canConfirm() {
    if (!this.ready || this.busy) return false;
    if (this.kind === "merge") {
      const s = this.mr?.detailedMergeStatus;
      return this.mr?.state === "opened" && (s === "MERGEABLE" || (this.auto && CAN_WAIT.has(s)));
    }
    if (this.kind === "create") return this.commits > 0 && Boolean(this.input?.value().trim());
    if (this.kind === "worktree") return (!this.withAgent || Boolean(this.start())) && (Boolean(this.target.space) || Boolean(this.input?.value().trim()));
    if (this.kind === "review") return Boolean(this.start());
    return true;
  }

  confirm(cx) {
    if (!this.canConfirm()) return;
    this.busy = true; this.error = "";
    cx.spawn(async (cx) => {
      try {
        const done = await this.act();
        api.bump();
        if (done) notify({ title: done, level: "success", timeout: 4000 });
        this.close();
      } catch (e) { this.error = e.message; this.busy = false; }
      cx.notify();
    });
    cx.notify();
  }

  // Does it; returns what the notification says.
  async act() {
    const { ctx, target } = this;
    if (this.kind === "close") { await api.setState(ctx, target.iid, "close"); return `Closed !${target.iid}`; }
    if (this.kind === "worktree") {
      if (target.space) {
        run("space.select", { id: target.space });
        run("tab.new", { space: target.space, ...this.start() });
      } else await api.openIssueWorktree(ctx, this.input.value().trim(), ctx.main ?? "main", this.start());
      return null;
    }
    if (this.kind === "review") { await api.openWorktree(ctx, target, this.start()); return null; }
    if (this.kind === "merge") {
      const r = await api.merge(ctx, target.iid, { sha: this.mr.diffHeadSha, squash: this.squash, removeSource: this.removeSource, auto: this.auto });
      return r?.state === "merged" ? `Merged !${target.iid}` : `!${target.iid} merges when the pipeline succeeds`;
    }
    const mr = await api.createMr(ctx, { branch: target.branch, target: target.into, title: this.input.value().trim(), description: this.description, draft: this.draft, removeSource: this.removeSource });
    return `Opened !${mr?.iid ?? ""}`;
  }

  frame(t, title, body, button, tone = "solid") {
    const p = props();
    return v_flex().id("gl-dialog").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.confirm(cx);
        else if (e.key === "escape") closeOverlay(p.overlay);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().flex_1().min_h(0).gap(8).children(body))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().justify_end().gap(8)
        .child(pill("gl-cancel", "Cancel", t, { onClick: () => this.close() }))
        .child(pill("gl-confirm", button, t, { tone, busy: this.busy, disabled: !this.canConfirm(), onClick: (cx) => this.confirm(cx) })));
  }

  render(cx) {
    const t = theme(), target = this.target;
    const muted = (text) => div().text_size(12.5).text_color(t.muted).child(text);
    if (this.kind === "close") {
      return this.frame(t, `Close !${target.iid}?`, [muted(target.title), muted("The merge request closes; its branch stays, and it can be reopened.")], "Close", "danger");
    }
    const field = () => h_flex().h(34).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(this.input).w_full().text_size(13).text_color(t.foreground));
    const chip = (a) => h_flex().id(`agent-${a.key}`).h(26).px(8).gap(6).items_center().rounded(7).text_size(12).cursor_pointer()
      .border_1().border_color(a.key === this.agent ? t.accent : t.border).bg(a.key === this.agent ? t.selected : t.background)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.agent = a.key; cx.notify(); })
      .when(Boolean(a.icon), (el) => el.child(a.tint ? svg(a.icon).size(13).flex_none().text_color(t.muted) : image(a.icon).size(13).flex_none()))
      .child(a.name);
    const picker = () => (this.withAgent && this.ready
      ? [this.agents.length ? h_flex().gap(6).flex_wrap().children(this.agents.slice(0, 5).map(chip)) : div().text_size(12).text_color(t.ansi3).child("No agent is installed here (programs.json: run).")]
      : []);
    if (this.kind === "review") {
      const there = api.spaceOnBranch(target.sourceBranch);
      return this.frame(t, `Review !${target.iid}`, [
        muted(target.title),
        div().text_size(11.5).text_color(t.dim).child(there
          ? `A new tab in the space on ${target.sourceBranch}, with the merge request as the agent's first message.`
          : `Checks out ${target.sourceBranch} as a new space and starts the agent there, with the merge request as its first message.`),
        ...picker(),
      ], "Start");
    }
    if (this.kind === "worktree") {
      const branch = this.input.value().trim(), existing = Boolean(this.existing) && branch === this.existing;
      const agentRows = this.target.space
        ? [muted("A new tab in the issue's space, with the issue as the agent's first message.")]
        : [toggle("gl-with-agent", "Start an agent with the issue as its task", this.withAgent, t, { onChange: (v, cx) => { this.withAgent = v; cx.notify(); } })];
      return this.frame(t, this.target.space ? `Agent for #${target.iid}` : `Worktree for #${target.iid}`, [
        muted(target.title),
        ...(this.target.space ? [] : [
          field(),
          div().text_size(11.5).text_color(t.dim).child(!this.ready ? "Looking for a branch for this issue…"
            : existing ? "The issue's branch: it is checked out as it is."
              : `A new branch from ${this.ctx.remote}/${this.ctx.main ?? "main"}. Named ${target.iid}-…, its merge request closes #${target.iid}.`),
        ]),
        ...agentRows,
        ...picker(),
      ], this.target.space ? "Start" : existing ? "Open" : "Create");
    }
    if (this.kind === "create") {
      return this.frame(t, "New merge request", [
        muted(`${target.branch} → ${target.into}${this.commits ? ` · ${this.commits} commit${this.commits === 1 ? "" : "s"}` : ""}`),
        field(),
        toggle("gl-draft", "Draft", this.draft, t, { onChange: (v, cx) => { this.draft = v; cx.notify(); } }),
        toggle("gl-remove", "Delete the branch when merged", this.removeSource, t, { onChange: (v, cx) => { this.removeSource = v; cx.notify(); } }),
        this.ready && !this.commits
          ? div().text_size(12).text_color(t.ansi3).child(`No commits ahead of ${target.into} yet.`)
          : div().text_size(11.5).text_color(t.dim).child(`Pushes ${target.branch} to ${this.ctx.remote} first; the description comes from its commits.`),
      ], "Create");
    }
    // merge
    const mr = this.mr;
    if (!mr) return this.frame(t, `Merge !${target.iid}`, [muted(this.error ? "" : "Loading…")], "Merge");
    const status = mergeStatus(mr, t);
    const waiting = CAN_WAIT.has(mr.detailedMergeStatus);
    return this.frame(t, `Merge !${target.iid}`, [
      muted(mr.title),
      h_flex().gap(6).text_size(12).child(div().text_color(t.dim).child(`${mr.sourceBranch} → ${mr.targetBranch} · ${mr.commitCount} commit${mr.commitCount === 1 ? "" : "s"} ·`)).child(div().text_color(status.color).child(status.label)),
      div().h(2),
      toggle("gl-remove", "Delete source branch", this.removeSource, t, { onChange: (v, cx) => { this.removeSource = v; cx.notify(); } }),
      toggle("gl-squash", "Squash commits", this.squash, t, { disabled: Boolean(this.squashFixed), hint: this.squashFixed, onChange: (v, cx) => { this.squash = v; cx.notify(); } }),
      ...(waiting || ACTIVE.has(mr.headPipeline?.status ?? "")
        ? [toggle("gl-auto", "Merge when the pipeline succeeds", this.auto, t, { onChange: (v, cx) => { this.auto = v; cx.notify(); } })]
        : []),
      ...(!this.canConfirm() && !this.busy && mr.detailedMergeStatus !== "MERGEABLE" && !(this.auto && waiting)
        ? [div().text_size(12).text_color(t.ansi3).child(`Can't merge now: ${status.label.toLowerCase()}.`)]
        : []),
    ], this.auto && (waiting || ACTIVE.has(mr.headPipeline?.status ?? "")) ? "Set to auto-merge" : "Merge");
  }
}
