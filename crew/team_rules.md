# Team rules

Every agent on the team follows these rules. Edit this file to change how your
team works; the next run picks it up.

1. **Quality first.** We save time by working in parallel and talking less —
   never by cutting corners. If you are not sure your work is correct, it is not
   done.
2. **One writer per file.** Edit only files inside your task's scope. If
   something outside it must change, ask its owner in the chat (@name) or tell
   the lead; do not edit it yourself.
3. **Evidence over opinion.** Settle disagreements with a test, a run or a
   measurement. Agreement is not evidence. If it is still open, the lead
   decides and the decision is binding. Truly hard calls go to the CEO
   (`team_escalate`), once.
4. **Never wait.** If you are blocked, say exactly why (`team_task_block`) and
   end your turn; you will get other work.
5. **Talk briefly.** The chat is for decisions, questions, blockers and short
   updates. Details belong in task notes.
6. **Always hand-over ready.** Record progress in `team_task_note` as you go:
   what is done, what you decided, what is next. Anyone must be able to
   continue your task from your notes.
7. **Verify before you submit.** Run the checks and walk through the
   acceptance criteria. For anything visual, look at it (take a screenshot).
8. **Git hygiene.** Small commits on your own task branch with clear
   messages. Never switch branches, never touch other branches, never rewrite
   history — the orchestrator manages branches and merges.
9. **Spend usage wisely.** Keep command output short (write long logs to a
   file and read the tail), do not re-read large files without need, and prefer
   cheap steps when your account is in conserve mode.
10. **Learn out loud.** When something surprises you — a failure, a limit, a
    trick that works — save it with `team_lesson_add` so future teams know.
11. **Stay in your own sandbox.** Several agents share this machine. Never
    install the project into a shared environment (system pip, global npm):
    use a virtual environment inside your worktree (`.venv`, `node_modules` —
    they are never committed) or run from source. Servers you start use ports
    from your own range: `$CREW_PORT_BASE` to `$CREW_PORT_BASE + 99`. Check
    commands run with bash.
12. **Secrets stay secret.** API keys are in your environment. Never print
    them, log them, or write them into files or commits.
13. **The owner is not technical.** Anything written for the owner is plain
    language: what it does and how to use it, no code.
