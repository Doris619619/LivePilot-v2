<!-- 文件用途：定义本项目开发边界、协作规范与验证要求。 -->
# LivePilot v2

This is an independent control service on one Windows broadcast machine, accessible by authenticated remote browsers. Never modify or import the complete old LivePilot repository.

Before changing Next.js code, read relevant guides under node_modules/next/dist/docs/. Use the installed documentation, not assumptions about older versions.

Keep one Windows broadcast machine, multiple dedicated Portable OBS instances, one distinct channel per instance, LIVE / VIDEO / MUSIC. Members share control permissions; uploads land on this machine before playback. Keep secrets server-only. No FFmpeg worker, Job/Run platform or remote agent. Preserve main legacy configuration and authorization. Read docs/工程协作规范.md and docs/PR撰写规范.md before changes; follow their branch, commit, documentation and PR formats.

Never perform a real broadcast or OAuth consent as a test without the user completing/authorizing that step. Unit tests and local HTTP checks are not evidence of real streaming.

Run npm run verify before delivery. Document actual validation and untested live integration honestly. Do not log raw OAuth, OBS or YouTube requests/errors.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
