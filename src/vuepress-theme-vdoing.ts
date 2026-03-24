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
async function buildDocFrontMatter(docId: string): Promise<{ front_matter: string; title: string }> {
	const docInfo = (await fetchSyncPost("/api/block/getDocInfo", { id: docId })) as any;
	if (docInfo?.code !== 0 || !docInfo?.data) {
		return { front_matter: "", title: "" };
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

	const front_matter = `---
title: ${yamlQuoteScalar(title)}
date: ${yamlQuoteScalar(datetimeStr)}
permalink: /pages/${permalink}
${categoriesYaml}${tagsYaml}---
`;
	return { front_matter, title };
}

/**
 * 去掉导出内容开头的 YAML front matter，再前置 buildDocFrontMatter 生成的新 front matter。
 */
export async function processMarkdownContent(data: any, docId: string): Promise<ProcessedMarkdownResult> {
	const raw = typeof data?.content === "string" ? data.content : "";
	if (!raw) {
		return null;
	}
	const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "");
	const front = await buildDocFrontMatter(docId);
	if (!front.front_matter) {
		return { content: body, title: front.title };
	}
	const sep = body.startsWith("\n") || body === "" ? "" : "\n";
	return { content: `${front.front_matter}${sep}${body}`, title: front.title };
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
