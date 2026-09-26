---
name: usage-thrift
description: Ways to spend fewer tokens without lowering quality. Use when your account is in conserve mode or a task involves large files or long command output.
---

# Spend less, keep quality

- Search before reading: `grep -n`/Glob to find the lines, then read only that range.
- Never print long output into the conversation: `cmd > /tmp/out.log 2>&1; tail -n 40 /tmp/out.log`.
- Delegate noisy work (test suites, builds, wide searches) to the `tester` or `researcher` sub-agents; they
  return summaries.
- Do not re-read a file you just edited; trust the edit result.
- Batch related edits in one pass instead of many tiny ones.
- In conserve mode, pick verification and small fixes; leave heavy design work for accounts in spend mode.

Never trade correctness for tokens: skipping a test or a review is not thrift, it is debt.
