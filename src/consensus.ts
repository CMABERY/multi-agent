import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { nextId } from "./ids.js";
import { pathEscapesWorkspace } from "./intelligenceCommon.js";
import {
  ArtifactIndexSchema,
  ConsensusStoreSchema,
  ReviewLogSchema,
  TaskBoardSchema,
  type Artifact,
  type Citation,
  type Consensus,
  type ConsensusVerdict,
  type PerCriterionVerdict,
  type StructuredReview,
  type Task
} from "./schemas.js";
import { loadJson, loadJsonOrDefault, nowIso, saveJson } from "./storage.js";

const citableArtifactTypes = new Set(["model_output", "command_output"]);

export async function computeConsensus(
  root: string,
  input: { taskId: string }
): Promise<Consensus> {
  const reviewLog = ReviewLogSchema.parse(await loadJson(root, "state/review_log.json"));
  const board = TaskBoardSchema.parse(await loadJson(root, "state/task_board.json"));
  const artifactIndex = ArtifactIndexSchema.parse(await loadJson(root, "artifacts/artifact_index.json"));
  const store = ConsensusStoreSchema.parse(
    await loadJsonOrDefault(root, "state/consensus.json", { consensus_records: [] })
  );
  const task = board.tasks.find((entry) => entry.task_id === input.taskId);
  const taskReviews = reviewLog.reviews.filter((review) => review.task_id === input.taskId);
  if (taskReviews.length === 0) {
    throw new Error("No structured reviews found for " + (input.taskId) + ".");
  }
  const citationChecked = await validateReviewCitations(root, taskReviews, artifactIndex.artifacts);
  if (citationChecked.changed) {
    const checkedById = new Map(citationChecked.reviews.map((review) => [review.review_id, review]));
    reviewLog.reviews = reviewLog.reviews.map((review) => checkedById.get(review.review_id) ?? review);
    await saveJson(root, "state/review_log.json", reviewLog);
  }
  const reviews = latestReviewsByPersona(citationChecked.reviews);
  const criteria = criteriaForTask(task, reviews);
  const requiredReviewers = requiredReviewerCount(task);
  const nonAbstainCount = reviews.filter((review) => !isAbstention(review)).length;
  const perCriterion = criteria.map((criterion) => computeCriterionVerdict(criterion, reviews, requiredReviewers));
  const overallVerdict = computeOverallVerdict(perCriterion, nonAbstainCount, requiredReviewers);
  const now = nowIso();
  const existingIndex = store.consensus_records.findIndex(
    (entry) => entry.task_id === input.taskId && entry.is_load_bearing
  );
  const fallbackIndex =
    existingIndex >= 0
      ? existingIndex
      : store.consensus_records.findIndex((entry) => entry.task_id === input.taskId);
  const existing = fallbackIndex >= 0 ? store.consensus_records[fallbackIndex] : undefined;

  for (const record of store.consensus_records) {
    if (record.task_id === input.taskId) record.is_load_bearing = false;
  }

  const consensus: Consensus = {
    consensus_id:
      existing?.consensus_id ??
      nextId(
        "C",
        store.consensus_records.map((entry) => entry.consensus_id)
      ),
    task_id: input.taskId,
    review_ids: reviews.map((review) => review.review_id),
    reviewer_count: Math.max(1, reviews.length),
    per_criterion: perCriterion,
    overall_verdict: overallVerdict,
    is_load_bearing: true,
    created_at: existing?.created_at ?? now,
    updated_at: existing ? now : undefined
  };

  if (fallbackIndex >= 0) store.consensus_records[fallbackIndex] = consensus;
  else store.consensus_records.push(consensus);
  await saveJson(root, "state/consensus.json", store);
  return consensus;
}

async function validateReviewCitations(
  root: string,
  reviews: StructuredReview[],
  artifacts: Artifact[]
): Promise<{ reviews: StructuredReview[]; changed: boolean }> {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  let changed = false;
  const checked: StructuredReview[] = [];
  for (const review of reviews) {
    const invalidity = await firstCitationInvalidity(root, review, artifactById);
    if (!invalidity) {
      checked.push(review);
      continue;
    }
    changed = true;
    checked.push({
      ...review,
      status: "abstain",
      per_criterion: [],
      malformed: true,
      free_form_assessment: appendMalformedCitationReason(review, invalidity)
    });
  }
  return { reviews: checked, changed };
}

async function firstCitationInvalidity(
  root: string,
  review: StructuredReview,
  artifactById: Map<string, Artifact>
): Promise<string | undefined> {
  if (isAbstention(review)) return undefined;
  for (const verdict of review.per_criterion) {
    for (const citation of verdict.citations) {
      const invalidity = await validateCitation(root, review, citation, artifactById);
      if (invalidity) return invalidity;
    }
  }
  return undefined;
}

async function validateCitation(
  root: string,
  review: StructuredReview,
  citation: Citation,
  artifactById: Map<string, Artifact>
): Promise<string | undefined> {
  const artifact = artifactById.get(citation.artifact_id);
  if (!artifact) return "Citation " + (citation.artifact_id) + " does not exist in the artifact index.";
  if (artifact.task_id !== review.task_id) {
    return (
      "Citation " +
      (citation.artifact_id) +
      " belongs to task " +
      (artifact.task_id) +
      ", not reviewed task " +
      (review.task_id) +
      "."
    );
  }
  if (!citableArtifactTypes.has(artifact.type)) {
    return "Citation " + (citation.artifact_id) + " is not a deliverable artifact (" + (artifact.type) + ").";
  }
  const lineCount = await readArtifactLineCount(root, artifact);
  if (typeof lineCount === "string") return lineCount;
  if (citation.line_end > lineCount) {
    return (
      "Citation " +
      (citation.artifact_id) +
      " lines " +
      (citation.line_start) +
      "-" +
      (citation.line_end) +
      " are outside artifact " +
      (citation.artifact_id) +
      " line count " +
      (lineCount) +
      "."
    );
  }
  return undefined;
}

async function readArtifactLineCount(root: string, artifact: Artifact): Promise<number | string> {
  if (pathEscapesWorkspace(root, artifact.path)) {
    return "Citation " + (artifact.artifact_id) + " path escapes the workspace.";
  }
  try {
    const content = await readFile(join(root, artifact.path), "utf8");
    return countLines(content);
  } catch {
    return "Citation " + (artifact.artifact_id) + " artifact file is missing or unreadable.";
  }
}

function countLines(content: string): number {
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (normalized.length === 0) return 0;
  return normalized.split("\n").length;
}

function appendMalformedCitationReason(review: StructuredReview, reason: string): string {
  const prefix = review.free_form_assessment.trim();
  const suffix = "Malformed review citation: " + reason;
  return prefix ? "" + (prefix) + "\n" + (suffix) : suffix;
}

function latestReviewsByPersona(reviews: StructuredReview[]): StructuredReview[] {
  const latest = new Map<StructuredReview["reviewer_persona"], StructuredReview>();
  for (const review of reviews) {
    const current = latest.get(review.reviewer_persona);
    if (!current || compareReviewRecency(review, current) > 0) {
      latest.set(review.reviewer_persona, review);
    }
  }
  return Array.from(latest.values()).sort(compareReviewsChronologically);
}

function compareReviewsChronologically(left: StructuredReview, right: StructuredReview): number {
  const createdDiff = reviewTimestamp(left) - reviewTimestamp(right);
  if (createdDiff !== 0) return createdDiff;
  return reviewSequence(left) - reviewSequence(right);
}

function compareReviewRecency(candidate: StructuredReview, current: StructuredReview): number {
  return compareReviewsChronologically(candidate, current);
}

function reviewTimestamp(review: StructuredReview): number {
  const timestamp = Date.parse(review.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function reviewSequence(review: StructuredReview): number {
  const match = /^R-(\d+)$/.exec(review.review_id);
  return match ? Number(match[1]) : 0;
}

function criteriaForTask(task: Task | undefined, reviews: StructuredReview[]): string[] {
  if (task) return task.acceptance_criteria;
  const criteria = new Set<string>();
  for (const review of reviews) {
    for (const verdict of review.per_criterion) criteria.add(verdict.criterion);
  }
  return Array.from(criteria);
}

function requiredReviewerCount(task: Task | undefined): number {
  if (!task) return 1;
  if (task.risk_level === "high") return 3;
  if (task.risk_level === "medium") return 2;
  return 1;
}

function computeCriterionVerdict(
  criterion: string,
  reviews: StructuredReview[],
  requiredReviewers: number
): ConsensusVerdict {
  let passCount = 0;
  let failCount = 0;
  let unverifiableCount = 0;
  let abstainCount = 0;
  const criterionVerdicts: Array<{ review: StructuredReview; verdict: PerCriterionVerdict }> = [];
  const passCitations: Citation[] = [];
  const citedFailures: Array<{ review: StructuredReview; verdict: PerCriterionVerdict }> = [];

  for (const review of reviews) {
    const verdict = review.per_criterion.find((entry) => entry.criterion === criterion);
    if (isAbstention(review) || !verdict) {
      abstainCount += 1;
      continue;
    }
    criterionVerdicts.push({ review, verdict });
    if (verdict.verdict === "pass") {
      passCount += 1;
      passCitations.push(...verdict.citations);
    } else if (verdict.verdict === "fail") {
      failCount += 1;
      if (verdict.citations.length > 0) citedFailures.push({ review, verdict });
    } else {
      unverifiableCount += 1;
    }
  }

  const convergentCitations =
    requiredReviewers === 1 ? dedupeCitations(passCitations) : computeOverlappingCitations(passCitations);
  let verdict: ConsensusVerdict["verdict"];
  if (citedFailures.length > 0) {
    verdict = "fail";
  } else if (
    passCount > failCount + unverifiableCount &&
    passCount > 0 &&
    convergentCitations.length > 0
  ) {
    verdict = "pass";
  } else if (passCount > failCount + unverifiableCount && passCount > 0) {
    verdict = "fail";
  } else if (unverifiableCount > 0 && passCount === 0 && failCount === 0) {
    verdict = "unverifiable";
  } else if (passCount === 0 && failCount === 0 && unverifiableCount === 0 && abstainCount > 0) {
    verdict = "unverifiable";
  } else {
    verdict = "split";
  }

  return {
    criterion,
    pass_count: passCount,
    fail_count: failCount,
    unverifiable_count: unverifiableCount,
    abstain_count: abstainCount,
    verdict,
    convergent_citations: convergentCitations,
    dissent: dissentForVerdict(verdict, criterionVerdicts)
  };
}

function computeOverallVerdict(
  perCriterion: ConsensusVerdict[],
  nonAbstainCount: number,
  requiredReviewers: number
): Consensus["overall_verdict"] {
  if (nonAbstainCount < requiredReviewers) return "insufficient";
  if (perCriterion.length > 0 && perCriterion.every((entry) => entry.verdict === "pass")) return "pass";
  if (perCriterion.some((entry) => entry.verdict === "split")) return "split";
  if (perCriterion.some((entry) => entry.verdict === "fail")) return "fail";
  return "insufficient";
}

function computeOverlappingCitations(citations: Citation[]): Citation[] {
  const overlaps: Citation[] = [];
  for (let left = 0; left < citations.length; left += 1) {
    for (let right = left + 1; right < citations.length; right += 1) {
      const overlap = intersectCitations(citations[left], citations[right]);
      if (overlap) overlaps.push(overlap);
    }
  }
  return dedupeCitations(overlaps);
}

function intersectCitations(left: Citation | undefined, right: Citation | undefined): Citation | undefined {
  if (!left || !right || left.artifact_id !== right.artifact_id) return undefined;
  const lineStart = Math.max(left.line_start, right.line_start);
  const lineEnd = Math.min(left.line_end, right.line_end);
  if (lineStart > lineEnd) return undefined;
  return { artifact_id: left.artifact_id, line_start: lineStart, line_end: lineEnd };
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const deduped: Citation[] = [];
  for (const citation of citations) {
    const key = "" + (citation.artifact_id) + ":" + (citation.line_start) + ":" + (citation.line_end);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function dissentForVerdict(
  consensusVerdict: ConsensusVerdict["verdict"],
  verdicts: Array<{ review: StructuredReview; verdict: PerCriterionVerdict }>
): ConsensusVerdict["dissent"] {
  if (consensusVerdict === "split") {
    return verdicts.map(({ review, verdict }) => ({
      review_id: review.review_id,
      verdict: verdict.verdict,
      rationale: verdict.rationale
    }));
  }
  return verdicts
    .filter(({ verdict }) => verdict.verdict !== consensusVerdict)
    .map(({ review, verdict }) => ({
      review_id: review.review_id,
      verdict: verdict.verdict,
      rationale: verdict.rationale
    }));
}

function isAbstention(review: StructuredReview): boolean {
  return review.status === "abstain" || review.malformed || review.truncated;
}
