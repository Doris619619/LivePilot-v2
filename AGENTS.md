<!-- 文件用途：定义本项目开发边界、协作规范与验证要求。 -->
# LivePilot v2

This is an independent cloud/local control service with outbound Windows Agents, accessible by authenticated remote browsers. Never modify or import the complete old LivePilot repository.

Before changing Next.js code, read relevant guides under node_modules/next/dist/docs/. Use the installed documentation, not assumptions about older versions.

Support multiple Windows broadcast machines, each with dedicated Portable OBS instances, one distinct channel per instance globally, LIVE / VIDEO / MUSIC. Customers control only their assigned devices; administrators can view all devices and assist with audited operations; uploads land on the selected Agent before playback. Agents own complete broadcast operations and YouTube tokens; the cloud owns identity, delivery and status. Keep secrets out of browser DTOs. No cloud FFmpeg worker or general Job/Run platform. Publishing package audio preparation runs only inside the Agent PublishingRunner. Preserve main legacy configuration and authorization. Read docs/工程协作规范.md and docs/PR撰写规范.md before changes; follow their branch, commit, documentation and PR formats. For PR writing, use PR #4 as the structural reference defined in docs/PR撰写规范.md and the default .github/pull_request_template.md: keep all seven sections, bold topic groups, separate user behavior from implementation, and report evidence and deployment status accurately.

Never perform a real broadcast or OAuth consent as a test without the user completing/authorizing that step. Unit tests and local HTTP checks are not evidence of real streaming.

Run npm run verify before delivery. Document actual validation and untested live integration honestly. Do not log raw OAuth, OBS or YouTube requests/errors.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
