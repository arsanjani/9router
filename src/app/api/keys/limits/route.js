import { NextResponse } from "next/server";
import { getKeysWindowUsage } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // getKeysWindowUsage() strips raw key values and fails open per key.
    const result = await getKeysWindowUsage();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching key limits:", error);
    return NextResponse.json({ error: "Failed to fetch key limits" }, { status: 500 });
  }
}
