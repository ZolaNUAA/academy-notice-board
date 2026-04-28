import type { CategoryMeta, Notice, NoticeType } from "./types";

export const CATEGORY_RULES: CategoryMeta[] = [
  { key: "research", name: "科研", className: "cat-research", bgColor: "#fff5b3", kws: ["科研", "基金", "申报", "科技厅", "项目", "学术", "讲坛", "省科技厅", "基础研究"] },
  { key: "teaching", name: "教学", className: "cat-teaching", bgColor: "#ffe3c2", kws: ["教学", "本科", "毕设", "课程", "答辩", "教务", "停课", "调课", "培养"] },
  { key: "postgrad", name: "研究生", className: "cat-postgrad", bgColor: "#d8eeff", kws: ["研究生", "硕士", "博士", "导师", "学位", "研究生院"] },
  { key: "student", name: "学工", className: "cat-student", bgColor: "#e8ffd9", kws: ["学工", "辅导员", "学生工作", "奖助", "评优", "学生"] },
  { key: "confidential", name: "保密", className: "cat-confidential", bgColor: "#f9d1ce", kws: ["保密", "涉密", "安全保密"] },
  { key: "state-assets", name: "国资", className: "cat-state-assets", bgColor: "#e7dcff", kws: ["国资", "资产", "设备采购"] },
  { key: "safety", name: "安全", className: "cat-safety", bgColor: "#ffd9db", kws: ["安全", "实验室", "培训", "应急", "消防"] },
  { key: "international", name: "国合", className: "cat-international", bgColor: "#cffafe", kws: ["国合", "国际化", "全球", "境外", "海外", "外审", "港澳台"] },
  { key: "admin", name: "全院", className: "cat-admin", bgColor: "#f0f0f0", kws: ["通知", "大会", "会议", "@所有人", "全体教职工", "全院"] },
];

export const OTHER_CATEGORY: CategoryMeta = {
  key: "other",
  name: "其他",
  className: "cat-other",
  bgColor: "#f7e2b7",
  kws: [],
};

const IMPORTANCE_KEYWORDS = {
  high: ["重要", "紧急", "@所有人", "务必", "必须", "截止", "下班前", "请于"],
  medium: ["请", "按时", "安排", "报名", "欢迎"],
  low: [],
};

function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function splitNoticeBlocks(raw: string): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  if (!text.includes("【")) {
    return text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  }
  const marked = text.replace(/(【[^】]+】)/g, "\n$1");
  return marked.split(/\n(?=【[^】]+】)/).map((item) => item.trim()).filter(Boolean);
}

function parseHeader(block: string): string {
  const match = block.match(/^【([^】]+)】/);
  return match ? match[1].trim() : "";
}

function inferCategory(text: string): CategoryMeta {
  const scored = CATEGORY_RULES.map((rule) => {
    const score = rule.kws.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
    return { rule, score };
  }).sort((a, b) => b.score - a.score);
  if (!scored[0] || scored[0].score === 0) return OTHER_CATEGORY;
  return scored[0].rule;
}

function inferImportance(text: string): 1 | 2 | 3 {
  if (IMPORTANCE_KEYWORDS.high.some((kw) => text.includes(kw))) return 3;
  if (IMPORTANCE_KEYWORDS.medium.some((kw) => text.includes(kw))) return 2;
  return 1;
}

function parseDates(text: string, fallbackMonthDay?: { month: number; day: number }): { publishDate: Date | null; deadline: Date | null } {
  const currentYear = new Date().getFullYear();
  const dateHits: Date[] = [];

  const monthDay = [...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)];
  for (const m of monthDay) {
    dateHits.push(new Date(currentYear, Number(m[1]) - 1, Number(m[2]), 23, 59, 59));
  }

  const compact = [...text.matchAll(/(?<!\d)(\d{1,2})[./-](\d{1,2})(?!\d)/g)];
  for (const m of compact) {
    dateHits.push(new Date(currentYear, Number(m[1]) - 1, Number(m[2]), 23, 59, 59));
  }

  let publishDate: Date | null = null;
  if (fallbackMonthDay) {
    publishDate = new Date(currentYear, fallbackMonthDay.month - 1, fallbackMonthDay.day, 12, 0, 0);
  } else if (dateHits.length > 0) {
    publishDate = new Date(dateHits[0]);
    publishDate.setHours(12, 0, 0, 0);
  }

  const now = new Date();
  let deadline: Date | null = null;
  const future = dateHits.filter((d) => d.getTime() >= now.getTime() - 24 * 3600 * 1000).sort((a, b) => a.getTime() - b.getTime());
  if (future.length > 0) deadline = future[0];
  else if (dateHits.length > 1) deadline = dateHits.sort((a, b) => a.getTime() - b.getTime()).at(-1);

  return { publishDate, deadline };
}

function parseOwner(text: string): string {
  const ownerLabel = text.match(/(?:负责人|联系人|对接人)\s*[:：]\s*([^\n，。,]+)/);
  if (ownerLabel) return ownerLabel[1].trim();

  const email = text.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (email) return `邮箱 ${email[1]}`;

  const sign = [...text.matchAll(/\n([\u4e00-\u9fa5]{2,4})\s*$/m)].at(-1);
  if (sign) return sign[1];

  return "未指定";
}

function extractLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s）)]+/g)].map((m) => m[0]);
}

function toISODate(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseNoticeBlock(block: string, idx: number): Notice {
  const header = parseHeader(block);
  const cleanedBody = block.replace(/^【[^】]+】/, "").trim();
  const title = header || cleanedBody.split("\n")[0].slice(0, 40) || `通知 ${idx + 1}`;

  const compactDate = header.match(/(\d{1,2})[./-](\d{1,2})/);
  const fallbackMonthDay = compactDate ? { month: Number(compactDate[1]), day: Number(compactDate[2]) } : undefined;
  const { publishDate, deadline } = parseDates(block, fallbackMonthDay);

  const category = inferCategory(`${title}\n${cleanedBody}`);
  const importance = inferImportance(`${title}\n${cleanedBody}`);
  const owner = parseOwner(block);
  const links = extractLinks(block);
  const now = new Date();
  const expired = deadline ? deadline < now : false;

  return {
    id: `notice-${idx}-${Date.now()}`,
    type: category.name,
    title,
    body: cleanedBody,
    publishDate: publishDate ? toISODate(publishDate) : toISODate(now),
    deadline: deadline ? toISODate(deadline) : null,
    importance,
    owner,
    links,
    expired,
    createdAt: toISODate(now),
  };
}

export function parseRawInput(raw: string): Notice[] {
  return splitNoticeBlocks(raw).map((block, idx) => parseNoticeBlock(block, idx));
}
