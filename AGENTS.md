# General Agent Workflow

Work autonomously and avoid unnecessary process overhead.

Before acting, inspect the relevant context and determine the task's complexity.

## Default behavior

For clear and reversible tasks:

1. Inspect the relevant files and existing patterns.
2. Make the smallest appropriate change.
3. Test or otherwise verify the result.
4. Report what changed, verification results, and remaining risks.

Do not invoke the full brainstorming workflow for routine implementation, bug fixes, tests, refactoring, configuration changes, or clearly defined features.

## Planning

For moderately complex tasks, briefly identify assumptions, trade-offs, and the intended approach, then proceed without waiting for approval.

Use the full brainstorming workflow only when the task:

- has materially ambiguous requirements;
- involves major architectural or product decisions;
- has several substantially different valid approaches;
- is difficult or expensive to reverse;
- or is explicitly requested by the user.

When uncertain, prefer a short plan over the full brainstorming workflow.

## Approval

Proceed without confirmation for safe, local, and reversible changes.

Ask before destructive actions, external publication or deployment, irreversible migrations, major scope expansion, or consequential interface changes.

## Verification

Do not claim completion without evidence.

Run the most relevant available tests, checks, builds, or focused validations. Clearly state anything that could not be verified.

## Git publication

For this repository, verified work may be pushed to the configured GitHub remote without requesting confirmation again when:

- the change is coherent and complete;
- relevant tests and checks pass;
- the working tree contains no unrelated or sensitive files;
- commits are focused and use conventional, descriptive messages;
- and the destination branch and upstream have been verified.

Use normal fast-forward pushes. Never force-push, rewrite published history, push secrets, generated artifacts, local-only documentation, or known failing or incomplete work. Report the destination branch and pushed commit after publication.
