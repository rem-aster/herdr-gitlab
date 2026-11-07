// Made-up data for screenshots: a block with props { demo: true } shows it instead of a repo.
// Nothing here talks to git or GitLab.

const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const web = "https://gitlab.example.com/acme/storefront";
let ids = 0;

function pipeline(iid, status, ref, title, minutes, duration, stages, user = "dana") {
  return {
    id: `gid://gitlab/Ci::Pipeline/${iid}`, iid: String(iid), status, ref, path: `/acme/storefront/-/pipelines/${iid}`,
    createdAt: at(minutes), startedAt: at(minutes), duration, detailedStatus: { group: status.toLowerCase() },
    user: { username: user }, commit: { shortId: (iid * 2654435761 % 0xfffffff).toString(16).padStart(8, "0"), title },
    stages: { nodes: stages.map(([name, jobs]) => ({ name, jobs: { nodes: jobs.map(([job, s, sec]) => ({
      id: `gid://gitlab/Ci::Build/${++ids}`, name: job, status: s, allowFailure: false, retried: false, retryable: s === "FAILED",
      webPath: `/acme/storefront/-/jobs/${ids}`, duration: sec, startedAt: sec ? at(Math.ceil(sec / 60)) : s === "RUNNING" ? at(2) : null,
    })) } })) },
  };
}

const STAGES = [
  ["prepare", [["install", "SUCCESS", 48]]],
  ["test", [["unit", "SUCCESS", 131], ["e2e", "RUNNING", null]]],
  ["build", [["image", "CREATED", null]]],
  ["deploy", [["staging", "MANUAL", null]]],
];
const GREEN = [["prepare", [["install", "SUCCESS", 51]]], ["test", [["unit", "SUCCESS", 127], ["e2e", "SUCCESS", 402]]]];

function mr(iid, title, branch, author, minutes, status, add, del, head, extra = {}) {
  return {
    id: `gid://gitlab/MergeRequest/${iid}`, iid: String(iid), title, state: "opened", draft: title.startsWith("Draft:"),
    webUrl: `${web}/-/merge_requests/${iid}`, createdAt: at(minutes * 3), updatedAt: at(minutes),
    sourceBranch: branch, targetBranch: "main", detailedMergeStatus: status, userNotesCount: 2,
    sourceProjectId: 1, targetProjectId: 1, resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0,
    author: { username: author }, reviewers: { nodes: [] }, approvedBy: { nodes: [] },
    userPermissions: { canMerge: true, canApprove: true, updateMergeRequest: true, createNote: true },
    diffStatsSummary: { additions: add, deletions: del, fileCount: 7 }, headPipeline: head, ...extra,
  };
}

export function demoState() {
  const running = pipeline(412, "RUNNING", "refs/merge-requests/128/head", "feat(checkout): retry failed payments with backoff", 6, null, STAGES);
  const mine = mr(128, "feat(checkout): retry failed payments with backoff", "feat/checkout-retry", "dana", 6, "CI_STILL_RUNNING", 214, 38, running,
    { resolvableDiscussionsCount: 3, resolvedDiscussionsCount: 2 });
  const mrs = [
    mine,
    mr(126, "fix(cart): keep the coupon after a currency switch", "fix/coupon-currency", "lee", 52, "MERGEABLE", 31, 9,
      { iid: "409", status: "SUCCESS", detailedStatus: { group: "success" } }, { reviewers: { nodes: [{ username: "dana" }] } }),
    mr(121, "Draft: search with typo tolerance", "feat/fuzzy-search", "sam", 180, "DRAFT_STATUS", 488, 120,
      { iid: "401", status: "FAILED", detailedStatus: { group: "failed" } }),
    mr(117, "chore(deps): bump vite to 7.2", "renovate/vite-7.x", "renovate-bot", 1440, "CONFLICT", 12, 12,
      { iid: "388", status: "SUCCESS", detailedStatus: { group: "success" } }),
  ];
  const pipelines = [
    running,
    pipeline(411, "SUCCESS", "main", "Merge branch 'fix/tax-rounding' into 'main'", 34, 486, GREEN),
    pipeline(409, "SUCCESS", "refs/merge-requests/126/head", "fix(cart): keep the coupon after a currency switch", 52, 397, GREEN, "lee"),
    pipeline(405, "FAILED", "main", "Merge branch 'feat/gift-cards' into 'main'", 190, 233,
      [["prepare", [["install", "SUCCESS", 47]]], ["test", [["unit", "SUCCESS", 118], ["e2e", "FAILED", 61]]]]),
    pipeline(401, "FAILED", "refs/merge-requests/121/head", "search: typo tolerance (wip)", 200, 95,
      [["prepare", [["install", "SUCCESS", 50]]], ["test", [["unit", "FAILED", 45]]]], "sam"),
    pipeline(398, "CANCELED", "main", "Merge branch 'docs/api' into 'main'", 300, 40, GREEN),
    pipeline(394, "SUCCESS", "main", "Merge branch 'feat/wishlist' into 'main'", 1500, 512, GREEN),
  ];
  const issue = (iid, title, who, minutes, labels) => ({
    iid: String(iid), title, description: "Steps to reproduce, expected and actual behaviour.", webUrl: `${web}/-/issues/${iid}`,
    updatedAt: at(minutes), author: { username: "lee" }, assignees: { nodes: who ? [{ username: who }] : [] },
    labels: { nodes: labels.map(([title, color]) => ({ title, color })) },
  });
  const issues = [
    issue(342, "Payment retries double-charge on slow 3-D Secure", "dana", 20, [["bug", "#e5484d"], ["checkout", "#3e63dd"]]),
    issue(339, "Show delivery estimates on the product page", null, 260, [["feature", "#30a46c"]]),
    issue(331, "Flaky e2e: cart badge count after login", "sam", 900, [["flaky", "#f5a524"], ["ci", "#8e4ec6"]]),
  ];
  return {
    host: "gitlab.example.com", path: "acme/storefront", root: "/tmp", on: null, remote: "origin", web, origin: "https://gitlab.example.com",
    main: "main", me: "dana", todos: 3, branch: "feat/checkout-retry", branchMr: mine, branchPipeline: running,
    mrs, mrCount: mrs.length, pipelines, issues, issueCount: issues.length, error: null,
  };
}
