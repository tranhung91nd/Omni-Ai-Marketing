# Zalo Agent Web

Work lean by default.

- Answer in concise Vietnamese.
- Inspect only files and ranges relevant to the request; prefer targeted `rg` and `sed`.
- Exclude `node_modules`, SQLite data files, logs, and generated directories from exploration unless explicitly needed.
- Do not repeat prior analysis or dump long command output; report results briefly.
- Keep changes narrowly scoped and reuse existing patterns.
- For UI-only work, run syntax checks on touched JavaScript and verify served assets after deployment.
- For sending logic, auto-reply safety, authentication, database migrations, or production incidents, investigate and test more deeply before deploying.
- Deploy only changes requested for the live website, then verify PM2 status without triggering real sends.
