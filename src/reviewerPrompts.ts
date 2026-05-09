import type { ReviewerPersona, Task } from "./schemas.js";

export const reviewerPromptTemplates: Record<ReviewerPersona, string> = {
  default:
    "You are a structured verification reviewer. Check only the supplied artifact and cited context.",
  skeptical:
    "You are a skeptical reviewer and structured verification reviewer; assume the deliverable is wrong until the cited lines prove otherwise.",
  completeness:
    "You are a completeness reviewer and structured verification reviewer; compare the deliverable against the full prompt contract and identify missing scope.",
  rigor:
    "You are a rigor reviewer and structured verification reviewer; check internal consistency, arithmetic, causal claims, and whether evidence actually supports the conclusion.",
  adversarial:
    "You are an adversarial reviewer and structured verification reviewer; write a one-paragraph attack on each pass verdict before recording it."
};

export function buildReviewerInstructions(persona: ReviewerPersona, task: Task): string {
  const criterionRules = buildCriterionSpecificRules(task);
  return [
    reviewerPromptTemplates[persona],
    "",
    "Return only strict JSON. Do not wrap it in Markdown.",
    "The JSON must match this shape:",
    "{",
    '  "reviewer_persona": "' + persona + '",',
    '  "status": "pass|fail|abstain",',
    '  "per_criterion": [',
    "    {",
    '      "criterion": "verbatim acceptance criterion",',
    '      "verdict": "pass|fail|unverifiable",',
    '      "citations": [{"artifact_id": "ART-001", "line_start": 1, "line_end": 1}],',
    '      "rationale": "specific explanation tied to the citations",',
    '      "confidence": 0.0',
    "    }",
    "  ],",
    '  "identified_issues": [',
    "    {",
    '      "issue_id": "RI-001",',
    '      "severity": "low|medium|high",',
    '      "category": "acceptance_criteria|evidence|consistency|risk|other",',
    '      "description": "specific issue description",',
    '      "evidence": "artifact id and line span supporting the issue",',
    '      "recommended_fix": "specific corrective action"',
    "    }",
    "  ],",
    '  "free_form_assessment": "backup narrative; not used for scoring"',
    "}",
    "",
    "Rules:",
    "- Include exactly one per_criterion entry for each acceptance criterion below, verbatim.",
    "- Any pass verdict must include at least one citation to a line-numbered ART artifact.",
    "- A fail verdict should cite the exact lines that demonstrate the failure when possible.",
    "- Use unverifiable when the supplied artifacts do not contain enough evidence.",
    "- Overall status is pass only when every criterion passes; fail when any criterion fails; otherwise abstain.",
    ...(criterionRules.length > 0 ? ["", "Criterion-specific rules:", ...criterionRules] : []),
    "",
    "Acceptance criteria:",
    ...task.acceptance_criteria.map((criterion) => "- " + (criterion))
  ].join("\n");
}

function buildCriterionSpecificRules(task: Task): string[] {
  const rules = new Set<string>();
  for (const criterion of task.acceptance_criteria) {
    const normalized = criterion.toLowerCase();
    if (
      normalized.includes("tradeoff") &&
      normalized.includes("latency") &&
      normalized.includes("cost") &&
      normalized.includes("reliability")
    ) {
      rules.add(
        "- Do not fail solely for tradeoff label formatting if the artifact separately states latency, cost, and reliability for each main option."
      );
      rules.add(
        "- Qualitative ranges are acceptable when paired with a concrete impact or rationale."
      );
      rules.add(
        "- Do not treat summary recommendation lists as new options when they only reference options already covered."
      );
    }
  }
  return Array.from(rules);
}
