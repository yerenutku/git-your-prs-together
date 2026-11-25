// State of one of my own PRs. Loaded by both the service worker (importScripts) and the content scripts,
// so the sidebar and the notifications always agree.
//
// `item` is what background.js stores in `authored.items` (see summarizeAuthored there).
// `seenAt` is when I last opened the PR (threadSeen, ms).
(() => {
  const STATES = {
    attention: { label: "Needs your attention", order: 0 },
    ready: { label: "Ready to merge", order: 1 },
    progress: { label: "In progress", order: 2 },
    their: { label: "Their turn", order: 3 },
  };

  // Comments / reviews from others that I haven't answered and that arrived after I last opened the PR.
  const freshActivity = (item, seenAt) => (item.activity || []).filter((a) => !a.answered && Date.parse(a.at) > (seenAt || 0));

  // "Ready to merge" is GitHub's own verdict (the merge box's "All requirements are met"), not ours.
  // Without the merge verdict (token can't see the PR), use what GitHub's list row shows: "Approved" and checks passed.
  const isReady = (item) =>
    !item.isDraft &&
    (item.mergeState
      ? item.mergeState === "CLEAN" || item.mergeState === "HAS_HOOKS"
      : !!item.session && item.approved && !item.changesRequested && (!item.checks || item.checks === "SUCCESS"));
  // GitHub's reason when it isn't ready, worded for the "In progress" tooltip.
  const MERGE_STATE_WHY = {
    BEHIND: "branch is behind the base branch",
    BLOCKED: "GitHub says not all merge requirements are met",
    UNSTABLE: "some checks are failing",
    UNKNOWN: "GitHub is still checking mergeability",
  };

  function authoredState(item, seenAt) {
    const fresh = freshActivity(item, seenAt);
    // PENDING_FAILED: GitHub's page data for "some still running, one already failed".
    const checksBad = item.checks === "FAILURE" || item.checks === "ERROR" || item.checks === "PENDING_FAILED";
    const checksOk = !item.checks || item.checks === "SUCCESS"; // no checks configured counts as passing
    const conflict = item.mergeable === "CONFLICTING" || item.mergeState === "DIRTY";
    const who = () => [...new Set(fresh.map((a) => a.author))].join(", ");
    const out = (state, reason) => ({ state, label: STATES[state].label, order: STATES[state].order, reason, fresh });

    // GitHub says it can be merged: that wins. New comments still get a notification and are named here.
    if (isReady(item)) {
      const extra = fresh.length ? ` (${fresh.length} new comment${fresh.length === 1 ? "" : "s"} from ${who()})` : "";
      const why = item.mergeState
        ? "GitHub: all requirements are met"
        : `Approved, checks passed${item.checksText ? ` (${item.checksText})` : ""}`;
      return out("ready", `${why}${extra}`);
    }
    if (fresh.length) {
      return out("attention", `${fresh.length} new comment${fresh.length === 1 ? "" : "s"} from ${who()}`);
    }
    const reviewed = (item.activity || []).length > 0 || item.reviewCount > 0;
    // GitHub says an approval is still required, or (session data, which has no review requests) there is none yet.
    const needsApproval = item.reviewDecision === "REVIEW_REQUIRED" || (!!item.session && !item.approved);
    if (!item.isDraft && !checksBad && !conflict && !item.unanswered && !item.approved && (item.pendingReviewers > 0 || reviewed || needsApproval)) {
      return out(
        "their",
        item.pendingReviewers > 0
          ? `Waiting on ${item.pendingReviewers} reviewer${item.pendingReviewers === 1 ? "" : "s"}`
          : item.reviewDecision === "REVIEW_REQUIRED"
          ? "Waiting for an approval (GitHub: review required)"
          : needsApproval
          ? "Waiting for a review (no approval yet)"
          : "All comments answered or resolved: waiting on reviewers"
      );
    }
    const why = [];
    if (item.isDraft) why.push("draft");
    if (checksBad) why.push("checks failing");
    else if (item.checks && !checksOk) why.push("checks running");
    if (conflict) why.push("merge conflicts");
    if (item.unanswered) why.push(`${item.unanswered} open thread${item.unanswered === 1 ? "" : "s"} to answer`);
    if (item.changesRequested) why.push("changes requested");
    if (item.mergeState === "BEHIND") why.push(MERGE_STATE_WHY.BEHIND);
    if (!why.length && MERGE_STATE_WHY[item.mergeState]) why.push(MERGE_STATE_WHY[item.mergeState]);
    if (!why.length && !reviewed && !item.pendingReviewers) why.push("no reviewers requested");
    return out("progress", why.join(", ") || "Under way");
  }

  self.GHCState = { STATES, authoredState, freshActivity, isReady };
})();
