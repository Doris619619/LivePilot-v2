/** 兼容旧启动验收入口：当前布局与目标绑定由 readiness 覆盖，异步反馈由专用套件覆盖。 */
await import('./readiness-acceptance.mjs');
await import('./obs-startup-feedback-acceptance.mjs');
