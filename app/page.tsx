"use client";

import { useState, useEffect, useCallback } from "react";
import type { Notice } from "@/lib/types";
import NoticeCard from "@/components/NoticeCard";
import { CATEGORY_RULES, OTHER_CATEGORY } from "@/lib/parser";

const ALL_TYPES = [...CATEGORY_RULES, OTHER_CATEGORY];

const DEMO_TEXT = `【4.20-本科毕设】
各位老师好：
《关于做好2026届本科生毕业设计（论文）后期工作的通知》和《2026届本科生毕业设计（论文）抄袭检测和AIGC检测工作方案》已在学院网站发布
关键时间节点如下：

5月10日 申请参加评优答辩组的学生提交申请材料
5月12日 完成首次抄袭检测和首次AIGC检测（先抄袭检测，后AIGC检测，抄袭检测和AIGC检测均需指导老师在系统上进行确认后方进行检测）；学院公布答辩组安排
5月16日 完成第二次抄袭检测和第二次AIGC检测
5月18日 公布外审名单；指导老师审核毕设材料的网上提交情况，完成指导记录审核及评分；各答辩组开始论文评阅工作
5月24日 各答辩组提交答辩时间安排；公布外审抽检结果；指导教师提交导师评阅学生论文的成绩；答辩组教师提交评阅成绩
5月28日-6月2日 毕业设计答辩
6月4日前 答辩组提交学生成绩和评语
8月31日前 完成毕设延期答辩、补答辩等工作

毕设后期工作安排详见：https://cs.nuaa.edu.cn/2026/0420/c10850a397270/page.htm
抄袭检测和AIGC检测工作方案详见：https://cs.nuaa.edu.cn/2026/0420/c10850a397273/page.htm

感谢各位老师对本科毕设工作的支持[玫瑰][玫瑰]

【4.17-国合-全球大师讲坛申报】
各位老师好，现开展2026年度"全球名师讲坛"征集相关工作。有意向申报的老师可以积极向境外合作高校、研究机构的境外高层次专家、学术领军人物发出诚挚邀请，为学校师生开讲。相关要求如下：
1. 境外专家应为各国科学院、工程院等院士，诺贝尔奖等国际知名奖项获得者，世界知名院校校长或副校长等；
2. 原则上往年参与过"海外院士讲坛""海外学术大师讲坛"的专家不再重复邀请，确有邀请需求的，可与国合处沟通后再邀请；
填写《全球名师讲坛申报汇总表》，于4月27日下班前发送至邮箱 jxb_16@nuaa.edu.cn，谢谢[抱拳]

【4.17-安全-2026年高校实验室安全工作培训】
各位老师，接教育部科学技术与信息化司、高等教育司文件，定于2026年4月23日9:00-11:30以线下线上相结合的方式组织开展"2026年高校实验室安全工作培训"
学院教师自行线上完成此次培训，报名直播测试详见网址 aqhd.las.chaoxing.com
（若当天确有冲突可以事后补学或灵活处理），请各位老师先于今天（4.17）下班前扫描二维码完成报名，报名成功请私聊我，感谢各位老师支持配合。

【4.17-全院大会通知】
各位老师好，今天下午14:30在学院楼113报告厅召开全体教职工大会。会上传达上级精神、介绍学院各项重点工作。请各位老师准时参加，提前5分钟到场。感谢支持！[抱拳][玫瑰]@所有人

【4.16-国合-国际化平台项目申报】
各位老师好，《2026年度国际化项目及平台建设培育工作的通知》已在OA上发布，附件一中有申报指南和项目咨询方式，有意向的老师可查看附件一进行申报，按照要求于4月28日下班前将电子版发送至jxb_16@nuaa.edu.cn，谢谢。`;

export default function Home() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<string>("all");
  const [showExpired, setShowExpired] = useState(false);
  const [search, setSearch] = useState("");
  const [inputText, setInputText] = useState("");
  const [showInput, setShowInput] = useState(false);

  const fetchNotices = useCallback(async () => {
    try {
      const res = await fetch("/api/notices");
      if (res.ok) {
        const data = await res.json();
        setNotices(data);
      }
    } catch (e) {
      console.error("Failed to fetch notices", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotices();
  }, [fetchNotices]);

  const handleParseAndAdd = async () => {
    if (!inputText.trim()) return;
    try {
      const res = await fetch("/api/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: inputText }),
      });
      if (res.ok) {
        await fetchNotices();
        setInputText("");
        setShowInput(false);
      }
    } catch (e) {
      console.error("Failed to add notices", e);
    }
  };

  const handleLoadDemo = async () => {
    try {
      const res = await fetch("/api/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: DEMO_TEXT }),
      });
      if (res.ok) {
        await fetchNotices();
      }
    } catch (e) {
      console.error("Failed to load demo", e);
    }
  };

  const filteredNotices = notices.filter((n) => {
    if (selectedType !== "all" && n.type !== selectedType) return false;
    if (!showExpired && n.expired) return false;
    if (search) {
      const kw = search.toLowerCase();
      if (
        !n.title.toLowerCase().includes(kw) &&
        !n.body.toLowerCase().includes(kw) &&
        !n.owner.toLowerCase().includes(kw)
      ) {
        return false;
      }
    }
    return true;
  });

  const activeNotices = filteredNotices.filter((n) => !n.expired);
  const expiredNotices = filteredNotices.filter((n) => n.expired);

  const getCountByType = (type: string) => {
    if (type === "all") return notices.filter((n) => !showExpired || !n.expired).length;
    return notices.filter((n) => n.type === type && (!showExpired || !n.expired)).length;
  };

  const rotationById = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h << 5) - h + id.charCodeAt(i);
    return ((h % 7) + 7) % 7 - 3;
  };

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-6 p-5 bg-white/80 backdrop-blur rounded-xl shadow-lg border border-amber-100">
          <h1 className="text-2xl font-bold text-gray-800 mb-1">学院通知便利贴看板</h1>
          <p className="text-sm text-gray-500">从微信群消息提取通知，自动分类、标注重要性、显示时间与截止日期</p>
        </header>

        {/* Controls */}
        <div className="mb-6 flex flex-wrap gap-3 items-center">
          <button onClick={() => setShowInput(!showInput)} className="btn-primary">
            + 添加通知
          </button>
          <button onClick={handleLoadDemo} className="btn-secondary">
            加载示例
          </button>
          <input
            type="search"
            placeholder="搜索标题、正文、负责人..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showExpired}
              onChange={(e) => setShowExpired(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            显示过期
          </label>
        </div>

        {/* Add Notice Panel */}
        {showInput && (
          <div className="mb-6 p-4 bg-white rounded-xl shadow-md border border-gray-200">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="粘贴微信群通知文本，建议每条通知以【标题】开头..."
              className="w-full h-40 p-3 border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <div className="mt-3 flex gap-3 justify-end">
              <button onClick={() => setShowInput(false)} className="btn-secondary">
                取消
              </button>
              <button onClick={handleParseAndAdd} className="btn-primary">
                解析并添加
              </button>
            </div>
          </div>
        )}

        {/* Category Filters */}
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedType("all")}
            className={`category-chip ${selectedType === "all" ? "active" : ""}`}
          >
            全部 ({getCountByType("all")})
          </button>
          {ALL_TYPES.map((type) => (
            <button
              key={type.key}
              onClick={() => setSelectedType(type.name)}
              className={`category-chip ${selectedType === type.name ? "active" : ""}`}
            >
              {type.name} ({getCountByType(type.name)})
            </button>
          ))}
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">加载中...</div>
        ) : (
          <>
            {/* Active Notices */}
            {activeNotices.length > 0 ? (
              <div className="board">
                {activeNotices.map((notice) => (
                  <NoticeCard
                    key={notice.id}
                    notice={notice}
                    rotation={rotationById(notice.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-400 bg-white/50 rounded-xl border border-dashed border-gray-300">
                当前筛选条件下没有通知
              </div>
            )}

            {/* Expired Notices */}
            {expiredNotices.length > 0 && (
              <div className="mt-8 expired-section">
                <details open={showExpired}>
                  <summary className="cursor-pointer text-lg font-semibold text-gray-600 list-none flex items-center gap-2">
                    已过期通知
                    <span className="badge">{expiredNotices.length}</span>
                  </summary>
                  <div className="mt-4 board">
                    {expiredNotices.map((notice) => (
                      <NoticeCard
                        key={notice.id}
                        notice={notice}
                        rotation={rotationById(notice.id)}
                      />
                    ))}
                  </div>
                </details>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
