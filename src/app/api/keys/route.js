import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, expiresAt } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let parsedExpiresAt = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "Invalid expiration date" }, { status: 400 });
      }
      parsedExpiresAt = d.toISOString();
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const limits = {};
    if (body.limitMode !== undefined) limits.limitMode = body.limitMode;
    if (body.limit5h !== undefined) limits.limit5h = body.limit5h;
    if (body.limit7d !== undefined) limits.limit7d = body.limit7d;
    if (body.limit30d !== undefined) limits.limit30d = body.limit30d;

    const apiKey = await createApiKey(name, machineId, parsedExpiresAt, limits);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      expiresAt: apiKey.expiresAt,
      limitMode: apiKey.limitMode,
      limit5h: apiKey.limit5h,
      limit7d: apiKey.limit7d,
      limit30d: apiKey.limit30d,
    }, { status: 201 });
  } catch (error) {
    if (error.message?.startsWith("Invalid limit")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
