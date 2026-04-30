#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
学院通知看板 - 管理员使用说明
生成 PDF 文档
"""

import fitz  # PyMuPDF
import os

def create_admin_guide():
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4 size
    y = 50

    def add_title(text, size=24, color=(0, 0, 0.8)):
        nonlocal y
        page.insert_text((50, y), text, fontsize=size, color=color)
        y += size + 15

    def add_text(text, size=12, color=(0, 0, 0)):
        nonlocal y
        page.insert_text((50, y), text, fontsize=size, color=color)
        y += size + 8

    def add_bullet(text, size=11, indent=20):
        nonlocal y
        page.insert_text((50 + indent, y), f"• {text}", fontsize=size, color=(0.3, 0.3, 0.3))
        y += size + 6

    def add_code(text, size=10):
        nonlocal y
        page.insert_text((70, y), text, fontsize=size, color=(0.5, 0, 0.5))
        y += size + 8

    def new_page_if_needed():
        nonlocal y
        if y > 750:
            page = doc.new_page(width=595, height=842)
            y = 50
            return page
        return page

    # ========== 封面 ==========
    page.insert_text((150, 300), "学院通知便利贴看板", fontsize=28, color=(0, 0, 0.8))
    page.insert_text((180, 350), "管理员使用说明", fontsize=22, color=(0.3, 0.3, 0.3))
    page.insert_text((220, 420), "发布通知篇", fontsize=16, color=(0.5, 0.5, 0.5))
    page.insert_text((230, 500), "版本 1.0", fontsize=12, color=(0.5, 0.5, 0.5))
    page.insert_text((200, 550), "南京航空航天大学", fontsize=14, color=(0.4, 0.4, 0.4))
    page.insert_text((180, 580), "2026年4月", fontsize=12, color=(0.4, 0.4, 0.4))

    # ========== 第2页 - 目录 ==========
    page = doc.new_page(width=595, height=842)
    y = 80
    page.insert_text((220, y), "目 录", fontsize=20, color=(0, 0, 0.8))
    y += 50

    toc_items = [
        ("1. 登录系统", 70),
        ("2. 进入发布界面", 100),
        ("3. 填写通知内容", 130),
        ("4. 上传附件", 170),
        ("5. 预览与发布", 200),
        ("6. 管理已发布通知", 240),
        ("7. 常见问题", 280),
    ]

    for item, x in toc_items:
        page.insert_text((x, y), item, fontsize=14, color=(0, 0, 0))
        y += 35

    # ========== 第3页 - 登录 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "1. 登录系统", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("步骤1：访问通知看板首页", size=14, color=(0, 0, 0))
    y += 10
    add_text("在浏览器中打开通知看板地址：", size=11)
    add_code("https://notice-board2-252176-5-1259025170.sh.run.tcloudbase.com/")
    y += 10

    add_text("步骤2：输入管理员密码", size=14, color=(0, 0, 0))
    y += 10
    add_text("• 输入管理员账号和密码", size=11)
    add_text("• 点击"登录"按钮进入管理后台", size=11)
    y += 10

    add_text("账号说明：", size=14, color=(0, 0, 0))
    y += 5
    add_bullet("admin - 普通管理员，可发布和编辑通知")
    add_bullet("root - 超级管理员，可管理所有设置")

    # ========== 第4页 - 发布界面 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "2. 进入发布界面", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("登录成功后，点击页面右上角的"发布通知"按钮。", size=12)
    y += 20

    add_text("发布界面包含以下区域：", size=14, color=(0, 0, 0))
    y += 15

    add_bullet("通知内容输入框 - 填写通知正文")
    y += 5
    add_bullet("附件上传区 - 上传相关文件")
    y += 5
    add_bullet("预览按钮 - 查看发布效果")
    y += 5
    add_bullet("发布按钮 - 确认发布通知")

    y += 20
    add_text("提示：建议先预览再发布，确保格式正确。", size=11, color=(0.5, 0, 0))

    # ========== 第5页 - 填写内容 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "3. 填写通知内容", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("通知格式要求：", size=14, color=(0, 0, 0))
    y += 15

    add_text("【标题】内容描述", size=12)
    y += 5
    add_text("例如：【国合】关于申报2026年度国际项目的通知", size=11, color=(0.5, 0.5, 0.5))
    y += 20

    add_text("时间格式：", size=14, color=(0, 0, 0))
    y += 10
    add_text("• 相对时间：今天、明天、后天、下周一", size=11)
    add_text("• 标准格式：2026-04-30 或 2026年4月30日", size=11)
    y += 20

    add_text("关键信息自动识别：", size=14, color=(0, 0, 0))
    y += 10
    add_bullet("截止日期 - 自动提取并显示")
    add_bullet("负责人 - 自动识别联系人信息")
    add_bullet("URL链接 - 自动转换为可点击链接")
    add_bullet("附件文件 - 自动识别并提供下载")

    # ========== 第6页 - 上传附件 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "4. 上传附件", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("支持的文件类型：", size=14, color=(0, 0, 0))
    y += 10
    add_bullet("Word文档 (.doc, .docx)")
    add_bullet("Excel表格 (.xls, .xlsx)")
    add_bullet("PDF文件 (.pdf)")
    add_bullet("图片文件 (.jpg, .png, .gif)")
    add_bullet("压缩包 (.zip, .rar)")
    y += 15

    add_text("上传步骤：", size=14, color=(0, 0, 0))
    y += 10
    add_text("1. 点击附件区域的"选择文件"按钮", size=11)
    add_text("2. 从本地选择要上传的文件", size=11)
    add_text("3. 点击"上传"开始上传", size=11)
    add_text("4. 上传成功后，文件名会显示在列表中", size=11)
    y += 15

    add_text("注意：单个文件大小限制为 5MB", size=11, color=(0.5, 0, 0))

    # ========== 第7页 - 预览与发布 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "5. 预览与发布", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("预览功能：", size=14, color=(0, 0, 0))
    y += 10
    add_text("点击"预览"按钮，可以在发布前查看通知的实际显示效果。", size=12)
    add_text("预览内容包括：", size=11)
    add_bullet("通知标题和分类")
    add_bullet("正文内容和格式")
    add_bullet("截止日期（如果有）")
    add_bullet("附件列表")
    y += 20

    add_text("发布确认：", size=14, color=(0, 0, 0))
    y += 10
    add_text("确认预览效果无误后，点击"发布"按钮。", size=12)
    add_text("发布成功后，系统会显示提示信息。", size=12)
    y += 15

    add_text("发布后管理：", size=14, color=(0, 0, 0))
    y += 10
    add_text("• 发布的通知会立即显示在看板首页", size=11)
    add_text("• 管理员可以随时编辑或删除已发布的通知", size=11)
    add_text("• 过期通知会自动标记为灰色", size=11)

    # ========== 第8页 - 管理通知 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "6. 管理已发布通知", fontsize=18, color=(0, 0, 0.8))
    y += 40

    add_text("在通知列表中，每个通知卡片下方有操作按钮：", size=12)
    y += 15

    add_text("编辑通知", size=13, color=(0, 0, 0.6))
    y += 5
    add_text("点击编辑按钮，可以修改通知的标题、内容、截止日期等信息。", size=11)
    y += 15

    add_text("删除通知", size=13, color=(0, 0, 0.6))
    y += 5
    add_text("点击删除按钮，确认后可以删除通知。", size=11)
    add_text("注意：删除操作不可撤销！", size=11, color=(0.8, 0, 0))
    y += 15

    add_text("置顶通知", size=13, color=(0, 0, 0.6))
    y += 5
    add_text("重要通知可以设置更高的优先级，会显示在列表顶部。", size=11)

    # ========== 第9页 - 常见问题 ==========
    page = doc.new_page(width=595, height=842)
    y = 50

    page.insert_text((50, y), "7. 常见问题", fontsize=18, color=(0, 0, 0.8))
    y += 40

    qas = [
        ("Q: 为什么通知显示为灰色？", "A: 灰色的通知表示已过期（超过截止日期）。"),
        ("Q: 如何修改通知的分类？", "A: 编辑通知时，系统会根据内容自动识别分类，也可以手动调整。"),
        ("Q: 附件下载失败怎么办？", "A: 检查网络连接，或尝试刷新页面后重新下载。"),
        ("Q: 如何设置通知的重要性？", "A: 在通知内容中使用"重要"、"紧急"等关键词，系统会自动识别。"),
        ("Q: 可以一次发布多条通知吗？", "A: 可以，在文本框中使用【】分隔多个通知块即可批量发布。"),
    ]

    for q, a in qas:
        page.insert_text((50, y), q, fontsize=11, color=(0, 0, 0.6))
        y += 20
        page.insert_text((70, y), a, fontsize=11, color=(0.3, 0.3, 0.3))
        y += 35

    # ========== 最后一页 ==========
    page = doc.new_page(width=595, height=842)
    y = 300

    page.insert_text((180, y), "感谢使用", fontsize=24, color=(0, 0, 0.8))
    y += 50
    page.insert_text((200, y), "学院通知便利贴看板", fontsize=14, color=(0.3, 0.3, 0.3))
    y += 30
    page.insert_text((220, y), "南京航空航天大学", fontsize=12, color=(0.4, 0.4, 0.4))

    # 保存
    output_path = "/home/zhaozola/academy-notice-board/管理员使用说明-发布通知篇.pdf"
    doc.save(output_path)
    doc.close()
    print(f"PDF已生成: {output_path}")

if __name__ == "__main__":
    create_admin_guide()
