/**
 * Splice Accessibility Auditor
 *
 * Deterministic, dependency-free WCAG checks evaluated against the live DOM.
 * Two audiences:
 *
 *  - Product teams: agents can audit any page they operate and hand back a
 *    scored, WCAG-mapped fix list — accessibility regressions become as
 *    testable as functional ones.
 *  - The agents themselves: pages that fail these checks (unlabeled controls,
 *    nameless buttons) are exactly the pages agents misread. The audit
 *    explains *why* a page is hard to operate and what to ask the site to fix.
 *
 * The DOM scan lives in BrowserManager.runAccessibilityAudit (it must run
 * in-page); this module owns the rule catalog, severity model, scoring, and
 * summary so they stay pure and unit-testable.
 */

export type A11ySeverity = 'critical' | 'serious' | 'moderate';

export interface A11yFinding {
  /** Stable rule id, e.g. "image-alt". */
  rule: string;
  /** WCAG success criterion, e.g. "1.1.1 Non-text Content". */
  wcag: string;
  severity: A11ySeverity;
  /** Human-readable element descriptor (tag + identifying attribute). */
  element: string;
  /** What is wrong, in one sentence. */
  detail: string;
  /** The concrete change that resolves it. */
  fix: string;
}

export interface A11yAuditReport {
  url: string;
  title: string;
  /** 0–100: starts at 100, weighted deductions per finding, floored at 0. */
  score: number;
  findings: A11yFinding[];
  bySeverity: Record<A11ySeverity, number>;
  /** Rules that ran and found nothing — evidence of what was verified, not skipped. */
  passedRules: string[];
  /** One-sentence read of the most decision-relevant signal. */
  summary: string;
  /** Why this matters to an agent operating the page right now. */
  agentImpact: string;
}

export const A11Y_RULES: Record<string, { wcag: string; severity: A11ySeverity; agentImpact?: string }> = {
  'image-alt': { wcag: '1.1.1 Non-text Content', severity: 'serious' },
  'control-label': {
    wcag: '1.3.1 Info and Relationships / 3.3.2 Labels or Instructions',
    severity: 'critical',
    agentImpact: 'Unlabeled controls cannot be targeted by label — fill_form and intent grounding degrade to guessing.',
  },
  'accessible-name': {
    wcag: '4.1.2 Name, Role, Value',
    severity: 'critical',
    agentImpact: 'Nameless buttons/links are invisible to intent ranking — compiled actions lose their best candidates.',
  },
  'document-language': { wcag: '3.1.1 Language of Page', severity: 'moderate' },
  'document-title': { wcag: '2.4.2 Page Titled', severity: 'moderate' },
  'heading-order': { wcag: '1.3.1 Info and Relationships', severity: 'moderate' },
  'color-contrast': { wcag: '1.4.3 Contrast (Minimum)', severity: 'serious' },
  'positive-tabindex': { wcag: '2.4.3 Focus Order', severity: 'serious' },
  'duplicate-id': { wcag: '4.1.1 Parsing', severity: 'moderate' },
  'aria-hidden-focus': {
    wcag: '4.1.2 Name, Role, Value',
    severity: 'serious',
    agentImpact: 'Focusable elements inside aria-hidden trees confuse both assistive tech and semantic extraction.',
  },
};

const SEVERITY_WEIGHT: Record<A11ySeverity, number> = { critical: 12, serious: 6, moderate: 3 };

export function summarizeAudit(
  url: string,
  title: string,
  findings: A11yFinding[]
): A11yAuditReport {
  const bySeverity: Record<A11ySeverity, number> = { critical: 0, serious: 0, moderate: 0 };
  for (const f of findings) bySeverity[f.severity]++;

  const deduction = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const score = Math.max(0, 100 - deduction);

  const failedRules = new Set(findings.map((f) => f.rule));
  const passedRules = Object.keys(A11Y_RULES).filter((rule) => !failedRules.has(rule));

  const agentImpacts = [...failedRules]
    .map((rule) => A11Y_RULES[rule]?.agentImpact)
    .filter((v): v is string => Boolean(v));

  const summary =
    findings.length === 0
      ? `No accessibility violations detected across ${passedRules.length} rules.`
      : `${findings.length} violation(s): ${bySeverity.critical} critical, ${bySeverity.serious} serious, ${bySeverity.moderate} moderate — worst first: ${findings[0].rule} (${findings[0].wcag}).`;

  return {
    url,
    title,
    score,
    findings,
    bySeverity,
    passedRules,
    summary,
    agentImpact:
      agentImpacts.length > 0
        ? agentImpacts.join(' ')
        : 'No findings that impair agent operation — labels and names are sound, so intent grounding works at full strength.',
  };
}

/** Order findings worst-first so truncated views keep the important ones. */
export function sortFindings(findings: A11yFinding[]): A11yFinding[] {
  const rank: Record<A11ySeverity, number> = { critical: 0, serious: 1, moderate: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
}
