// app/room/[id]/page.tsx
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  LocalParticipant,
  RemoteParticipant,
} from "livekit-client";

type ChatMessage = { me: boolean; original: string; translated: string };

function mapTarget(lang: "en" | "it" | "ru"): "EN-US" | "IT" | "RU" {
  if (lang === "ru") return "RU";
  if (lang === "it") return "IT";
  return "EN-US";
}

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = params.id as string;

  const [room, setRoom] = useState<Room | null>(null);
  const [joined, setJoined] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [partnerLang, setPartnerLang] = useState<"en" | "it" | "ru">("ru");

  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  // role/password
  const [role, setRole] = useState<"OMAR" | "DASHA">("OMAR");
  const [pwd, setPwd] = useState("");

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const msgsBoxRef = useRef<HTMLDivElement | null>(null);

  const [remoteOrientation, setRemoteOrientation] =
    useState<"portrait" | "landscape" | "square">("landscape");

  const [userAtBottom, setUserAtBottom] = useState(true);
  const [showNewIndicator, setShowNewIndicator] = useState(false);

  // Helpers: scroll detection
  const isNearBottom = useCallback(() => {
    const el = msgsBoxRef.current;
    if (!el) return true;
    const threshold = 40;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = msgsBoxRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Auto-scroll logic
  useEffect(() => {
    if (userAtBottom) {
      scrollToBottom();
      setShowNewIndicator(false);
    } else if (messages.length > 0) {
      setShowNewIndicator(true);
    }
  }, [messages, userAtBottom, scrollToBottom]);

  useEffect(() => {
    const el = msgsBoxRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottomNow = isNearBottom();
      setUserAtBottom(atBottomNow);
      if (atBottomNow) setShowNewIndicator(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    requestAnimationFrame(scrollToBottom);
    return () => el.removeEventListener("scroll", onScroll);
  }, [isNearBottom, scrollToBottom]);

  // Room setup
  useEffect(() => {
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      stopLocalTrackOnUnpublish: true,
    });

    r.on(RoomEvent.TrackSubscribed, (track, _pub, _p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
        const v = remoteVideoRef.current;
        track.attach(v);
        const setOrientation = () => {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (!w || !h) return;
          if (w > h) setRemoteOrientation("landscape");
          else if (h > w) setRemoteOrientation("portrait");
          else setRemoteOrientation("square");
        };
        if (v.readyState >= 1) setOrientation();
        v.onloadedmetadata = setOrientation;
      }
      if (track.kind === Track.Kind.Audio) {
        const a = new Audio();
        track.attach(a);
        a.play().catch(() => {});
      }
    });

    r.on(RoomEvent.LocalTrackPublished, (publication: TrackPublication) => {
      if (publication.kind === Track.Kind.Video && localVideoRef.current) {
        publication.track?.attach(localVideoRef.current);
      }
    });

    // Updated signature: payload, participant?, kind?, topic?
    r.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _p?: LocalParticipant | RemoteParticipant, _k?: any, topic?: string) => {
        if (topic && topic !== "chat") return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload));
          if (msg?.type === "chat") {
            setMessages((m) => [
              ...m,
              { me: false, original: msg.original, translated: msg.translated },
            ]);
          }
        } catch {}
      }
    );

    setRoom(r);
    return () => {
      void r.disconnect(); // cleanup must not return a Promise
    };
  }, []);

  async function joinRoom() {
    try {
      setUiError(null);
      if (!room) throw new Error("Room not ready");
      if (!pwd.trim()) throw new Error("Enter password");

      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, role, password: pwd }),
      });

      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg?.error || `Join error (${res.status})`);
      }

      const data = await res.json();
      await room.connect(data.wsUrl, data.token);
      await room.localParticipant.setCameraEnabled(true);
      await room.localParticipant.setMicrophoneEnabled(true);

      const pubs = Array.from(room.localParticipant.videoTrackPublications.values());
      const t = pubs[0]?.track;
      if (t && localVideoRef.current) t.attach(localVideoRef.current);

      setJoined(true);
    } catch (e: any) {
      setUiError(e?.message || "Failed to join");
    }
  }

  async function toggleCamera() {
    if (!room) return;
    const next = !camOn;
    await room.localParticipant.setCameraEnabled(next);
    setCamOn(next);
  }

  async function toggleMic() {
    if (!room) return;
    const next = !micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setMicOn(next);
  }

  async function sendMessage() {
    if (!input.trim() || !room) return;

    const text = input.trim();
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLang: mapTarget(partnerLang) }),
    });
    const data = await res.json();

    setMessages((m) => [...m, { me: true, original: text, translated: data.translated }]);

    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "chat", original: text, translated: data.translated })
      );
      // v2 API: use options object (reliable + topic)
      await room.localParticipant.publishData(payload, { reliable: true, topic: "chat" });
    } catch {}

    setInput("");
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0a2a3f] to-[#0d1b2a] text-white flex items-start md:items-center justify-center p-4">
      <div
        className={`relative w-full max-w-[1300px] h-[70vh] rounded-2xl border border-white/10 bg-black/30 backdrop-blur shadow-2xl overflow-hidden ${
          remoteOrientation === "portrait" ? "portrait" : "landscape"
        }`}
      >
        {/* Remote video */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
        {/* Local preview */}
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className="pointer-events-none absolute right-4 top-4 h-28 w-44 rounded-lg border-2 border-white/70 shadow-lg bg-black object-cover"
          style={{ transform: "scaleX(-1)" }}
        />

        {/* Top bar */}
        <div className="absolute left-4 top-4 z-30 flex items-center gap-3">
          <span className="rounded bg-white/10 px-2 py-1 text-xs md:text-sm">
            Room: <b>{roomId}</b>
          </span>
          <label className="text-xs md:text-sm opacity-80">Partner language:</label>
          <select
            value={partnerLang}
            onChange={(e) => setPartnerLang(e.target.value as any)}
            disabled={!joined}
            className="rounded border border-white/30 bg-black/40 px-2 py-1 text-xs md:text-sm disabled:opacity-50"
          >
            <option value="ru">Russian</option>
            <option value="en">English</option>
            <option value="it">Italian</option>
          </select>
        </div>

        {/* Controls */}
        <div className="absolute bottom-28 left-1/2 z-40 -translate-x-1/2 transform">
          {!joined ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex gap-2">
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="rounded border border-white/30 bg-black/40 px-2 py-1 text-sm"
                >
                  <option value="OMAR">OMAR</option>
                  <option value="DASHA">DASHA</option>
                </select>
                <input
                  type="password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  className="rounded border border-white/30 bg-black/40 px-2 py-1 text-sm"
                  placeholder="Password"
                />
              </div>
              <button
                onClick={joinRoom}
                className="rounded-full bg-blue-600 px-6 py-3 text-white shadow-lg"
              >
                Join chat
              </button>
              {uiError && <span className="text-xs text-red-400">{uiError}</span>}
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={toggleMic}
                className="rounded-full bg-white/15 px-4 py-3 backdrop-blur hover:bg-white/25"
                title={micOn ? "Mute" : "Unmute"}
              >
                {micOn ? "🎤" : "🔇"}
              </button>
              <button
                onClick={toggleCamera}
                className="rounded-full bg-white/15 px-4 py-3 backdrop-blur hover:bg-white/25"
                title={camOn ? "Turn camera off" : "Turn camera on"}
              >
                {camOn ? "🎥" : "📷"}
              </button>
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="absolute inset-x-4 bottom-4 z-20">
          <div className="relative mx-auto w-full max-w-[800px] rounded-xl bg-black/55 p-2 shadow-lg backdrop-blur border border-white/10">
            <div
              ref={msgsBoxRef}
              className="mb-2 h-32 overflow-y-auto px-1 pr-3 flex flex-col gap-2 scroll-smooth"
              style={{ scrollbarGutter: "stable", overscrollBehavior: "contain" }}
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                    m.me ? "self-end bg-blue-600 text-white" : "self-start bg-red-600 text-white"
                  }`}
                >
                  <div className="text-[11px] opacity-80">{m.original}</div>
                  <div className="text-sm font-medium">{m.translated}</div>
                </div>
              ))}
            </div>

            {showNewIndicator && (
              <button
                onClick={() => {
                  scrollToBottom();
                  setUserAtBottom(true);
                  setShowNewIndicator(false);
                }}
                className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs shadow"
              >
                New messages ↓
              </button>
            )}

            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                className="flex-1 rounded-lg border border-white/20 bg-black/50 px-3 py-2 outline-none placeholder:opacity-60"
                placeholder="Write a message…"
              />
              <button
                onClick={sendMessage}
                className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
