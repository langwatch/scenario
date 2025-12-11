## Wait for CI and Fix Failures

Execute this workflow after pushing to a PR branch.

### Step 1: Run the CI Wait Script

```bash
./scripts/ci-wait.sh
```

Use `timeout: 660000` (11 min) and `required_permissions: ["network"]`.

**Exit codes:**
- `0` = All workflows passed → Done
- `1` = One or more workflows failed → Continue to Step 2
- `2` = Timeout → Report to user, ask how to proceed

### Step 2: Fetch Failed Logs

For each failed workflow from the script output:

```bash
gh run view <databaseId> --log-failed
```

### Step 3: Analyze and Fix

1. Parse the log output to identify the root cause (test failure, lint error, type error, build error)
2. Locate the relevant file(s) and line(s)
3. Apply the minimal fix
4. Commit with message: `fix: resolve CI failure - <brief description>`

### Step 4: Push and Retry

```bash
git push
```

Return to Step 1. Maximum 3 retry attempts before stopping and reporting to user.

### Constraints

- Do not introduce new functionality while fixing
- Keep fixes minimal and focused on the specific failure
- If the failure is unclear or requires design decisions, stop and ask the user
