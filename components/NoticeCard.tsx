"use client";

import type { Notice } from "@/lib/types";
import { CATEGORY_RULES, OTHER_CATEGORY } from "@/lib/parser";
import Link from "next/link";

interface NoticeCardProps {
  notice: Notice;
  rotation: number;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "未设置";
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function getDeadlineText(deadline: string | null): string {
  if (!deadline) return "";
  const now = new Date();
  const d = new Date(deadline);
  const diff = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diff < 0) return `已过期 ${Math.abs(diff)} 天`;
  if (diff === 0) return "今天截止";
  if (diff === 1) return "明天截止";
  if (diff <= 7) return `${diff}天后截止`;
  return formatDate(deadline);
}

function getDeadlineColor(deadline: string | null, expired: boolean): string {
  if (expired || !deadline) return "text-gray-400";
  const now = new Date();
  const d = new Date(deadline);
  const diff = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (diff <= 1) return "text-red-600 font-bold";
  if (diff <= 3) return "text-orange-500 font-semibold";
  if (diff <= 7) return "text-yellow-600";
  return "text-gray-600";
}

function getCategoryClass(type: string): string {
  const found = CATEGORY_RULES.find((r) => r.name === type);
  if (found) return found.className;
  if (type === "其他") return OTHER_CATEGORY.className;
  return "cat-other";
}

function renderStars(importance: 1 | 2 | 3): string {
  return "★".repeat(importance) + "☆".repeat(3 - importance);
}

export default function NoticeCard({ notice, rotation }: NoticeCardProps) {
  const catClass = getCategoryClass(notice.type);
  const deadlineColor = getDeadlineColor(notice.deadline, notice.expired);
  const deadlineText = notice.expired ? "已过期" : getDeadlineText(notice.deadline);

  return (
    <article
      className={`sticky-note ${catClass} ${notice.expired ? "opacity-60" : ""}`}
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <div className="pin" />
      <div className="flex justify-between items-start gap-2 mb-2">
        <span className="text-xs font-bold px-2 py-1 rounded-full bg-white/60 border border-black/10">
          {notice.type}
        </span>
        <span className={`text-xs px-2 py-1 rounded-full ${notice.expired ? "bg-gray-200 text-gray-500" : "bg-white/60 border border-black/10"}`}>
          <span className={notice.importance === 3 ? "text-red-600" : notice.importance === 2 ? "text-orange-500" : "text-green-600"}>
            {renderStars(notice.importance)}
          </span>
        </span>
      </div>

      <h3 className="text-base font-bold leading-snug mb-2" style={{ marginTop: 4 }}>
        {notice.title}
      </h3>

      <div className="text-xs text-gray-500 mb-1">
        发布: {formatDate(notice.publishDate)}
      </div>

      {notice.deadline && (
        <div className={`text-xs mb-2 ${deadlineColor}`}>
          {deadlineText}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-2">
        负责人: {notice.owner}
      </div>

      <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-wrap line-clamp-6">
        {notice.body.length > 200 ? `${notice.body.slice(0, 200)}...` : notice.body}
      </p>

      {notice.links.length > 0 && (
        <div className="mt-2 pt-2 border-t border-black/10">
          {notice.links.slice(0, 2).map((url, i) => (
            <Link
              key={i}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-blue-600 hover:text-blue-800 truncate"
            >
              {url.length > 40 ? url.slice(0, 40) + "..." : url}
            </Link>
          ))}
          {notice.links.length > 2 && (
            <span className="text-xs text-gray-400">+{notice.links.length - 2} 更多链接</span>
          )}
        </div>
      )}
    </article>
  );
}
