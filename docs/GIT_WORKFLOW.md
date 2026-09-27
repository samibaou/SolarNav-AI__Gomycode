# Git workflow

```text
main      = stable demo
develop   = integrated work

feature/p1-data-twin
feature/p2-intelligence
feature/p3-decision-control
feature/p4-frontend
feature/p5-llm-api
```

## Start a feature

```bash
git checkout develop
git pull origin develop
git checkout -b feature/pX-name
```

## Sync daily

```bash
git checkout develop
git pull origin develop
git checkout feature/pX-name
git merge develop
```

Resolve conflicts early.

## Commit examples

```bash
git commit -m "feat(p2): improve solar power model"
git commit -m "fix(p3): compare optimizer candidates in Wh"
git commit -m "test(p1): add Digital Twin battery tests"
```

## Pull requests

Normal: `feature/... → develop`.
Stable milestone: `develop → main`.

Recommended: one reviewer, passing CI, no direct push to `main`, no API secrets committed.
