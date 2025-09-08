// app/api/token/route.ts
import { NextRequest, NextResponse } from "next/server";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const { room, role, password } = await req.json();

    if (!room || !role || !password) {
      return NextResponse.json({ error: "room, role, password required" }, { status: 400 });
    }

    const ROLE = String(role).trim().toUpperCase(); // "OMAR" | "DASHA"
    if (ROLE !== "OMAR" && ROLE !== "DASHA") {
      return NextResponse.json({ error: "invalid role" }, { status: 400 });
    }

    // password check
    const expected =
      ROLE === "OMAR" ? need("OMAR_PASSWORD") : need("DASHA_PASSWORD");
    if (password !== expected) {
      return NextResponse.json({ error: "invalid password" }, { status: 401 });
    }

    // ensure single user per role in this room
    const url = need("LIVEKIT_URL");
    const apiKey = need("LIVEKIT_API_KEY");
    const apiSecret = need("LIVEKIT_API_SECRET");

    // RoomServiceClient host must be HTTPS base (not wss). Convert.
    const host = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const svc = new RoomServiceClient(host, apiKey, apiSecret);

    // If room exists and participant with same identity already there → block
    try {
      const participants = await svc.listParticipants(room);
      const taken = participants.some((p) => p.identity === ROLE);
      if (taken) {
        return NextResponse.json(
          { error: `${ROLE} already connected in this room` },
          { status: 409 }
        );
      }
    } catch {
      // listParticipants may throw if room doesn't exist yet; that’s fine (room will be created on join)
    }

    // Issue token using identity = ROLE (enforces uniqueness at LiveKit level too)
    const at = new AccessToken(apiKey, apiSecret, {
      identity: ROLE,
      name: ROLE,
      ttl: 60 * 60, // 1 hour
    });
    at.addGrant({ roomJoin: true, room });

    const token = await at.toJwt();

    return NextResponse.json({
      token,
      wsUrl: url,
      identity: ROLE,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "server error" }, { status: 500 });
  }
}
