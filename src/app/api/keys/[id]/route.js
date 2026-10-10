import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }
    if (body.limitMode !== undefined) updateData.limitMode = body.limitMode;
    if (body.limit5h !== undefined) updateData.limit5h = body.limit5h;
    if (body.limit7d !== undefined) updateData.limit7d = body.limit7d;
    if (body.limit30d !== undefined) updateData.limit30d = body.limit30d;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    if (error.message?.startsWith("Invalid limit")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

export { PUT as PATCH };

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
