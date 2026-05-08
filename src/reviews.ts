import { nextId } from "./ids.js";
import { computeConsensus } from "./consensus.js";
import {
  ReviewLogSchema,
  ReviewSchema,
  type PerCriterionVerdict,
  type Review,
  type ReviewIssue,
  type ReviewerPersona
} from "./schemas.js";
import { loadJson, nowIso, saveJson } from "./storage.js";

export async function recordReview(
  root: string,
  input: {
    taskId: string;
    reviewerAgentId?: string;
    reviewer?: string;
    reviewerPersona?: ReviewerPersona;
    status: "pass" | "fail" | "abstain";
    perCriterion?: PerCriterionVerdict[];
    identifiedIssues?: ReviewIssue[];
    issues?: ReviewIssue[];
    freeFormAssessment?: string;
    malformed?: boolean;
    truncated?: boolean;
  }
): Promise<Review> {
  const log = ReviewLogSchema.parse(await loadJson(root, "state/review_log.json"));
  const malformed = input.malformed ?? false;
  const truncated = input.truncated ?? false;
  const review = ReviewSchema.parse({
    review_id: nextId(
      "R",
      log.reviews.map((entry) => entry.review_id)
    ),
    task_id: input.taskId,
    reviewer_agent_id: input.reviewerAgentId ?? input.reviewer ?? "manual_reviewer",
    reviewer_persona: input.reviewerPersona ?? "default",
    status: malformed || truncated ? "abstain" : input.status,
    per_criterion: input.perCriterion ?? [],
    identified_issues: input.identifiedIssues ?? input.issues ?? [],
    free_form_assessment: input.freeFormAssessment ?? "",
    malformed,
    truncated,
    created_at: nowIso()
  });
  log.reviews.push(review);
  await saveJson(root, "state/review_log.json", log);
  return review;
}

export async function migrateLegacyReviews(
  root: string
): Promise<{ migratedCount: number; taskIds: string[] }> {
  const raw = await loadJson<{ reviews?: unknown[] }>(root, "state/review_log.json");
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  const migratedTaskIds = new Set<string>();
  let migratedCount = 0;
  const nextReviews = reviews.map((entry) => {
    if (!isLegacyReview(entry)) return entry;
    migratedCount += 1;
    migratedTaskIds.add(entry.task_id);
    return ReviewSchema.parse({
      review_id: entry.review_id,
      task_id: entry.task_id,
      reviewer_agent_id: entry.reviewer,
      reviewer_persona: "default",
      status: "abstain",
      per_criterion: [],
      identified_issues: Array.isArray(entry.issues) ? entry.issues : [],
      free_form_assessment: "Legacy enum review; pre-v0.3 schema.",
      malformed: true,
      truncated: false,
      created_at: entry.created_at
    });
  });

  if (migratedCount === 0) return { migratedCount: 0, taskIds: [] };
  await saveJson(root, "state/review_log.json", { reviews: nextReviews });
  for (const taskId of migratedTaskIds) {
    await computeConsensus(root, { taskId });
  }
  return { migratedCount, taskIds: Array.from(migratedTaskIds) };
}

export function hasLegacyReviews(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("reviews" in value)) return false;
  const reviews = (value as { reviews?: unknown }).reviews;
  return Array.isArray(reviews) && reviews.some(isLegacyReview);
}

function isLegacyReview(value: unknown): value is {
  review_id: string;
  task_id: string;
  reviewer: string;
  status: "pass" | "fail";
  issues?: unknown[];
  created_at: string;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      "review_id" in value &&
      "task_id" in value &&
      "reviewer" in value &&
      !("per_criterion" in value) &&
      "created_at" in value
  );
}
