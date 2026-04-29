#!/bin/bash
# 学院通知看板功能测试脚本

BASE_URL="http://localhost:3000"
BROWSER="agent-browser"

echo "=========================================="
echo "学院通知看板 - 功能测试"
echo "=========================================="
echo ""

# 启动浏览器
echo "[1/15] 启动浏览器并打开页面..."
$BROWSER open "$BASE_URL"
sleep 2

echo ""
echo "[2/15] 截图: 01_login_page"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/01_login_page.png"

echo ""
echo "[3/15] 测试登录页面 - 点击进入看板..."
$BROWSER click "button:has-text('进入看板')"
sleep 2

echo ""
echo "[4/15] 截图: 02_main_page"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/02_main_page.png"

echo ""
echo "[5/15] 检查页面是否显示通知..."
$BROWSER eval "document.querySelectorAll('.sticky-note').length"
sleep 1

echo ""
echo "[6/15] 测试搜索功能 - 输入关键词..."
$BROWSER fill "#searchInput" "毕设"
$BROWSER click "button:has-text('🔍 搜索')"
sleep 2

echo ""
echo "[7/15] 截图: 03_search_result"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/03_search_result.png"

echo ""
echo "[8/15] 清空搜索..."
$BROWSER fill "#searchInput" ""
$BROWSER press "Enter"
sleep 1

echo ""
echo "[9/15] 测试分类筛选..."
$BROWSER click "button:has-text('教学')"
sleep 2

echo ""
echo "[10/15] 截图: 04_category_filter"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/04_category_filter.png"

echo ""
echo "[11/15] 恢复全部筛选..."
$BROWSER click "button:has-text('全部')"
sleep 1

echo ""
echo "[12/15] 测试显示过期通知..."
$BROWSER check "input[type='checkbox']"
sleep 2

echo ""
echo "[13/15] 截图: 05_show_expired"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/05_show_expired.png"

echo ""
echo "[14/15] 测试排序功能..."
$BROWSER select ".sort-select" "deadline"
sleep 2

echo ""
echo "[15/15] 截图: 06_sorted_by_deadline"
$BROWSER screenshot "/home/zhaozola/academy-notice-board/test_screenshots/06_sorted_by_deadline.png"

echo ""
echo "=========================================="
echo "测试完成!"
echo "截图保存在: /home/zhaozola/academy-notice-board/test_screenshots/"
echo "=========================================="

$BROWSER close
