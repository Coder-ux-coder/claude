"""Git mechanics. Only the orchestrator calls these; agents never switch branches or merge.

Layout of a run (all branches live in the user's repository):
  crew/<run>               integration branch (starts at the user's current commit)
  crew/<run>/task-<id>     one branch per task
  <run>/worktrees/<seat>   one worktree per seat, re-pointed to each new task branch
  <run>/worktrees/_main    the integration worktree where merges and checks happen
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .util import clip, tail


class GitError(RuntimeError):
    pass


def git(cwd: Path, *args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    proc = subprocess.run(["git", *args], cwd=str(cwd), env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    if check and proc.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {clip(proc.stderr or proc.stdout, 1500)}")
    return proc


def out(cwd: Path, *args: str) -> str:
    return git(cwd, *args).stdout.strip()


def ensure_repo(path: Path) -> Path:
    """Make `path` a git repository with at least one commit; return its top level."""
    path.mkdir(parents=True, exist_ok=True)
    probe = git(path, "rev-parse", "--show-toplevel", check=False)
    if probe.returncode != 0:
        git(path, "init", "-q")
        probe = git(path, "rev-parse", "--show-toplevel")
    top = Path(probe.stdout.strip())
    _ensure_identity(top)
    ensure_excludes(top)
    if git(top, "rev-parse", "--verify", "HEAD", check=False).returncode != 0:
        git(top, "commit", "-q", "--allow-empty", "-m", "Start of project")
    return top


JUNK = """# Added by Crew: build artifacts that must never be committed by agents or merged.
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
*.egg-info/
.venv/
venv/
node_modules/
.next/
.nuxt/
.turbo/
.parcel-cache/
.cache/
.gradle/
.DS_Store
Thumbs.db
"""


def ensure_excludes(repo: Path) -> None:
    """Keep build junk out of every worktree's commits without touching the user's tracked files."""
    common = Path(out(repo, "rev-parse", "--git-common-dir"))
    if not common.is_absolute():
        common = (repo / common).resolve()
    exclude = common / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    current = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    if "Added by Crew" not in current:
        exclude.write_text(current.rstrip("\n") + "\n\n" + JUNK, encoding="utf-8")


def clean_worktree(path: Path) -> None:
    """Throw away anything uncommitted (e.g. check-run artifacts) in an orchestrator-owned worktree."""
    git(path, "reset", "-q", "--hard", check=False)
    git(path, "clean", "-fdq", check=False)


def _ensure_identity(repo: Path) -> None:
    if not git(repo, "config", "user.email", check=False).stdout.strip():
        git(repo, "config", "user.email", "crew@localhost")
    if not git(repo, "config", "user.name", check=False).stdout.strip():
        git(repo, "config", "user.name", "Crew")


def clone(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    git(dest.parent, "clone", "-q", url, str(dest), timeout=1800)
    return ensure_repo(dest)


def current_branch(repo: Path) -> str:
    name = git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    return name if name != "HEAD" else out(repo, "rev-parse", "HEAD")


def is_dirty(path: Path) -> bool:
    return bool(git(path, "status", "--porcelain").stdout.strip())


def add_worktree(repo: Path, path: Path, branch: str, base: str) -> None:
    if path.exists():
        if (path / ".git").exists():
            return
        shutil.rmtree(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = git(repo, "rev-parse", "--verify", f"refs/heads/{branch}", check=False).returncode == 0
    if exists:
        git(repo, "worktree", "add", "-f", str(path), branch)
    else:
        git(repo, "worktree", "add", "-f", "-b", branch, str(path), base)


def remove_worktree(repo: Path, path: Path) -> None:
    git(repo, "worktree", "remove", "--force", str(path), check=False)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    git(repo, "worktree", "prune", check=False)


def commit_all(path: Path, message: str) -> bool:
    """Commit everything in a worktree. Returns True if a commit was made."""
    git(path, "add", "-A")
    if git(path, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return False
    git(path, "commit", "-q", "--no-verify", "-m", message)
    return True


def is_ancestor(path: Path, older: str, newer: str) -> bool:
    return git(path, "merge-base", "--is-ancestor", older, newer, check=False).returncode == 0


def checkout_task(worktree: Path, branch: str, base: str) -> None:
    """Point a seat's worktree at a task branch. New branches start from `base`.

    Work an agent did before the task was formally assigned (on the detached starting point) is carried
    onto the new branch rather than left behind.
    """
    exists = git(worktree, "rev-parse", "--verify", f"refs/heads/{branch}", check=False).returncode == 0
    detached = git(worktree, "rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip() == "HEAD"
    if detached and not exists:
        ahead = head(worktree) != out(worktree, "rev-parse", base)
        if is_dirty(worktree) or (ahead and not is_ancestor(worktree, "HEAD", base)):
            git(worktree, "checkout", "-q", "-b", branch)  # keeps uncommitted changes in place
            commit_all(worktree, "Work started before the task was assigned")
            if not is_ancestor(worktree, base, "HEAD"):
                if git(worktree, "merge", "--no-edit", base, check=False).returncode != 0:
                    git(worktree, "merge", "--abort", check=False)  # the merge step will surface the conflict
            return
    if is_dirty(worktree):
        commit_all(worktree, "crew: save unsubmitted work before switching task")
    if exists:
        git(worktree, "checkout", "-q", branch)
    else:
        git(worktree, "checkout", "-q", "-b", branch, base)


def park_worktree(worktree: Path, name: str) -> None:
    """Detach a seat's worktree so a task branch can be checked out elsewhere."""
    if is_dirty(worktree):
        commit_all(worktree, "crew: save work before handing the task over")
    git(worktree, "checkout", "-q", "--detach", check=False)


def changed_files(repo: Path, base: str, branch: str) -> list[str]:
    text = git(repo, "diff", "--name-only", f"{base}...{branch}", check=False).stdout
    return [line for line in text.splitlines() if line.strip()]


def diffstat(repo: Path, base: str, branch: str) -> str:
    return git(repo, "diff", "--stat", f"{base}...{branch}", check=False).stdout.strip()


@dataclass
class MergeResult:
    ok: bool
    conflicts: list[str]
    message: str = ""

    @property
    def is_conflict(self) -> bool:
        return bool(self.conflicts)


def merge_into(main_wt: Path, branch: str, message: str) -> MergeResult:
    """Merge a task branch into the integration worktree (no fast-forward, so it can be reverted).

    The worktree is cleaned first so leftovers from earlier check runs can never block a merge.
    A failure that is not a content conflict is retried once after another clean.
    """
    for attempt in range(2):
        clean_worktree(main_wt)
        proc = git(main_wt, "merge", "--no-ff", "--no-edit", "-m", message, branch, check=False)
        if proc.returncode == 0:
            return MergeResult(True, [])
        conflicts = git(main_wt, "diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
        git(main_wt, "merge", "--abort", check=False)
        if conflicts:
            return MergeResult(False, conflicts, clip(proc.stdout + proc.stderr, 2000))
    clean_worktree(main_wt)
    return MergeResult(False, [], clip(proc.stdout + proc.stderr, 2000))


def revert_last_merge(main_wt: Path, reason: str) -> None:
    git(main_wt, "revert", "--no-edit", "-m", "1", "HEAD")
    git(main_wt, "commit", "-q", "--amend", "-m", f"crew: revert merge — {reason}", check=False)


def head(path: Path) -> str:
    return out(path, "rev-parse", "HEAD")


@dataclass
class CheckResult:
    ok: bool
    summary: str
    log_path: Path | None = None
    ran: bool = True


def run_checks(cwd: Path, commands: list[str], log_path: Path, timeout_s: float, env: dict | None = None) -> CheckResult:
    """Run the project's verification commands; full output to a file, a short tail back."""
    if not commands:
        return CheckResult(True, "no checks configured", None, ran=False)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    chunks: list[str] = []
    ok = True
    bash = shutil.which("bash") if os.name != "nt" else None  # agents write bash; /bin/sh may be dash
    for cmd in commands:
        try:
            argv = [bash, "-c", cmd] if bash else cmd
            proc = subprocess.run(argv, cwd=str(cwd), shell=not bash, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=timeout_s, env=env)
            output, code = (proc.stdout or "") + (proc.stderr or ""), proc.returncode
        except subprocess.TimeoutExpired as exc:
            output = ((exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""))
            output += f"\n[timed out after {int(timeout_s)}s]"
            code = 124
        chunks.append(f"$ {cmd}\n{output}\n[exit {code}]\n")
        if code != 0:
            ok = False
            break
    text = "\n".join(chunks)
    log_path.write_text(text, encoding="utf-8")
    return CheckResult(ok, tail(text, 40, 3000), log_path)
