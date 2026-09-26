---
name: verify-before-submit
description: The checklist to run before calling team_task_submit, so reviews pass the first time. Use every time you are about to submit a task.
---

# Verify before you submit

A rejected review costs the team a full extra round. Spend five minutes here instead.

1. **Scope.** `git status` and `git diff --stat`: only files inside your task scope changed; no stray debug
   files, logs or secrets.
2. **Checks.** Run the team's check commands (see team_status). They must pass. Use the `tester` sub-agent
   for long suites so the output stays out of your context.
3. **Acceptance criteria.** Walk through each one and actually exercise it (run the command, call the
   endpoint, open the page). Note how you verified each.
4. **Visual.** If a person will see it, use the visual-check skill.
5. **Fresh eyes.** Ask the `critic` sub-agent to review your diff against the spec. Fix real defects.
6. **Commit** with a clear message.
7. **Submit** with evidence written as: `command → result` lines, plus screenshot paths.
