#!/usr/bin/env node
// 本地发版收尾：给已推送的 tag 建 GitHub Release（含 zip 资产）。
//
//   node scripts/create-release.mjs            # 用 package.json 的版本
//   node scripts/create-release.mjs 1.1.76 ... # 指定历史版本
//   node scripts/create-release.mjs 1.1.77 --force-notes   # 覆盖已有 release 的说明
//
// 说明文字取自 release-notes.md 里 "# <version>" 那一段。
// token 顺序：GH_TOKEN / GITHUB_TOKEN 环境变量 → git credential（Windows 凭据管理器里
// 存的那份 PAT）。只在本机使用，不落盘、不打印。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.DSH_PURGE_REPO || 'wutao1752036681/dsh-purge-community';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const args = process.argv.slice(2);
const forceNotes = args.includes('--force-notes');
const versions = args.filter((a) => !a.startsWith('-'));

function readToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const out = execFileSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
  });
  const hit = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('password='));
  if (!hit) throw new Error('找不到 GitHub 凭据：先设置 GH_TOKEN，或让 git 记住一次 PAT');
  return hit.slice('password='.length);
}

const TOKEN = readToken();

async function api(pathname, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-purge-release',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 保持文本 */ }
  return { status: res.status, body };
}

function notesFor(version) {
  const file = path.join(ROOT, 'release-notes.md');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `# ${version}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^# /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function buildZip(version, tag) {
  const out = path.join(os.tmpdir(), `dsh-purge-${version}.zip`);
  const ref = execFileSync('git', ['-C', ROOT, 'rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', ROOT, 'archive', '--format=zip', `--prefix=dsh-purge-${version}/`, `--output=${out}`, ref]);
  return out;
}

async function uploadAsset(tag, file) {
  const name = path.basename(file);
  const head = await api(`/releases/tags/${tag}`);
  const id = head.body && head.body.id;
  if (!id) return `no release ${tag}`;
  const existing = (head.body.assets || []).find((a) => a.name === name);
  if (existing) {
    await api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const url = `https://uploads.github.com/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/zip',
      'user-agent': 'dsh-purge-release',
    },
    body: fs.readFileSync(file),
  });
  return `${res.status} ${name}`;
}

if (!versions.length) {
  versions.push(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
}

const list = await api('/releases?per_page=100');
const existing = new Map((Array.isArray(list.body) ? list.body : []).map((r) => [r.tag_name, r]));

for (const ver of versions) {
  const version = String(ver).replace(/^v/, '');
  const tag = `v${version}`;
  const notes = notesFor(version);
  const have = existing.get(tag);
  if (have) {
    console.log(`${tag}: 已存在 ${have.html_url}`);
    if (forceNotes && notes) {
      const res = await api(`/releases/${have.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: notes }),
      });
      console.log(`  说明已更新 -> ${res.status}`);
    }
  } else {
    const res = await api('/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: `dsh-purge-community ${tag}`,
        body: notes || undefined,
        draft: false,
        prerelease: /\d(?:beta|alpha|rc)/i.test(version),
      }),
    });
    console.log(`${tag}: ${res.status} ${res.status === 201 ? res.body.html_url : JSON.stringify(res.body).slice(0, 200)}`);
  }
  try {
    const zip = buildZip(version, tag);
    console.log('  zip ->', await uploadAsset(tag, zip));
  } catch (e) {
    console.log('  zip 失败:', String(e && e.message).slice(0, 160));
  }
}
