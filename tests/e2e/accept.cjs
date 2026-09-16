// Playwright acceptance: note add -> visible -> edit -> reload restore ->
// translate (mock SSE) -> insert notes.md
const { chromium } = require("playwright");

let failures = 0;
function check(label, cond, detail = "") {
	if (cond) console.log(`  PASS ${label}`);
	else {
		console.log(`  FAIL ${label} ${detail}`);
		failures++;
	}
}

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on("pageerror", (e) => { failures++; console.log("[pageerror]", e.message); });

	await page.goto(process.env.PR_TEST_URL || "http://127.0.0.1:8931/harness.html");
	// Load the actual three-file production bundle, then use its embedded worker.
	const bundledWorker = await page.evaluate(async () => {
		const urls = [];
		const original = URL.createObjectURL;
		URL.createObjectURL = function(blob) { const url = original.call(URL, blob); urls.push(url); return url; };
		class Plugin {
			constructor() { this.app = { vault: { on() {} }, workspace: { on() {} } }; }
			loadData() { return Promise.resolve(null); }
			register() {} registerView() {} registerEvent() {} addRibbonIcon() {}
			addCommand() {} addSettingTab() {} registerObsidianProtocolHandler() {}
		}
		const obsidian = { Plugin, PluginSettingTab: class {}, ItemView: class {}, Notice: class {}, Menu: class {} };
		const module = { exports: {} };
		try {
			const code = await (await fetch('/main.js')).text();
			new Function('require', 'module', 'exports', code)(name => {
				if(name !== 'obsidian') throw Error('Unexpected external dependency: '+name);
				return obsidian;
			}, module, module.exports);
			await new module.exports.default().onload();
			if (!urls.length) throw Error('Production bundle created no embedded worker');
			window.__h.useWorker(urls[0]);
			return urls[0].startsWith('blob:');
		} finally { URL.createObjectURL = original; }
	});
	check('三文件发布包加载并创建内嵌 Worker', bundledWorker);
	const numPages = await page.evaluate(() => window.__h.loadPdf());
	console.log(`PDF loaded, ${numPages} pages`);

	// 1) select one line of the title and add a note
	const payloadJson = await page.evaluate(() => {
		const p = window.__h.selectText("LandslideAgent", 0, 20);
		return { text: p.text, rects: p.rects.length, page: p.page };
	});
	check("选区生成 payload（单行）", payloadJson.rects === 1, JSON.stringify(payloadJson));

	const step1 = await page.evaluate(async () => {
		const p = window.__h.selectText("LandslideAgent", 0, 20);
		const id = await window.__h.addNote(p, "这是测试批注");
		return { id, ...window.__h.renderedNoteInfo() };
	});
	check("添加批注后页面可见（淡色矩形+图标）", step1.rects >= 1 && step1.icons === 1, JSON.stringify(step1));

	// 2) edit the note
	await page.evaluate(async (id) => window.__h.editNote(id, "编辑后的批注"), step1.id);
	const afterEdit = await page.evaluate(() => ({
		...window.__h.renderedNoteInfo(),
		saved: window.__h.adapter.files.get("05-论文/paper.annotations.json"),
	}));
	check("编辑批注后仍可见且已保存", afterEdit.rects >= 1 && afterEdit.saved.includes("编辑后的批注"));

	// 3) reload from disk (simulate close/reopen)
	const restored = await page.evaluate(() => window.__h.reloadFromDisk());
	check(
		"重开后批注从 JSON 恢复且渲染",
		restored.annotations >= 1 && restored.note === "编辑后的批注"
	);
	const afterReload = await page.evaluate(() => window.__h.renderedNoteInfo());
	check("重开后批注矩形/图标仍渲染", afterReload.rects >= 1 && afterReload.icons === 1);

	// Confirm the visible disclosure before the mocked AI request.
	page.once("dialog", async dialog => {
		check("AI 首次发送提示显示接收方和数据范围", dialog.type() === "confirm" &&
			dialog.message().includes("https://mock.local/v1/chat/completions") &&
			dialog.message().includes("对话历史") && dialog.message().includes("data.json"));
		await dialog.accept();
	});
	// 4) translate with mocked SSE
	const tr = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		const out = await window.__h.translate(p);
		return { out, anns: window.__h.data.annotations.length };
	});
	check("翻译流式返回 mock 译文", tr.out === "滑坡智能体", tr.out);
	check("翻译记录为 translation 标注", tr.anns >= 2);

	// 5) insert into notes.md
	const notes = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		return window.__h.insertNotes(p, "滑坡智能体");
	});
	console.log("---- notes.md ----\n" + notes + "\n------------------");
	check("notes.md 含 frontmatter", notes.includes('pdf: "[[paper.pdf]]"'));
	check("notes.md 含引用原文", notes.includes("> A Domain-Rule-A"));
	check("notes.md 含译文与页码", notes.includes("滑坡智能体") && notes.includes("p.1"));

	// Whole middle spans must not produce both element and text underlines.
	for (const scale of [0.75, 1.5, 3, 5]) {
		for (const reverse of [false, true]) {
			const count = await page.evaluate(({ scale, reverse }) => window.__h.underlineTitle(scale, reverse), { scale, reverse });
			check(`三行标题各一条下划线 scale=${scale} reverse=${reverse}`, count === 3, `lines=${count}`);
		}
	}

	// Existing annotations must not intercept a new native text selection.
	await page.evaluate(() => window.__h.underlineTitle(1.5, false));
	const titleSpan = page.locator(".textLayer span").filter({ hasText: "LandslideAgent" }).first();
	const titleBox = await titleSpan.boundingBox();
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	await page.mouse.move(titleBox.x + 10, titleBox.y + titleBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2, { steps: 8 });
	await page.mouse.up();
	const reselected = await page.evaluate(({ x, y }) => ({
		text: window.getSelection()?.toString() ?? "",
		hit: document.elementFromPoint(x, y)?.className ?? "",
		pointer: getComputedStyle(document.querySelector(".pr-highlight-rect")).pointerEvents,
	}), { x: titleBox.x + 10, y: titleBox.y + titleBox.height / 2 });
	check("已有下划线上仍可用鼠标重新选文", reselected.text.length > 0, JSON.stringify(reselected));
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	const underlineBox = await page.locator(".pr-highlight-rect").first().boundingBox();
	await page.mouse.click(underlineBox.x + underlineBox.width / 2, underlineBox.y + underlineBox.height / 2);
	const clickedHighlight = await page.evaluate(() => window.__h.lastHighlightClick());
	check("单击已有下划线仍能命中标注", !!clickedHighlight);

	// 6) pen stroke: draw -> persisted -> reload restores -> undo/redo
	const stroke = await page.evaluate(() => window.__h.drawStroke());
	check("画笔一笔生成一条笔迹路径", stroke.paths === 1, JSON.stringify(stroke));
	const inkRestored = await page.evaluate(async () => {
		await window.__h.reloadFromDisk();
		return window.__h.inkInfo();
	});
	check("重开后笔迹恢复", inkRestored.anns === 1 && inkRestored.paths === 1, JSON.stringify(inkRestored));

	const undoRedo = await page.evaluate(async () => {
		const r = {};
		await window.__h.history.undo();
		r.undoInfo = window.__h.inkInfo();
		await window.__h.history.redo();
		r.redoInfo = window.__h.inkInfo();
		return r;
	});
	check("撤销删除笔迹 / 重做恢复", undoRedo.undoInfo.anns === 0 && undoRedo.undoInfo.paths === 0 && undoRedo.redoInfo.anns === 1, JSON.stringify(undoRedo));

	const delUndo = await page.evaluate(async (noteId) => {
		const r = {};
		const before = window.__h.data.annotations.length;
		await window.__h.deleteAnnotation(noteId);
		r.afterDelete = window.__h.data.annotations.length;
		r.before = before;
		await window.__h.history.undo();
		r.afterUndo = window.__h.data.annotations.length;
		return r;
	}, step1.id);
	check("删除批注→撤销恢复", delUndo.afterDelete === delUndo.before - 1 && delUndo.afterUndo === delUndo.before, JSON.stringify(delUndo));

	// 7) full-text search incl. unvisited pages
	const search = await page.evaluate(async () => ({
		hit: await window.__h.searchAll("LandslideAgent"),
		miss: await window.__h.searchAll("zzzz-not-exist"),
	}));
	check("搜索命中且定位页码", search.hit.total >= 1 && search.hit.firstPage === 1, JSON.stringify(search.hit));
	check("无结果搜索返回 0", search.miss.total === 0);

	// 8) annotation list reflects current data
	const listInfo = await page.evaluate(() => ({
		...window.__h.buildAnnotationList(),
		anns: window.__h.data.annotations.length,
	}));
	check("标注列表条目数与标注一致", listInfo.items === listInfo.anns, JSON.stringify(listInfo));

	// 9) duplicate notes export is skipped (content-hash dedupe)
	const dup = await page.evaluate(async () => {
		const p = window.__h.selectText("Domain-Rule-Augmented", 0, 15);
		const first = await window.__h.insertNotes(p, "滑坡智能体");
		const second = await window.__h.insertNotes(p, "滑坡智能体");
		return { same: first === second, hasLink: second.includes("obsidian://paper-reader?file=") };
	});
	check("重复导出被跳过且含回链", dup.same && dup.hasLink, JSON.stringify(dup));

	const preview = await page.evaluate(() => {
		const ann = { ink: { width: 2, points: [10, 20, 30, 40] } };
		const svg = window.__inkPreview(ann, 120);
		const malicious = window.__inkPreview({ ink: { width: '2" onload="alert(1)', points: [0, 0] } });
		return {
			path: svg.querySelector("path").getAttribute("d"),
			size: svg.getAttribute("width"),
			exported: new DOMParser().parseFromString(svg.outerHTML, "image/svg+xml").querySelector("path") !== null,
			rejected: malicious === null,
		};
	});
	check("画笔预览与 SVG 导出保留路径、尺寸并拒绝无效数据", preview.path === "M 4 4 L 24 24" && preview.size === "120" && preview.exported && preview.rejected, JSON.stringify(preview));

	await browser.close();
	if (failures > 0) {
		console.log(`\nACCEPTANCE FAILED (${failures} failures)`);
		process.exit(1);
	}
	console.log("\nACCEPTANCE PASSED");
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
