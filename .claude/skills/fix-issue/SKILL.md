---
name: fix-issue
description: Pick a GitHub issue, implement the fix, create memories/skills if needed, then open a PR that closes the issue.
argument-hint: "[issue-number]"
---

## Workflow

### 1. Pick an issue
- If `$ARGUMENTS` is provided, use that issue number.
- Otherwise, run `gh issue list --state open --limit 20` and pick the most impactful issue. Don't overthink prioritization.

### 2. Understand the issue
- Run `gh issue view <number>` to read the full description.
- Read the relevant source files mentioned in the issue.

### 3. Implement the fix
- Create a branch: `fix/<short-description>` or `feat/<short-description>`.
- Make the changes. Keep the diff minimal and focused on the issue.
- Run relevant tests (e.g. `/test-api` for API changes) and make sure they pass.

### 4. Check for new skills or memories
Before committing, consider:
- **Skills**: Is there a repeatable workflow from this fix that should become a skill? (e.g. a new test command, a deploy step)
- **Memories**: Did you learn something non-obvious about the project, user preferences, or tooling that would help in future sessions? If so, save it.

Only create these if genuinely useful — don't force it.

### 5. Commit, push, and create a PR
- Commit with a clear message explaining the "why".
- Push the branch and create a PR using `gh pr create`.
- The PR body must include `Closes #<issue-number>` to link and auto-close the issue.
- Switch back to `main` when done.
- Return the PR URL to the user.
