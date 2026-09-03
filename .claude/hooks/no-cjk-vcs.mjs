#!/usr/bin/env node
// Blocks git commit / gh pr create|edit when the message carries CJK text.
//
// Why this exists as a hook and not as a line in CLAUDE.md: the "commits and PRs are English"
// rule drifted at least five times (PR #95, #97, #98, #110, and again 2026-09) *while the rule
// was already written down*. A reminder cannot gate a tool call; a PreToolUse hook can.
//
// Escape hatch: put NW_ALLOW_CJK=1 anywhere in the command.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/;
// Commands whose payload ends up in git history or on GitHub.
const GUARDED = /(^|[;&|]\s*|\s)(git\s+(commit|tag)\b|gh\s+(pr|release)\s+(create|edit)\b)/;
const FILE_ARGS = /(?:--body-file|--file|-F|-m|--message|--body|--notes-file)[= ]\s*/;

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let payload;
try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

const cmd = payload?.tool_input?.command;
if (typeof cmd !== 'string' || !GUARDED.test(cmd)) process.exit(0);
if (cmd.includes('NW_ALLOW_CJK=1')) process.exit(0);

// Scan the command itself, plus any file the command feeds a message/body from.
const parts = [cmd];
for (const m of cmd.matchAll(/(?:--body-file|--file|--notes-file|-F)[=\s]+(['"]?)([^'"\s]+)\1/g)) {
  try { parts.push(readFileSync(resolve(m[2]), 'utf8')); } catch { /* unreadable: command text alone */ }
}

const hit = parts.join('\n').match(CJK);
if (!hit) process.exit(0);

const found = [...new Set(parts.join('\n').match(new RegExp(CJK.source, 'g')))].slice(0, 12).join('');
process.stderr.write(
  `阻止：commit message / PR 文本里有中文（${found}…）。\n` +
  `本仓库约定：代码、注释、commit message、PR 标题与正文一律英文；只有 design/ 与 claudedocs/ 文档用中文。\n` +
  `改法：把这段话重写成英文再跑同一条命令。已经提交的用 git commit --amend / gh pr edit --body-file 修。\n` +
  `确实必须带中文（例如引用 i18n 字面量）时，在命令里加 NW_ALLOW_CJK=1。\n`,
);
process.exit(2);
