import { NextResponse } from "next/server";
import { getNotices, addNotices } from "@/lib/notices";
import { parseRawInput } from "@/lib/parser";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const expired = searchParams.get("expired");
  const search = searchParams.get("search");

  let notices = getNotices();

  if (type && type !== "all") {
    notices = notices.filter((n) => n.type === type);
  }

  if (expired === "true") {
    notices = notices.filter((n) => n.expired);
  } else if (expired === "false") {
    notices = notices.filter((n) => !n.expired);
  }

  if (search) {
    const kw = search.toLowerCase();
    notices = notices.filter(
      (n) =>
        n.title.toLowerCase().includes(kw) ||
        n.body.toLowerCase().includes(kw) ||
        n.owner.toLowerCase().includes(kw) ||
        n.type.toLowerCase().includes(kw)
    );
  }

  // Sort: high importance first, then by deadline
  const importanceOrder = { 3: 0, 2: 1, 1: 2 };
  notices.sort((a, b) => {
    if (importanceOrder[a.importance] !== importanceOrder[b.importance]) {
      return importanceOrder[a.importance] - importanceOrder[b.importance];
    }
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  });

  return NextResponse.json(notices);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const newNotices = parseRawInput(text);
    const added = addNotices(newNotices);

    return NextResponse.json({ success: true, count: added.length, notices: added });
  } catch (e) {
    return NextResponse.json({ error: "Failed to parse text" }, { status: 500 });
  }
}
