---
name: create-skill
description: Turn a technique that worked into a reusable skill that every future team gets automatically. Use when you solved something in a way others will need again.
---

# Create a skill for future teams

Skills live in `~/.crew/skills/skills/<skill-name>/SKILL.md` (the folder is loaded into every agent at the
start of each run).

1. Pick a short, lowercase, hyphenated name that says what it does (`deploy-static-site`, `seed-test-data`).
2. Write `SKILL.md`:

   ```markdown
   ---
   name: <skill-name>
   description: <what it does> Use when <the situation that should trigger it>.
   ---

   # <Title>

   <The steps, commands and pitfalls, as short as possible. Explain why where it matters.>
   ```

3. Put any helper script next to it and refer to it as `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/<file>`.
4. Test the steps once yourself.
5. Tell the team in the chat (one line) and add a lesson with team_lesson_add pointing to the skill.

Keep skills general (no project-specific paths or secrets).
