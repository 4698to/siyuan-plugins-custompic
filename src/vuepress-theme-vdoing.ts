import { fetchSyncPost } from "siyuan";

export type ProcessedMarkdownResult = { content: string; title: string } | null;

/** 格式化为 `2021-09-13 14:29:53`（本地时区） */
function formatLocalDateTime(dt: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

/** 思源 ial.updated 常见为 14 位 yyyyMMddHHmmss，不能交给 Date 直接解析 */
function siyuanUpdatedToIso(updated: string | undefined): string {
	const s = (updated ?? "").trim();
	if (/^\d{14}$/.test(s)) {
		const y = +s.slice(0, 4);
		const mo = +s.slice(4, 6) - 1;
		const d = +s.slice(6, 8);
		const h = +s.slice(8, 10);
		const mi = +s.slice(10, 12);
		const se = +s.slice(12, 14);
		const dt = new Date(y, mo, d, h, mi, se);
		return Number.isNaN(dt.getTime()) ? formatLocalDateTime(new Date()) : formatLocalDateTime(dt);
	}
	const t = Date.parse(s);
	if (!Number.isNaN(t)) {
		return formatLocalDateTime(new Date(t));
	}
	return formatLocalDateTime(new Date());
}

/** 生成合法 YAML 标量（必要时用 JSON 双引号转义） */
function yamlQuoteScalar(v: string): string {
	if (!v) {
		return '""';
	}
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
		return JSON.stringify(v);
	}
	if (/[\n"#]/.test(v) || v !== v.trim() || /: /.test(v)) {
		return JSON.stringify(v);
	}
	return v;
}

function yamlStringList(key: string, items: string[]): string {
	if (!items.length) {
		return `${key}: []\n`;
	}
	return `${key}:\n${items.map((x) => `  - ${yamlQuoteScalar(x)}`).join("\n")}\n`;
}

/**
 * 根据 getDocInfo + 文档路径生成 VuePress 风格 front matter。
 * 失败时返回空字符串（调用方需判断）。
 */
async function buildDocFrontMatter(docId: string): Promise<{
	front_matter: string;
	title: string;
	date: string;
	permalink: string;
	categories: string[];
	tags: string[];
}> {
	const docInfo = (await fetchSyncPost("/api/block/getDocInfo", { id: docId })) as any;
	if (docInfo?.code !== 0 || !docInfo?.data) {
		return { front_matter: "", title: "", date: "", permalink: "", categories: [], tags: [] };
	}
	const data = docInfo.data;
	const ial = data.ial ?? {};
	const title = String(data.name ?? ial.title ?? "").trim();
	const datetimeStr = siyuanUpdatedToIso(ial.updated);
	const permalink = data.rootID || docId;

	let fullHPath = "";
	let pathRes = (await fetchSyncPost("/api/filetree/getFullHPathByID", { id: docId })) as any;
	if (pathRes?.code !== 0) {
		pathRes = (await fetchSyncPost("/api/filetree/getHPathByID", { id: docId })) as any;
	}
	if (pathRes?.code === 0 && pathRes.data != null) {
		fullHPath = typeof pathRes.data === "string" ? pathRes.data : "";
	}

	const segments = fullHPath.split("/").map((p) => p.trim()).filter(Boolean);
	const categorySegments = segments.slice(0, -1);

	const tagsRaw = ial.tags;
	const tags =
		typeof tagsRaw === "string"
			? tagsRaw.split(/[\s,，、]+/).map((t) => t.trim()).filter(Boolean)
			: [];

	const categoriesYaml = yamlStringList("categories", categorySegments);
	let tagsYaml = yamlStringList("tags", tags);
	if (tags.length === 0) {
		tagsYaml = "";
	}
	//思源笔记风格的 front matter 格式
	const front_matter = `---
title: ${yamlQuoteScalar(title)}
date: ${yamlQuoteScalar(datetimeStr)}
permalink: /pages/${permalink}
${categoriesYaml}${tagsYaml}---
`;
	return { front_matter, title, date: datetimeStr, permalink, categories: categorySegments, tags };
}

/**
 * 根据 传入的md内容，，修改 <video>内容 。
 * <video src="" controls="controls"></video>
 * 改成：
 * <video src="" controls="controls" style="width: 860px;"></video>
 * 失败时返回空字符串（调用方需判断）。
 */
export async function buildDocVideoContent(body: string): Promise<string> {
	try {
		if (!body) {
			return "";
		}
		const newBody = body.replace(/<video\b[^>]*>/gi, (tag) => {
			// 已含 style：补充/覆盖 width: 860px；
			if (/\bstyle\s*=/i.test(tag)) {
				return tag.replace(
					/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
					(_m, quote: string, styleValue: string) => {
						const withoutWidth = styleValue
							.replace(/(?:^|;)\s*width\s*:[^;]*;?/gi, "")
							.trim()
							.replace(/;+\s*$/g, "");
						const merged = withoutWidth ? `${withoutWidth}; width: 860px;` : "width: 860px;";
						return `style=${quote}${merged}${quote}`;
					},
				);
			}
			// 未含 style：直接添加
			return tag.replace(/>$/, ' style="width: 860px;">');
		});
		return newBody;
	} catch {
		return "";
	}
}
/**
 * 若文档中第一个代码块是思源笔记风格的 front matter（内容以 --- 开头和结尾），
 * 则去掉代码块围栏并把 front matter 移到文档开头，返回 { front_matter, body }；否则返回 null。
 */
function extractCodeBlockFrontMatter(raw: string): { front_matter: string; body: string } | null {
	const m = raw.match(/```[^\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*\r?\n?/);
	if (!m) {
		return null;
	}
	const inner = m[1];
	if (!/^---\s*\r?\n[\s\S]*?\r?\n---\s*$/.test(inner)) {
		return null;
	}
	// 去掉代码块围栏，并把 front matter 移到文档开头（前面可能有文档标题等内容）
	const before = raw.slice(0, m.index ?? 0).replace(/\s+$/, "");
	const after = raw.slice((m.index ?? 0) + m[0].length).replace(/^\s+/, "");
	const body = before ? `${before}\n\n${after}` : after;
	return { front_matter: `${inner}\n`, body };
}

type FrontMatterField =
	| { key: string; kind: "scalar"; value: string }
	| { key: string; kind: "list"; value: string[] }
	| { key: string; kind: "raw"; value: string };

/** 解析 front matter 的简单 YAML：标量、缩进列表、嵌套结构（嵌套结构原样保留） */
function parseFrontMatterFields(content: string): FrontMatterField[] {
	const fields: FrontMatterField[] = [];
	const lines = content.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ") || trimmed === "---") {
			i++;
			continue;
		}
		const m = line.match(/^([^:]+):\s*(.*)$/);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1].trim();
		const rest = m[2].trim();
		i++;
		// 收集该字段后续的缩进行
		const body: string[] = [];
		while (i < lines.length) {
			const next = lines[i];
			if (/^\s+\S/.test(next) || /^\s*$/.test(next)) {
				body.push(next);
				i++;
			} else {
				break;
			}
		}
		if (rest !== "") {
			fields.push({ key, kind: "scalar", value: unquoteYamlScalar(rest) });
		} else {
			const nonEmpty = body.filter((l) => l.trim() !== "");
			const allList = nonEmpty.length > 0 && nonEmpty.every((l) => l.trim().startsWith("- "));
			if (allList) {
				fields.push({
					key,
					kind: "list",
					value: nonEmpty.map((l) => unquoteYamlScalar(l.trim().slice(2).trim())),
				});
			} else {
				fields.push({ key, kind: "raw", value: [line, ...body].join("\n") });
			}
		}
	}
	return fields;
}

/** 去掉 YAML 标量的引号 */
function unquoteYamlScalar(v: string): string {
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** 数组去重（保持顺序） */
function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

/**
 * 合并代码块 front matter 与自动生成的 front matter：
 * title/date 用自动生成的，permalink 用代码块的（缺失则用生成的），categories/tags 合并去重，其余字段保留代码块的。
 */
function mergeFrontMatter(
	fields: FrontMatterField[],
	gen: { title: string; date: string; permalink: string; categories: string[]; tags: string[] },
): string {
	const lines: string[] = [];
	lines.push(`title: ${yamlQuoteScalar(gen.title)}`);
	lines.push(`date: ${yamlQuoteScalar(gen.date)}`);
	const cbPermalink = fields.find((f) => f.key === "permalink" && f.kind === "scalar");
	lines.push(`permalink: ${yamlQuoteScalar(cbPermalink && cbPermalink.kind === "scalar" ? cbPermalink.value : gen.permalink)}`);
	const cbCats = fields.find((f) => f.key === "categories");
	const cbCatsArr = cbCats && cbCats.kind === "list" ? cbCats.value : cbCats && cbCats.kind === "scalar" ? [cbCats.value] : [];
	lines.push(yamlStringList("categories", dedupe([...cbCatsArr, ...gen.categories])).trimEnd());
	const cbTags = fields.find((f) => f.key === "tags");
	const cbTagsArr = cbTags && cbTags.kind === "list" ? cbTags.value : cbTags && cbTags.kind === "scalar" ? [cbTags.value] : [];
	const mergedTags = dedupe([...cbTagsArr, ...gen.tags]);
	if (mergedTags.length > 0) {
		lines.push(yamlStringList("tags", mergedTags).trimEnd());
	}
	for (const f of fields) {
		if (f.key === "title" || f.key === "date" || f.key === "permalink" || f.key === "categories" || f.key === "tags") {
			continue;
		}
		if (f.kind === "scalar") {
			lines.push(`${f.key}: ${yamlQuoteScalar(f.value)}`);
		} else if (f.kind === "list") {
			lines.push(yamlStringList(f.key, f.value).trimEnd());
		} else {
			lines.push(f.value);
		}
	}
	return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * 若导出内容开头的第一个代码块是思源笔记风格的 front matter，则去掉代码块围栏并与自动生成的 front matter 合并；
 * 否则去掉开头的 YAML front matter，再前置 buildDocFrontMatter 生成的新 front matter。
 */
export async function processMarkdownContent(data: any, docId: string): Promise<ProcessedMarkdownResult> {
	const raw = typeof data?.content === "string" ? data.content : "";
	if (!raw) {
		return null;
	}
	// 文档开头的第一个代码块是思源笔记风格的 front matter：去掉代码块围栏，与自动生成的 front matter 合并
	const codeBlockFront = extractCodeBlockFrontMatter(raw);
	if (codeBlockFront) {
		// 去掉正文开头可能残留的普通 front matter
		const body = codeBlockFront.body.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
		const newBody = await buildDocVideoContent(body);
		const finalBody = newBody || body;
		const sep = finalBody.startsWith("\n") || finalBody === "" ? "" : "\n";
		const front = await buildDocFrontMatter(docId);
		if (!front.front_matter) {
			return { content: `${codeBlockFront.front_matter}${sep}${finalBody}`, title: front.title };
		}
		const codeBlockFields = parseFrontMatterFields(codeBlockFront.front_matter);
		const mergedFrontMatter = mergeFrontMatter(codeBlockFields, front);
		return { content: `${mergedFrontMatter}${sep}${finalBody}`, title: front.title };
	}
	const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
	const front = await buildDocFrontMatter(docId);
	if (!front.front_matter) {
		return { content: body, title: front.title };
	}
	const newBody = await buildDocVideoContent(body);
	const finalBody = newBody || body;
	const sep = finalBody.startsWith("\n") || finalBody === "" ? "" : "\n";
	return { content: `${front.front_matter}${sep}${finalBody}`, title: front.title };
}

export function safeMdFileBaseName(title: string, id: string): string {
	const raw = title && title.trim() ? title.trim() : id;
	const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
	return cleaned || id;
}

export function pickUniqueMdFileName(base: string, used: Set<string>): string {
	let stem = base.slice(0, 180);
	if (!stem) {
		stem = "untitled";
	}
	let name = `${stem}.md`;
	let n = 2;
	while (used.has(name)) {
		name = `${stem}_${n}.md`;
		n++;
	}
	used.add(name);
	return name;
}
