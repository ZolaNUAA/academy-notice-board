#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
学院通知看板 - 管理员使用手册 (图文版)
"""

import fitz
import os

# ── Colors ──
BLUE = (0.1, 0.3, 0.7)
DARK = (0.15, 0.15, 0.15)
GRAY = (0.4, 0.4, 0.4)
LGRAY = (0.85, 0.85, 0.85)
WHITE = (1, 1, 1)
GREEN = (0.1, 0.6, 0.3)
ORANGE = (0.9, 0.5, 0.1)
RED = (0.8, 0.2, 0.2)
PURPLE = (0.5, 0.2, 0.7)

# Category colors (matching the app)
CAT_COLORS = {
    '科研': (1, 0.96, 0.7), '教学': (1, 0.89, 0.76),
    '研究生': (0.85, 0.93, 1), '学工': (0.91, 1, 0.85),
    '保密': (0.94, 0.84, 0.84), '国合': (0.81, 0.98, 1),
    '安全': (1, 0.85, 0.86), '全院': (0.94, 0.94, 0.94),
    '国资': (0.91, 0.86, 1), '其他': (0.97, 0.89, 0.72),
}
CAT_KEYS = ['科研', '教学', '研究生', '学工', '保密', '国合', '安全', '全院', '国资', '其他']


def new_page(doc):
    return doc.new_page(width=595, height=842)


def draw_header(page, y, text, color=BLUE, size=20):
    """Section header with colored left bar"""
    page.draw_rect((40, y - 5, 43, y + size + 5), fill=color, width=0)
    page.insert_text((52, y + size - 4), text, fontsize=size, color=DARK)
    return y + size + 16


def draw_step(page, y, num, title, body, color=BLUE):
    """Numbered step with colored number badge"""
    # Number circle
    page.draw_circle((58, y + 12), 9, fill=color, width=0)
    page.insert_text((54, y + 16), str(num), fontsize=12, color=WHITE)
    # Title
    page.insert_text((75, y + 16), title, fontsize=13, color=DARK)
    y += 24
    # Body
    for line in body.split('\n'):
        page.insert_text((75, y), '• ' + line, fontsize=10, color=GRAY)
        y += 16
    return y + 8


def draw_tip_box(page, y, title, text):
    """Info/warning box with colored background"""
    h = 40 + text.count('\n') * 16
    page.draw_rect((45, y, 555, y + h), fill=(0.95, 0.97, 1), width=0)
    page.draw_rect((45, y, 555, y + h), color=(0.7, 0.8, 0.95), width=1)
    page.insert_text((55, y + 18), '💡 ' + title, fontsize=11, color=BLUE)
    y2 = y + 35
    for line in text.split('\n'):
        page.insert_text((55, y2), line, fontsize=9, color=GRAY)
        y2 += 15
    return y + h + 10


def draw_warning_box(page, y, title, text):
    """Warning box with red/light red"""
    h = 25 + text.count('\n') * 15
    page.draw_rect((45, y, 555, y + h), fill=(1, 0.93, 0.93), width=0)
    page.draw_rect((45, y, 555, y + h), color=(0.95, 0.7, 0.7), width=1)
    page.insert_text((55, y + 17), '⚠️ ' + title, fontsize=11, color=RED)
    y2 = y + 32
    for line in text.split('\n'):
        page.insert_text((55, y2), line, fontsize=9, color=GRAY)
        y2 += 15
    return y + h + 10


def draw_table(page, y, headers, rows, col_widths):
    """Simple table with header row"""
    x_start = 50
    row_h = 22

    # Header
    x = x_start
    for i, h in enumerate(headers):
        w = col_widths[i]
        page.draw_rect((x, y, x + w, y + row_h), fill=BLUE, width=0)
        page.insert_text((x + 6, y + 15), h, fontsize=10, color=WHITE)
        x += w

    # Rows
    y += row_h
    for ri, row in enumerate(rows):
        bg = (0.97, 0.97, 0.97) if ri % 2 == 0 else WHITE
        x = x_start
        max_h = row_h
        for i, cell in enumerate(row):
            w = col_widths[i]
            page.draw_rect((x, y, x + w, y + max_h), fill=bg, width=0)
            page.draw_rect((x, y, x + w, y + max_h), color=LGRAY, width=0.5)
            page.insert_text((x + 6, y + 14), cell, fontsize=9, color=DARK)
            x += w
        y += max_h
    return y + 6


def draw_separator(page, y):
    page.draw_line((50, y), (545, y), color=LGRAY, width=1)
    return y + 12


def check_space(page, y, needed=80):
    if y + needed > 800:
        return new_page(page), 50
    return page, y


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def create_manual():
    doc = fitz.open()

    # ── Page 1: Cover ──
    page = new_page(doc)
    # Top decoration bar
    page.draw_rect((0, 0, 595, 8), fill=BLUE, width=0)
    page.draw_rect((0, 834, 595, 842), fill=BLUE, width=0)

    # Title block
    page.draw_rect((80, 200, 515, 320), fill=(0.95, 0.97, 1), width=0)
    page.draw_rect((80, 200, 515, 320), color=BLUE, width=1.5)
    page.insert_text((160, 250), "学院通知便利贴看板", fontsize=30, color=BLUE)
    page.insert_text((190, 290), "管理员使用手册", fontsize=22, color=DARK)

    # Subtitle
    page.insert_text((230, 380), "📋  发 布 通 知  篇", fontsize=14, color=GRAY)

    # Info
    page.insert_text((220, 460), "版本 1.0  |  2026年4月", fontsize=12, color=GRAY)
    page.insert_text((200, 490), "南京航空航天大学", fontsize=13, color=GRAY)

    # Bottom decorative circles
    for i, c in enumerate([BLUE, GREEN, ORANGE]):
        page.draw_circle((250 + i * 60, 550), 8, fill=c, width=0)

    # ── Page 2: TOC ──
    page = new_page(doc)
    y = 60
    page.draw_rect((40, y - 5, 43, y + 30), fill=BLUE, width=0)
    page.insert_text((52, y + 22), "目  录", fontsize=22, color=DARK)
    y += 50

    toc = [
        ("1", "系统简介", "了解看板的功能和使用场景"),
        ("2", "快速入门", "5 分钟学会发布第一条通知"),
        ("3", "访问与登录", "访问地址、验证码、管理员登录"),
        ("4", "添加通知", "粘贴微信群文本、自动解析"),
        ("5", "上传附件与图片", "文件上传和图片粘贴"),
        ("6", "预览与发布", "发布前检查和确认"),
        ("7", "管理通知", "编辑、删除、查看通知"),
        ("8", "管理员管理", "添加/删除管理员账号"),
        ("9", "通知类型与配色", "各类通知的颜色标识"),
        ("10", "常见问题与技巧", "使用小贴士"),
    ]
    for num, title, desc in toc:
        # Number box
        page.draw_rect((55, y, 70, y + 18), fill=BLUE, width=0)
        page.insert_text((60, y + 14), num, fontsize=10, color=WHITE)
        page.insert_text((80, y + 14), title, fontsize=12, color=DARK)
        page.insert_text((220, y + 14), desc, fontsize=9, color=GRAY)
        y += 28

    # ── Page 3: System Intro ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "1  系统简介")

    page.insert_text((52, y), "学院通知便利贴看板是一个轻量级的通知管理系统，专为高校学院日常通知发布设计。", fontsize=11, color=DARK)
    y += 30
    page.insert_text((52, y), "核心特点：", fontsize=13, color=DARK)
    y += 24

    features = [
        ("📝 微信群文本解析", "粘贴微信群通知，自动分类、提取截止日期和负责人"),
        ("🏷️ 智能分类", "根据内容自动识别通知类型（科研、教学、研究生等）"),
        ("📎 附件支持", "支持上传 PDF、Word、Excel、图片等文件"),
        ("🖼️ 图片粘贴", "直接从剪贴板粘贴图片到编辑框"),
        ("⏰ 截止日期提示", "自动识别时间信息，过期通知自动折叠"),
        ("⭐ 重要性标识", "自动判断通知的重要程度（1-3星）"),
    ]
    for title, desc in features:
        page.draw_rect((55, y, 545, y + 22), fill=(0.97, 0.97, 0.97), width=0)
        page.draw_rect((55, y, 545, y + 22), color=LGRAY, width=0.5)
        page.insert_text((60, y + 15), title, fontsize=11, color=DARK)
        page.insert_text((200, y + 15), desc, fontsize=9, color=GRAY)
        y += 28

    # ── Page 4: Quick Start ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "2  快速入门", BLUE)

    page.draw_rect((50, y, 545, y + 55), fill=(0.95, 0.97, 1), width=0)
    page.draw_rect((50, y, 545, y + 55), color=BLUE, width=1)
    page.insert_text((60, y + 18), "🎯 目标：5 分钟内发布第一条通知", fontsize=13, color=BLUE)
    y += 42

    steps = [
        ("打开浏览器", "访问管理员提供的网址"),
        ("输入验证码", "输入访问验证码进入系统"),
        ("点击「发布通知」", "进入发布界面"),
        ("粘贴通知文本", "复制微信群通知，粘贴到文本框中"),
        ("点击「发布」", "系统自动解析并发布，完成！"),
    ]
    for i, (title, desc) in enumerate(steps, 1):
        page, y = check_space(page, y, 48)
        page.draw_circle((56, y + 12), 10, fill=BLUE, width=0)
        page.insert_text((52, y + 16), str(i), fontsize=11, color=WHITE)
        page.insert_text((75, y + 16), title, fontsize=12, color=DARK)
        page.insert_text((210, y + 16), desc, fontsize=10, color=GRAY)
        # Arrow between steps
        if i < 5:
            page.draw_line((62, y + 24), (62, y + 36), color=LGRAY, width=1)
        y += 38

    # ── Page 5: Access & Login ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "3  访问与登录")

    # Step 1
    page.insert_text((52, y), "步骤一：打开浏览器访问系统", fontsize=13, color=DARK)
    y += 24
    # URL box
    page.draw_rect((70, y, 540, y + 28), fill=(0.95, 0.97, 1), width=0)
    page.draw_rect((70, y, 540, y + 28), color=BLUE, width=1)
    page.insert_text((80, y + 19), "https://notice-board2-252176-5-1259025170.sh.run.tcloudbase.com/", fontsize=11, color=PURPLE)
    y += 42

    # Step 2
    page.insert_text((52, y), "步骤二：输入访问验证码", fontsize=13, color=DARK)
    y += 24
    page.insert_text((70, y), '系统会提示输入访问验证码（首次访问时需要）。', fontsize=10, color=GRAY)
    y += 18
    page.insert_text((70, y), '默认验证码：', fontsize=10, color=GRAY)
    page.draw_rect((155, y - 3, 235, y + 17), fill=(1, 0.96, 0.8), width=0)
    page.draw_rect((155, y - 3, 235, y + 17), color=ORANGE, width=0.5)
    page.insert_text((160, y + 13), 'nuaa16', fontsize=10, color=ORANGE)
    y += 28

    # Step 3
    page.insert_text((52, y), "步骤三：管理员登录（发布通知需要）", fontsize=13, color=DARK)
    y += 24
    page.insert_text((70, y), "点击页面右上角的「管理员登录」按钮，输入管理密码。", fontsize=10, color=GRAY)
    y += 20
    page.insert_text((70, y), "管理员账号由系统管理员创建，首次使用请获取初始密码。", fontsize=10, color=GRAY)
    y += 28

    page = draw_tip_box(page, y, "密码安全建议", "首次登录后请及时修改密码（设置 → 修改密码）\n密码要求：长度8位以上，包含大小写字母、数字和特殊字符")

    # ── Page 6: Add Notice ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "4  添加通知")

    page.insert_text((52, y), "系统支持两种方式添加通知：", fontsize=12, color=DARK)
    y += 24

    # Method 1
    page.draw_rect((55, y, 545, y + 55), fill=(0.97, 0.97, 0.97), width=0)
    page.draw_rect((55, y, 545, y + 55), color=LGRAY, width=0.5)
    page.insert_text((65, y + 16), "方式一：粘贴微信群文本（推荐）", fontsize=12, color=BLUE)
    page.insert_text((65, y + 36), "复制微信群中的通知内容，粘贴到编辑框，系统会自动解析分类。", fontsize=10, color=GRAY)
    y += 65

    # Method 2
    page.draw_rect((55, y, 545, y + 55), fill=(0.97, 0.97, 0.97), width=0)
    page.draw_rect((55, y, 545, y + 55), color=LGRAY, width=0.5)
    page.insert_text((65, y + 16), "方式二：手动填写（通过编辑面板）", fontsize=12, color=BLUE)
    page.insert_text((65, y + 36), "在解析结果的编辑面板上，手动修改标题、类型、正文等信息。", fontsize=10, color=GRAY)
    y += 65

    # Auto-parsing explanation
    y = draw_header(page, y, "  自动解析功能说明", GREEN, 14)
    page.insert_text((52, y), "系统会自动识别以下信息：", fontsize=11, color=DARK)
    y += 22

    parsing_items = [
        ("通知类型", "根据关键词自动匹配（科研、教学、国合、安全等）"),
        ("标题", "自动提取【标题】或首行内容作为标题"),
        ("截止日期", "识别「截止日期」「请于X月X日前」等时间信息"),
        ("重要性", "检测「重要」「紧急」「务必」等关键词，自动评星"),
        ("负责人", "识别「联系人：XXX」「负责人：XXX」等信息"),
        ("链接", "自动提取通知正文中的 URL 地址"),
    ]
    for label, desc in parsing_items:
        page, y = check_space(page, y, 22)
        page.draw_rect((60, y - 2, 175, y + 16), fill=(0.95, 0.97, 1), width=0)
        page.draw_rect((60, y - 2, 175, y + 16), color=BLUE, width=0.5)
        page.insert_text((64, y + 12), label, fontsize=10, color=BLUE)
        page.insert_text((185, y + 12), desc, fontsize=10, color=GRAY)
        y += 22

    # ── Page 7: WeChat paste example ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "  微信群粘贴示例")

    page.insert_text((52, y), "以下是一段典型的微信群通知，复制后直接粘贴到编辑框即可：", fontsize=10, color=GRAY)
    y += 22

    # Example WeChat text box
    example = (
        '【国合】关于申报2026年度国际项目的通知\n'
        '各位老师好，2026年度国际化项目申报工作已开始。\n'
        '截止日期：4月28日下班前\n'
        '联系人：张老师，邮箱 jxb_16@nuaa.edu.cn\n'
        '详情见：https://cs.nuaa.edu.cn/xxx'
    )
    page.draw_rect((55, y, 545, y + 85), fill=(0.98, 0.96, 0.92), width=0)
    page.draw_rect((55, y, 545, y + 85), color=(0.9, 0.85, 0.7), width=1)
    y2 = y + 16
    for line in example.split('\n'):
        page.insert_text((70, y2), line, fontsize=11, color=DARK)
        y2 += 16
    y += 95

    # Parse result
    page.insert_text((52, y), "粘贴后，系统会自动解析为：", fontsize=12, color=DARK)
    y += 22

    # Parsed notice card
    page.draw_rect((55, y, 545, y + 120), fill=(1, 1, 0.95), width=0)
    page.draw_rect((55, y, 545, y + 120), color=(0.9, 0.9, 0.7), width=1)
    # Left color bar
    page.draw_rect((55, y, 58, y + 120), fill=(0.5, 0.8, 0.95), width=0)

    fields = [
        ('标题', '【国合】关于申报2026年度国际项目的通知'),
        ('类型', '国合  |  重要性：★★★  |  截止：2026-04-28'),
        ('负责人', '邮箱 jxb_16@nuaa.edu.cn'),
        ('正文', '各位老师好，2026年度国际化项目申报工作已开始...'),
    ]
    y2 = y + 18
    for label, val in fields:
        page.insert_text((68, y2), label + '：', fontsize=10, color=BLUE)
        page.insert_text((120, y2), val, fontsize=10, color=DARK)
        y2 += 20

    y += 130
    y = draw_tip_box(page, y, "批量发布", '多条通知可以用【】分隔，一次粘贴即可批量发布多条通知。\n例如：同时粘贴【科研】通知和【教学】通知，系统会分别解析。')

    # ── Page 8: Upload Attachments & Images ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "5  上传附件与图片")

    # Attachments
    y = draw_header(page, y, "  上传附件", BLUE, 14)
    page.insert_text((52, y), "支持的文件类型：", fontsize=11, color=DARK)
    y += 22

    exts = ['PDF (.pdf)', 'Word (.doc/.docx)', 'Excel (.xls/.xlsx)',
            '图片 (.jpg/.png/.gif)', '压缩包 (.zip/.rar)']
    for e in exts:
        page.insert_text((70, y), '📎  ' + e, fontsize=10, color=GRAY)
        y += 18

    y += 6
    page.insert_text((52, y), "上传步骤：", fontsize=12, color=DARK)
    y += 22

    upload_steps = [
        ("点击「选择文件」按钮", "在发布界面的附件区域"),
        ("选取本地文件", "从电脑中选择要上传的文件"),
        ("自动上传", "选中的文件会自动开始上传"),
        ("确认附件列表", "上传成功后文件名会显示在列表中"),
    ]
    for i, (t, d) in enumerate(upload_steps, 1):
        page.draw_rect((60, y, 82, y + 14), fill=BLUE, width=0)
        page.insert_text((65, y + 11), str(i), fontsize=9, color=WHITE)
        page.insert_text((90, y + 11), t, fontsize=10, color=DARK)
        page.insert_text((210, y + 11), d, fontsize=9, color=GRAY)
        y += 20

    y = draw_warning_box(page, y + 6, "文件大小限制", '单个文件最大 5MB，超出会提示错误。')

    # Images
    y = draw_header(page, y, "  粘贴图片", BLUE, 14)
    page.insert_text((52, y), "支持直接从剪贴板粘贴图片到编辑框：", fontsize=11, color=DARK)
    y += 22

    img_steps = [
        "复制图片（截图工具或右键复制图片）",
        "在编辑框中按 Ctrl+V 粘贴",
        "图片会自动上传并显示为 ![图片名](URL) 格式",
        "发布后图片会显示在通知正文中",
    ]
    for s in img_steps:
        page.insert_text((70, y), '🖼️  ' + s, fontsize=10, color=GRAY)
        y += 20

    # ── Page 9: Preview & Publish ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "6  预览与发布")

    page.insert_text((52, y), "在发布前，建议先点击「预览」按钮查看效果。", fontsize=11, color=DARK)
    y += 24

    y = draw_header(page, y, "  预览功能", BLUE, 14)
    page.insert_text((52, y), "预览可查看以下内容：", fontsize=11, color=DARK)
    y += 22

    preview_items = [
        "通知标题和分类标签",
        "正文内容和格式（含高亮关键词）",
        "截止日期和剩余时间",
        "附件文件列表",
        "重要性星级",
    ]
    for item in preview_items:
        page.insert_text((70, y), '✅  ' + item, fontsize=10, color=GRAY)
        y += 18

    y += 10
    page.insert_text((52, y), "在预览面板中可以直接编辑标题、类型、正文等信息。", fontsize=11, color=DARK)
    y += 24

    y = draw_header(page, y, "  发布确认", BLUE, 14)
    page.insert_text((52, y), "确认预览效果无误后，点击「确认发布」按钮。", fontsize=11, color=DARK)
    y += 22
    page.insert_text((52, y), "发布成功后，通知会立即显示在看板首页。", fontsize=11, color=DARK)
    y += 26

    page = draw_tip_box(page, y, "温馨提示", '建议重要通知先预览再发布，确保自动解析结果准确。\n如果分类不准确，可以在预览面板中手动调整。')

    # ── Page 10: Manage Notices ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "7  管理通知")

    page.insert_text((52, y), "管理员登录后，可以在通知列表中对每条通知进行操作。", fontsize=11, color=DARK)
    y += 30

    actions = [
        ("编辑", "修改通知的标题、类型、正文、截止日期等信息", BLUE),
        ("删除", "删除不再需要的通知（不可恢复）", RED),
    ]
    for title, desc, color in actions:
        page.draw_rect((55, y, 545, y + 40), fill=(0.97, 0.97, 0.97), width=0)
        page.draw_rect((55, y, 545, y + 40), color=LGRAY, width=0.5)
        # Left color indicator
        page.draw_rect((55, y, 58, y + 40), fill=color, width=0)
        page.insert_text((68, y + 14), title, fontsize=13, color=color)
        page.insert_text((68, y + 32), desc, fontsize=10, color=GRAY)
        y += 48

    y = draw_warning_box(page, y, "删除不可恢复", '删除通知操作不可撤销，请谨慎操作。\n建议在删除前确认通知已不再需要。')

    y += 6
    page.insert_text((52, y), "过期通知管理：", fontsize=13, color=DARK)
    y += 22
    page.insert_text((70, y), '• 超过截止日期的通知会自动标记为「已过期」', fontsize=10, color=GRAY)
    y += 18
    page.insert_text((70, y), '• 过期通知在首页默认折叠显示，点击可展开查看', fontsize=10, color=GRAY)
    y += 18
    page.insert_text((70, y), '• 管理员可以在设置中选择显示或隐藏过期通知', fontsize=10, color=GRAY)

    # ── Page 11: Admin Management ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "8  管理员管理")

    page.insert_text((52, y), "只有超级管理员（root）可以管理其他管理员账号。", fontsize=11, color=DARK)
    y += 26

    y = draw_header(page, y, "  账号类型", BLUE, 14)
    page.insert_text((52, y), "系统有两种管理员角色：", fontsize=11, color=DARK)
    y += 22

    # Role table
    y = draw_table(page, y,
        ['角色', '说明', '权限'],
        [
            ['admin', '普通管理员', '发布、编辑、删除通知'],
            ['root', '超级管理员', '所有权限 + 管理管理员账号 + 系统设置'],
        ],
        [80, 200, 200]
    )

    y += 10
    y = draw_header(page, y, "  添加管理员（root 专属）", BLUE, 14)
    page.insert_text((52, y), "1. 以 root 密码登录系统", fontsize=10, color=GRAY)
    y += 18
    page.insert_text((52, y), "2. 进入「设置」→「管理员管理」", fontsize=10, color=GRAY)
    y += 18
    page.insert_text((52, y), "3. 输入新管理员的用户名和初始密码", fontsize=10, color=GRAY)
    y += 18
    page.insert_text((52, y), "4. 新管理员可使用初始密码登录后自行修改密码", fontsize=10, color=GRAY)

    y += 10
    y = draw_warning_box(page, y, "密码安全要求", '管理员密码必须符合安全要求：\n长度 8 位以上，包含大写字母、小写字母、数字和特殊字符。')

    # ── Page 12: Category Reference ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "9  通知类型与配色")

    page.insert_text((52, y), "系统为每种通知类型分配了专属的颜色标识，方便快速识别。", fontsize=11, color=DARK)
    y += 26

    # Category color reference
    rows = []
    for name in CAT_KEYS:
        color = CAT_COLORS[name]
        # Convert RGB to hex-like name
        rows.append([name, '', '文章中含有相关关键词自动匹配'])

    # Draw color cards
    x_start = 55
    card_w = 100
    card_h = 28
    gap = 6
    cols = 4

    for i, name in enumerate(CAT_KEYS):
        col_idx = i % cols
        row_idx = i // cols
        x = x_start + col_idx * (card_w + gap)
        y_pos = y + row_idx * (card_h + gap) + (row_idx * 8)

        r, g, b = CAT_COLORS[name]
        page.draw_rect((x, y_pos, x + card_w, y_pos + card_h), fill=(r, g, b), width=0)
        page.draw_rect((x, y_pos, x + card_w, y_pos + card_h), color=LGRAY, width=0.5)
        page.insert_text((x + 10, y_pos + 17), name, fontsize=11, color=DARK)

    y += ((len(CAT_KEYS) - 1) // cols + 1) * (card_h + gap + 8) + 20
    page, y = check_space(page, y, 120)

    page.insert_text((52, y), "关键词匹配示例：", fontsize=13, color=DARK)
    y += 22

    kw_examples = [
        ("科研", "基金、申报、科技厅、项目、学术、论文"),
        ("教学", "本科、毕设、课程、答辩、考试、选课"),
        ("国合", "国际化、境外、海外、出国、留学生"),
        ("安全", "实验室、安全培训、消防、防疫"),
        ("全院", "全院大会、全体教职工大会、院领导"),
    ]
    for name, kws in kw_examples:
        page.draw_rect((60, y - 2, 130, y + 16), fill=CAT_COLORS[name], width=0)
        page.draw_rect((60, y - 2, 130, y + 16), color=LGRAY, width=0.5)
        page.insert_text((64, y + 12), name, fontsize=10, color=DARK)
        page.insert_text((140, y + 12), kws, fontsize=9, color=GRAY)
        y += 22

    # ── Page 13: FAQ ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "10  常见问题与技巧")

    faqs = [
        ("Q: 为什么通知自动分类不准确？",
         "A: 可以手动调整。在预览面板中，点击类型标签即可切换为正确的分类。"),
        ("Q: 上传附件失败怎么办？",
         "A: 检查文件是否超过 5MB 限制。如果超过，请压缩后上传。\n   同时检查网络连接是否正常。"),
        ("Q: 如何让通知显示在更前面？",
         "A: 系统按重要性排序（3星 > 2星 > 1星）。在正文中使用「重要」「紧急」\n   等关键词会被自动识别为高重要性。"),
        ("Q: 粘贴后没有解析出截止日期？",
         "A: 确保日期格式清晰。推荐格式：「截止日期：4月28日」\n   或「请于4月28日下班前提交」。"),
        ("Q: 通知发布后可以修改吗？",
         "A: 可以。在通知卡片上点击「编辑」按钮即可修改所有内容。\n   修改后会自动重新计算过期状态。"),
        ("Q: 超过截止日期的通知会自动消失吗？",
         "A: 不会消失，但会自动折叠显示。用户仍然可以点击展开查看\n   过期通知，管理员可以选择手动删除。"),
    ]

    for q, a in faqs:
        page, y = check_space(page, y, 60)
        # Question
        page.draw_rect((50, y, 545, y + 22), fill=(0.95, 0.97, 1), width=0)
        page.draw_rect((50, y, 545, y + 22), color=BLUE, width=0.5)
        page.insert_text((55, y + 15), q, fontsize=11, color=BLUE)
        y += 28
        # Answer
        for line in a.split('\n'):
            page.insert_text((70, y), line, fontsize=9, color=GRAY)
            y += 16
        y += 10

    # ── Page 14: Tips ──
    page, y = new_page(doc), 50
    y = draw_header(page, y, "  使用技巧")

    tips = [
        ("快捷操作", [
            "Ctrl+V 粘贴通知文本或图片",
            "在编辑框中直接输入即可自动解析",
            "多条通知用【】分隔可批量发布",
        ]),
        ("通知编辑", [
            "发布前务必预览，确认分类和日期准确",
            "可以在预览面板中直接修改解析结果",
            "过期通知建议及时清理",
        ]),
        ("安全管理", [
            "管理员密码请定期更换",
            "root 账号仅限系统管理员使用",
            "不要在公共电脑上勾选「记住密码」",
        ]),
    ]

    for title, items in tips:
        page, y = check_space(page, y, 80)
        page.draw_rect((50, y, 545, y + 28), fill=(0.9, 0.95, 0.9), width=0)
        page.draw_rect((50, y, 545, y + 28), color=GREEN, width=0.5)
        page.insert_text((60, y + 19), title, fontsize=13, color=GREEN)
        y += 36
        for item in items:
            page.insert_text((70, y), '💡  ' + item, fontsize=10, color=GRAY)
            y += 22

    # ── Last page: Thank you ──
    page = new_page(doc)
    page.draw_rect((0, 0, 595, 8), fill=BLUE, width=0)
    page.draw_rect((0, 834, 595, 842), fill=BLUE, width=0)

    page.insert_text((180, 320), "感谢使用", fontsize=28, color=BLUE)
    page.insert_text((200, 370), "学院通知便利贴看板", fontsize=14, color=GRAY)
    page.insert_text((160, 470), "如有问题请联系系统管理员", fontsize=11, color=GRAY)
    page.insert_text((220, 500), "南京航空航天大学", fontsize=12, color=GRAY)

    # ── Save ──
    output_path = os.path.join(os.path.dirname(__file__),
                               "学院通知看板-管理员使用手册.pdf")
    page_count = doc.page_count
    doc.save(output_path)
    doc.close()
    print(f"✅ 手册已生成: {output_path}")
    print(f"   共 {page_count} 页")


if __name__ == "__main__":
    create_manual()
