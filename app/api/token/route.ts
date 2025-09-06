import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function POST(req: NextRequest) {
  try {
    const { room, identity, name } = await req.json();

    if (!room || !identity) {
      return NextResponse.json(
        { error: "room and identity required" },
        { status: 400 }
      );
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const wsUrl = process.env.LIVEKIT_URL!; // ← from the LiveKit popup

    if (!apiKey || !apiSecret || !wsUrl) {
      return NextResponse.json(
        { error: "LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL missing" },
        { status: 500 }
      );
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name,
      ttl: 60 * 10, // 10 minutes
    });

    at.addGrant({ roomJoin: true, room });

    const token = await at.toJwt();

    return NextResponse.json({ token, wsUrl });
  } catch (e) {
    console.error("token error", e);
    return NextResponse.json({ error: "failed to create token" }, { status: 500 });
  }
}
