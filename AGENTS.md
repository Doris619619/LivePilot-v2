# LivePilot v2

This is a new, independent single-machine MVP. Never modify or import the complete old LivePilot repository.

Before changing Next.js code, read relevant guides under node_modules/next/dist/docs/. Use the installed documentation, not assumptions about older versions.

Keep one Windows machine, one dedicated Portable OBS, one channel, LIVE / VIDEO / MUSIC. Keep secrets server-only. No FFmpeg worker, Job/Run platform, multi-instance implementation or remote agent.

Never perform a real broadcast or OAuth consent as a test without the user completing/authorizing that step. Unit tests and local HTTP checks are not evidence of real streaming.

Run npm run verify before delivery. Document actual validation and untested live integration honestly. Do not log raw OAuth, OBS or YouTube requests/errors.
