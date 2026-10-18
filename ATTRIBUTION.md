# Attribution / 署名与来源

## Original project / 原项目

| | |
|---|---|
| Project / 项目 | **dsh-purge** — DeepSeek Harness cybersecurity red-team tool |
| Original author / 原作者 | **小杨** (GitHub: [@YuJunZhiXue](https://github.com/YuJunZhiXue)) |
| Original repository / 原仓库 | https://github.com/YuJunZhiXue/dsh-purge |
| License / 许可证 | MIT — see [LICENSE](LICENSE); the original copyright notice is preserved unchanged. |

All original code, prompts, rule sets, documentation, artwork and other assets in this repository were created by the original author. **All credit for the original work belongs to 小杨 / YuJunZhiXue.**

This repository is an **unofficial community fork** maintained to keep the plugin usable on newer DSH builds. It is **not affiliated with, sponsored by, or endorsed by** the original author.

## This fork / 本分支

| | |
|---|---|
| Repository / 仓库 | https://github.com/wutao1752036681/dsh-purge-community |
| Maintainer of the changes / 改动维护者 | [@wutao1752036681](https://github.com/wutao1752036681) |
| Base / 基线 | upstream `dsh-purge` 1.1.71 (commit `6c1d638`) |
| Purpose / 目的 | DSH **0.2.1-rc.2** compatibility fixes while upstream maintenance is paused. |

### Changes from upstream / 相对上游的改动

1. **Prompt variable `cwd` — DSH 0.2.1-rc.2**
   - Upstream symptom: `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model` — every turn aborted before the model ran.
   - rc.2 no longer registers the `cwd` prompt variable (the working directory moved to the `working-directory:current` runtime context).
   - Fix: register a `cwd` prompt variable from the deployment plugin (tolerating hosts that already register it), and emit the persona suffix with the literal absolute path and `interpolate: false`.
   - Files: `lib/index.js`, `lib/identity.js`, `cordis.patch.yml`.

2. **`COMPLETE_PROMPT_KEEP_INJECT` host patch — DSH 0.2.1-rc.2**
   - Upstream symptom: Apply failed with `清洗没有写进全部宿主，已取消重启`; the host never received the `[dsh-purge] complete prompt keeps inject` marker.
   - rc.2's `assemble()` computes `requiredContexts` before the complete-section branch and filters contexts with it; the old patch pattern expected `contexts: runtimeContextSuppressed ? [] : transformed.contexts` and missed.
   - Fix: add an rc.2-shaped pattern that preserves `requiredContexts` filtering.
   - File: `lib/core.js` (patch #40).

3. **Metadata**
   - `package.json`: version `1.1.73`, `dshTarget: 0.2.1-rc.2`, repository/homepage/install URLs point at this fork.

No other upstream behavior was intentionally changed. If you redistribute this fork or build on it, keep the original author's credit and the MIT copyright notice.

## 原项目（中文）

- 原项目：**dsh-purge**（DeepSeek Harness 网络安全红队工具）
- 原作者：**小杨**（GitHub：[@YuJunZhiXue](https://github.com/YuJunZhiXue)）
- 原仓库：https://github.com/YuJunZhiXue/dsh-purge
- 许可证：MIT（见 [LICENSE](LICENSE)，原始版权声明原样保留）

本仓库中的原始代码、提示词、规则集、文档、美术资源等均由原作者创作，**原始成果的全部署名归 小杨 / YuJunZhiXue 所有**。本仓库是非官方社区分支，仅用于在新版 DSH 上继续可用，与原作者无隶属、赞助或背书关系。

相对上游只做了上述 3 处兼容性修改；二次分发或二开时请保留原作者署名与 MIT 版权声明。
