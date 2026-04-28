import { NextResponse } from "next/server";
import { deleteNotice, updateNotice } from "@/lib/notices";

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const success = deleteNotice(id);
  if (!success) {
    return NextResponse.json({ error: "Notice not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const updates = await request.json();
    const updated = updateNotice(id, updates);
    if (!updated) {
      return NextResponse.json({ error: "Notice not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Failed to update notice" }, { status: 500 });
  }
}
