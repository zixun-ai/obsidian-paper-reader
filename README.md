# Paper Reader

[中文说明](#中文说明)

Read PDF papers, annotate passages, draw ink, and export linked Markdown notes in Obsidian. Optional AI translation, explanations, and questions work with your own OpenAI-compatible endpoint.

## Features

- Text highlights, underlines, wavy underlines, strikethroughs, and editable notes.
- Mouse ink with seven colors and three widths; select, recolor, or delete strokes.
- Session undo/redo, annotation sidebar, thumbnails, and document outline.
- Full-text search, saved reading position, zoom, continuous, single-page, and two-page layouts.
- Append-only Markdown export with links back to the PDF page and duplicate-export detection.
- Optional streaming AI assistance using your own API key.

## Install

Desktop only. Minimum Obsidian version: **1.13.7**. macOS is verified; Windows and Linux still need platform testing. Mobile support is not claimed.

Install **Paper Reader** from **Settings → Community plugins → Browse**, or use [Add to Obsidian](obsidian://show-plugin?id=paper-reader). For manual installation, download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/zixun-ai/obsidian-paper-reader/releases), put them in `<vault>/<config-dir>/plugins/paper-reader/` (the default config directory is `.obsidian`), then reload and enable the plugin. The PDF worker is embedded; no fourth file or runtime download is needed.

## Use

Right-click a PDF and select **Open in Paper Reader**, or open a PDF and use the **Open paper reader** command. Replacing the built-in PDF viewer is optional and disabled by default; that option uses an internal Obsidian API and may conflict with other PDF plugins.

Select text to annotate it. The pencil toggles ink mode; Escape exits. Use Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for undo/redo, and Cmd/Ctrl+F to search. The sidebar menu opens the annotation list, where you can export notes and return to source pages.

## Data and privacy

- Reading and annotation work offline. This plugin contains no telemetry or advertisements.
- Annotations are stored in a sibling `*.annotations.json` file; they are **not embedded in the PDF**. Exported notes are saved as sibling `*.notes.md` files. Back up these sidecars with your PDF.
- Reading positions and settings are stored in the plugin's `data.json`.
- Remote AI endpoints must use HTTPS; HTTP is allowed only for localhost, 127.0.0.1, and ::1. Before the first request in each reader window (and after changing endpoints), a confirmation explains the destination and data sent. Data goes directly to the configured provider, not a developer-operated relay.
- AI is optional. It requires an endpoint, model, and API key you supply. The provider may require an account and charge for usage. On an explicit AI action, selected text, configured surrounding context (which may include page text), questions, and conversation history are sent to that endpoint. The connection test also sends a request. Your provider's privacy terms apply.
- The API key is stored in plaintext in `data.json`, not a secure keychain. Vault synchronization or backups that include this file may copy it. Never publish it or attach it to a bug report.
- No access to files outside the vault is required for normal use.

## Limitations

- No OCR: image-only scans cannot be searched or selected as text.
- Ink has no pressure sensitivity, eraser, or shape recognition.
- Some PDFs with unusual text layers can have search-highlight offsets. Documents requiring supplementary PDF.js font/CMap/image resources may not render fully; report a reproducible, shareable sample.
- Undo history is per view/session and clears on reopen. Cross-vault back-links, simultaneous edits from multiple devices, and moved exported links are not guaranteed.
- Old `paper-reader://` links are unsupported; new exports use `obsidian://paper-reader`. Existing exported entries are not automatically migrated.

## Development

Use Node.js 24 and npm:

```sh
npm ci
npx playwright install chromium
npm run check
npm run dev
```

`npm run check` runs unit tests, a production build, and Chromium integration tests. Tests use an original synthetic PDF in `tests/fixtures/`; they need neither a personal vault nor an AI account. The browser harness exercises real rendering and annotation modules with mocked storage and AI. It is not a substitute for testing Obsidian itself. `npm run test:e2e -- /path/to/sample.pdf` can use a PDF matching the fixture's title strings for targeted regression checks.

GitHub Actions checks pushes and pull requests. A numeric tag matching `manifest.json` creates a draft release with the three required assets. Update `package.json`, `manifest.json`, and `versions.json` together when releasing.

## License and credits

Paper Reader is [MIT licensed](LICENSE). It bundles [Mozilla PDF.js](https://github.com/mozilla/pdf.js) under Apache-2.0; the license is included in [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt) and the distributed JavaScript. Obsidian is a trademark of its owners; this is an independent community project.

Report bugs using [GitHub Issues](https://github.com/zixun-ai/obsidian-paper-reader/issues). Include your OS, Obsidian/plugin versions, reproduction steps, and a non-sensitive sample if possible. Do not upload API keys or private papers.

## 中文说明

在 Obsidian 中阅读 PDF 论文，支持文字标注、批注、鼠标画笔、撤销重做、全文搜索、阅读位置恢复和带来源回跳的 Markdown 笔记导出。AI 翻译、解释和问答为可选功能，使用你自己的兼容接口和 API Key。

首版仅支持桌面，要求 Obsidian 1.13.7 或更新版本；已验证 macOS，Windows/Linux 尚待实测。可在 **设置 → 第三方插件 → 浏览** 中搜索 **Paper Reader** 安装。默认不接管内置 PDF 阅读器，可右键 PDF 选择 **Open in Paper Reader**。

标注单独保存在 PDF 旁的 `*.annotations.json`，不写入原 PDF；笔记导出到 `*.notes.md`。请一起备份。AI 操作会发送选中文字、配置的上下文和问答历史到你指定的接口，费用和数据处理由服务商决定。API Key 明文保存在插件 `data.json` 中，切勿公开上传。离线阅读无需 API，也没有遥测或广告。

目前不支持 OCR、压感、橡皮擦及形状识别。旧回跳协议不自动迁移；完整限制见上文。提交问题时请避免附上私人论文、标注或密钥。
