// Shared drawing: status icons and colors, buttons.

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

// This mod's folder name: its icons and its popup and dialog copies go by it.
export const MOD = "gitlab";
export const icon = (name) => `mods/${MOD}/icons/${name}.svg`;
export const BRAND = "#fc6d26";

const MERGE = {
  MERGEABLE: ["Ready to merge", "ansi2"],
  CONFLICT: ["Conflicts", "ansi1"],
  NEED_REBASE: ["Needs rebase", "ansi3"],
  CI_MUST_PASS: ["Pipeline must pass", "ansi3"],
  CI_STILL_RUNNING: ["Pipeline running", "working"],
  DISCUSSIONS_NOT_RESOLVED: ["Open threads", "ansi3"],
  DRAFT_STATUS: ["Draft", "dim"],
  NOT_APPROVED: ["Needs approval", "ansi3"],
  REQUESTED_CHANGES: ["Changes requested", "ansi1"],
  BLOCKED_STATUS: ["Blocked", "ansi1"],
  NOT_OPEN: ["Closed", "dim"],
  CHECKING: ["Checking", "dim"],
  UNCHECKED: ["Checking", "dim"],
  PREPARING: ["Preparing", "dim"],
};

export function look(status, t, { allowFailure, group } = {}) {
  if (group === "success-with-warnings") return { icon: "warning", color: t.ansi3, label: "passed with warnings" };
  switch (status) {
    case "SUCCESS": return { icon: "success", color: t.ansi2, label: "passed" };
    case "FAILED": return allowFailure ? { icon: "warning", color: t.ansi3, label: "failed, allowed" } : { icon: "failed", color: t.ansi1, label: "failed" };
    case "RUNNING": return { icon: "running", color: t.working, label: "running", spin: true };
    case "CANCELING": return { icon: "running", color: t.dim, label: "canceling", spin: true };
    case "PENDING": case "PREPARING": case "WAITING_FOR_RESOURCE": case "WAITING_FOR_CALLBACK":
      return { icon: "pending", color: t.ansi3, label: "pending" };
    case "SCHEDULED": return { icon: "scheduled", color: t.muted, label: "scheduled" };
    case "MANUAL": return { icon: "manual", color: t.muted, label: "manual" };
    case "SKIPPED": return { icon: "skipped", color: t.dim, label: "skipped" };
    case "CANCELED": return { icon: "canceled", color: t.dim, label: "canceled" };
    default: return { icon: "created", color: t.dim, label: String(status ?? "created").toLowerCase() };
  }
}

export const statusIcon = (l, size) => {
  const el = svg(icon(l.icon)).size(size).flex_none().text_color(l.color);
  return l.spin ? el.spin(900) : el;
};

export function mergeStatus(mr, t) {
  if (mr.state === "merged") return { label: "Merged", color: t.ansi5 };
  if (mr.state === "closed") return { label: "Closed", color: t.ansi1 };
  const known = MERGE[mr.detailedMergeStatus];
  if (known) return { label: known[0], color: t[known[1]] };
  const word = String(mr.detailedMergeStatus ?? "").toLowerCase().replaceAll("_", " ");
  return { label: word.charAt(0).toUpperCase() + word.slice(1), color: t.dim };
}

export const mrColor = (mr, t) => (mr.state === "merged" ? t.ansi5 : mr.state === "closed" ? t.ansi1 : t.ansi2);

const stop = (_e, cx) => cx.stop_propagation();

// A square icon button. `action(cx)` gets the click's context.
export function iconButton(id, name, tip, action, t, size = 22) {
  return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
    .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", stop)
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(svg(icon(name)).size(14));
}

// A labeled button: tone "solid" (the main action), "plain", or "danger".
export function pill(id, label, t, { icon: name, tone = "plain", disabled = false, busy = false, tip, onClick } = {}) {
  const solid = tone === "solid" && !disabled;
  const fg = disabled ? t.dim : solid ? t.solid_foreground : tone === "danger" ? t.ansi1 : t.foreground;
  return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().rounded(7).text_size(12)
    .border_1().border_color(solid ? t.solid : t.border).bg(solid ? t.solid : t.background).text_color(fg)
    .when(!disabled && !busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick?.(cx); }))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(busy, (el) => el.child(svg(icon("running")).size(12).flex_none().spin(900)))
    .when(!busy && Boolean(name), (el) => el.child(svg(icon(name)).size(13).flex_none()))
    .when(Boolean(label), (el) => el.child(label));
}

// A checkbox row drawn by hand (gpui-base's Checkbox is unstyled).
export function toggle(id, label, on, t, { disabled = false, hint, onChange } = {}) {
  return h_flex().id(id).gap(8).items_center().py(3).text_size(12.5).text_color(disabled ? t.dim : t.foreground)
    .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onChange?.(!on, cx)))
    .child(div().size(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on && !disabled ? t.accent : t.input).bg(on && !disabled ? t.accent : t.background)
      .when(on, (el) => el.child(svg(icon("check")).size(11).text_color(disabled ? t.dim : t.accent_foreground))))
    .child(div().flex_1().child(label))
    .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)));
}
