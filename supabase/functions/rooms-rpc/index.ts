// Edge Function: rooms-rpc
// Fase 2 — CRUD de salas, presencia y administración básica.
//
// Despliegue:  supabase functions deploy rooms-rpc --no-verify-jwt
//
// Secrets requeridos en el dashboard de Supabase:
//   ADMIN_PASSWORD            (para los RPCs admin*)
// Inyectados por Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { z } from "https://esm.sh/zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const PRESENCE_ONLINE_MS = 35_000;

function nowIso() {
  return new Date().toISOString();
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"; // sin O/0/1/I
function generateCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

async function generateUniqueCode(maxAttempts = 15): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateCode();
    const { data, error } = await supabase
      .from("rooms")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return code;
  }
  throw new Error("could_not_generate_unique_code");
}

type SeatKind = "human" | "bot" | "empty";

interface RoomRow {
  id: string;
  code: string;
  sala_slug: string | null;
  status: "lobby" | "playing" | "finished" | "abandoned";
  target_cames: number;
  target_cama: number;
  turn_timeout_sec: number;
  initial_mano: number;
  seat_kinds: SeatKind[];
  host_device: string;
  match_state: unknown;
  turn_started_at: string | null;
  paused_at: string | null;
  pending_proposal: unknown;
  created_at: string;
  updated_at: string;
}

interface PlayerRow {
  room_id: string;
  seat: number;
  device_id: string;
  name: string;
  last_seen: string;
}

function rowToRoomDTO(r: RoomRow) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    targetCames: r.target_cames,
    targetCama: r.target_cama,
    turnTimeoutSec: r.turn_timeout_sec,
    initialMano: r.initial_mano,
    seatKinds: r.seat_kinds,
    hostDevice: r.host_device,
    matchState: r.match_state ?? null,
    turnStartedAt: r.turn_started_at,
    pausedAt: r.paused_at,
    pendingProposal: r.pending_proposal ?? null,
  };
}

function playerRowToDTO(p: PlayerRow) {
  const ageMs = Date.now() - new Date(p.last_seen).getTime();
  return {
    seat: p.seat,
    name: p.name,
    deviceId: p.device_id,
    isOnline: ageMs <= PRESENCE_ONLINE_MS,
    lastSeen: p.last_seen,
  };
}

async function fetchRoomById(roomId: string): Promise<RoomRow | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RoomRow | null) ?? null;
}

async function fetchRoomByCode(code: string): Promise<RoomRow | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as RoomRow | null) ?? null;
}

async function fetchPlayers(roomId: string): Promise<PlayerRow[]> {
  const { data, error } = await supabase
    .from("room_players")
    .select("*")
    .eq("room_id", roomId)
    .order("seat", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlayerRow[];
}

function requireAdmin(password: unknown) {
  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) throw new Error("admin_not_configured");
  if (typeof password !== "string" || password !== expected) {
    throw new Error("forbidden");
  }
}

// ---------------------------------------------------------------------------
// Handlers — Fase 2
// ---------------------------------------------------------------------------

// ---- createRoom -----------------------------------------------------------
const CreateRoomSchema = z.object({
  hostDevice: z.string().min(1),
  hostName: z.string().min(1).max(40),
  targetCames: z.number().int().min(1).max(10),
  targetCama: z.number().int().refine((n) => n === 9 || n === 12).optional(),
  turnTimeoutSec: z.number().int().min(5).max(180).optional(),
  initialMano: z.number().int().min(0).max(3),
  seatKinds: z.array(z.enum(["human", "bot", "empty"])).length(4),
  hostSeat: z.number().int().min(0).max(3),
  salaSlug: z.string().min(1).max(40).optional(),
  requestedCode: z.string().min(6).max(6).optional(),
});

async function createRoom(input: z.infer<typeof CreateRoomSchema>) {
  const seatKinds = [...input.seatKinds];
  if (seatKinds[input.hostSeat] !== "human") seatKinds[input.hostSeat] = "human";

  let code = input.requestedCode?.toUpperCase();
  if (code) {
    const exists = await fetchRoomByCode(code);
    if (exists) code = undefined;
  }
  if (!code) code = await generateUniqueCode();

  const { data: room, error } = await supabase
    .from("rooms")
    .insert({
      code,
      sala_slug: input.salaSlug ?? null,
      status: "lobby",
      target_cames: input.targetCames,
      target_cama: input.targetCama ?? 12,
      turn_timeout_sec: input.turnTimeoutSec ?? 30,
      initial_mano: input.initialMano,
      seat_kinds: seatKinds,
      host_device: input.hostDevice,
    })
    .select("id, code")
    .single();
  if (error) throw new Error(error.message);

  const { error: pErr } = await supabase.from("room_players").insert({
    room_id: room.id,
    seat: input.hostSeat,
    device_id: input.hostDevice,
    name: input.hostName,
    last_seen: nowIso(),
  });
  if (pErr) throw new Error(pErr.message);

  return { code: room.code as string, roomId: room.id as string };
}

// ---- joinRoom -------------------------------------------------------------
const JoinRoomSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1),
  name: z.string().min(1).max(40),
  preferredSeat: z.number().int().min(0).max(3).nullable().optional(),
});

async function joinRoom(input: z.infer<typeof JoinRoomSchema>) {
  const code = input.code.toUpperCase();
  const room = await fetchRoomByCode(code);
  if (!room) throw new Error("room_not_found");
  if (room.status === "finished" || room.status === "abandoned") {
    throw new Error("room_closed");
  }

  const players = await fetchPlayers(room.id);

  // ¿Ya estoy dentro? -> reentrada
  const mine = players.find((p) => p.device_id === input.deviceId);
  if (mine) {
    // Refresca nombre + last_seen
    await supabase
      .from("room_players")
      .update({ name: input.name, last_seen: nowIso() })
      .eq("room_id", room.id)
      .eq("seat", mine.seat);
    return { roomId: room.id, code: room.code, seat: mine.seat };
  }

  const occupied = new Set(players.map((p) => p.seat));
  const seatKinds = room.seat_kinds;

  // Asiento candidato
  let seat: number | null = null;
  if (
    input.preferredSeat != null &&
    !occupied.has(input.preferredSeat) &&
    seatKinds[input.preferredSeat] !== "bot"
  ) {
    seat = input.preferredSeat;
  } else {
    for (let i = 0; i < 4; i++) {
      if (occupied.has(i)) continue;
      if (seatKinds[i] === "bot") continue;
      seat = i;
      break;
    }
  }
  if (seat == null) throw new Error("room_full");

  const { error } = await supabase.from("room_players").insert({
    room_id: room.id,
    seat,
    device_id: input.deviceId,
    name: input.name,
    last_seen: nowIso(),
  });
  if (error) throw new Error(error.message);

  // Marca el seat como humano (por si estaba "empty")
  if (seatKinds[seat] === "empty") {
    const next = [...seatKinds];
    next[seat] = "human";
    await supabase.from("rooms").update({ seat_kinds: next }).eq("id", room.id);
  }

  return { roomId: room.id, code: room.code, seat };
}

// ---- getRoom --------------------------------------------------------------
const GetRoomSchema = z.object({
  code: z.string().min(6).max(6),
  deviceId: z.string().min(1).nullable().optional(),
});

async function getRoom(input: z.infer<typeof GetRoomSchema>) {
  const room = await fetchRoomByCode(input.code.toUpperCase());
  if (!room) throw new Error("room_not_found");
  const players = await fetchPlayers(room.id);
  const mySeat = input.deviceId
    ? players.find((p) => p.device_id === input.deviceId)?.seat ?? null
    : null;
  return {
    room: rowToRoomDTO(room),
    players: players.map(playerRowToDTO),
    mySeat,
  };
}

// ---- listLobbyRooms -------------------------------------------------------
async function listLobbyRooms(_input: unknown) {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("status", "lobby")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const rooms = (data ?? []) as RoomRow[];
  if (rooms.length === 0) return { rooms: [] };

  const ids = rooms.map((r) => r.id);
  const { data: pdata, error: pErr } = await supabase
    .from("room_players")
    .select("*")
    .in("room_id", ids);
  if (pErr) throw new Error(pErr.message);
  const byRoom = new Map<string, PlayerRow[]>();
  for (const p of (pdata ?? []) as PlayerRow[]) {
    const list = byRoom.get(p.room_id) ?? [];
    list.push(p);
    byRoom.set(p.room_id, list);
  }

  return {
    rooms: rooms.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      targetCames: r.target_cames,
      targetCama: r.target_cama,
      turnTimeoutSec: r.turn_timeout_sec,
      seatKinds: r.seat_kinds,
      hostDevice: r.host_device,
      players: (byRoom.get(r.id) ?? []).map((p) => ({
        seat: p.seat,
        name: p.name,
        isOnline:
          Date.now() - new Date(p.last_seen).getTime() <= PRESENCE_ONLINE_MS,
      })),
    })),
  };
}

// ---- listMyActiveRooms ----------------------------------------------------
const ListMyActiveSchema = z.object({ deviceId: z.string().min(1) });

async function listMyActiveRooms(input: z.infer<typeof ListMyActiveSchema>) {
  const { data: prows, error } = await supabase
    .from("room_players")
    .select("room_id, seat")
    .eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  const ids = (prows ?? []).map((p: any) => p.room_id);
  if (ids.length === 0) return { rooms: [] };

  const { data: rrows, error: rErr } = await supabase
    .from("rooms")
    .select("id, code, status, target_cames, updated_at")
    .in("id", ids)
    .eq("status", "playing");
  if (rErr) throw new Error(rErr.message);

  const seatByRoom = new Map<string, number>();
  for (const p of (prows ?? []) as { room_id: string; seat: number }[]) {
    seatByRoom.set(p.room_id, p.seat);
  }
  return {
    rooms: (rrows ?? []).map((r: any) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      targetCames: r.target_cames,
      updatedAt: r.updated_at,
      mySeat: seatByRoom.get(r.id) ?? null,
    })),
  };
}

// ---- heartbeat ------------------------------------------------------------
const HeartbeatSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
});

async function heartbeat(input: z.infer<typeof HeartbeatSchema>) {
  const { error } = await supabase
    .from("room_players")
    .update({ last_seen: nowIso() })
    .eq("room_id", input.roomId)
    .eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

// ---- leaveRoom ------------------------------------------------------------
const LeaveRoomSchema = HeartbeatSchema;

async function leaveRoom(input: z.infer<typeof HeartbeatSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) return { ok: true as const, abandoned: false };

  await supabase
    .from("room_players")
    .delete()
    .eq("room_id", room.id)
    .eq("device_id", input.deviceId);

  const remaining = await fetchPlayers(room.id);

  // Si no queda nadie humano, abandona y borra la sala (limpieza inmediata).
  if (remaining.length === 0) {
    await supabase.from("rooms").delete().eq("id", room.id);
    return { ok: true as const, abandoned: true };
  }

  // Si se va el host, traspasa a otro humano cualquiera.
  if (room.host_device === input.deviceId) {
    const newHost = remaining[0]!;
    await supabase
      .from("rooms")
      .update({ host_device: newHost.device_id })
      .eq("id", room.id);
  }
  return { ok: true as const, abandoned: false };
}

// ---- setRoomSettings ------------------------------------------------------
const SetSettingsSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  targetCames: z.number().int().min(1).max(10).optional(),
  targetCama: z.number().int().refine((n) => n === 9 || n === 12).optional(),
  turnTimeoutSec: z.number().int().min(5).max(180).optional(),
});

async function setRoomSettings(input: z.infer<typeof SetSettingsSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");

  const patch: Record<string, unknown> = {};
  if (input.targetCames != null) patch.target_cames = input.targetCames;
  if (input.targetCama != null) patch.target_cama = input.targetCama;
  if (input.turnTimeoutSec != null) patch.turn_timeout_sec = input.turnTimeoutSec;
  if (Object.keys(patch).length === 0) return { ok: true as const };

  const { error } = await supabase.from("rooms").update(patch).eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

// ---- setSeatKind ----------------------------------------------------------
const SetSeatKindSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  seat: z.number().int().min(0).max(3),
  kind: z.enum(["human", "bot", "empty"]),
});

async function setSeatKind(input: z.infer<typeof SetSeatKindSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");

  // Si hay un humano sentado, no se puede cambiar el tipo (que se vaya antes).
  const players = await fetchPlayers(room.id);
  const occupied = players.find((p) => p.seat === input.seat);
  if (occupied && input.kind !== "human") {
    throw new Error("seat_occupied_by_human");
  }

  const next = [...room.seat_kinds];
  next[input.seat] = input.kind;
  const { error } = await supabase
    .from("rooms")
    .update({ seat_kinds: next })
    .eq("id", room.id);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

// ---- updatePlayerName -----------------------------------------------------
const UpdateNameSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
  name: z.string().min(1).max(40),
});

async function updatePlayerName(input: z.infer<typeof UpdateNameSchema>) {
  const { error } = await supabase
    .from("room_players")
    .update({ name: input.name })
    .eq("room_id", input.roomId)
    .eq("device_id", input.deviceId);
  if (error) throw new Error(error.message);
  return { ok: true as const };
}

// ---- adminCloseRoom -------------------------------------------------------
const AdminCloseSchema = z.object({
  roomId: z.string().uuid(),
  password: z.string().min(1),
});

async function adminCloseRoom(input: z.infer<typeof AdminCloseSchema>) {
  requireAdmin(input.password);
  await supabase.from("rooms").delete().eq("id", input.roomId);
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Motor mínimo del juego — Fase 4 (inicio)
// ---------------------------------------------------------------------------

type Suit = "oros" | "copes" | "espases" | "bastos";
type Rank = 1 | 3 | 4 | 5 | 6 | 7;
interface Card { suit: Suit; rank: Rank; id: string }

const ENGINE_SUITS: Suit[] = ["oros", "copes", "espases", "bastos"];
const ENGINE_RANKS: Rank[] = [1, 3, 4, 5, 6, 7];

// Mazo de Truc Valencià: 22 cartas.
//   - 3, 4, 5, 6, 7 en los cuatro palos (20 cartas)
//   - 1 de espases y 1 de bastos (2 cartas)
//   Se eliminan por completo: 2, 8, 9, 10, 11, 12.
function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of ENGINE_SUITS) {
    for (const rank of ENGINE_RANKS) {
      // El 1 sólo existe en espases y bastos.
      if (rank === 1 && suit !== "espases" && suit !== "bastos") continue;
      deck.push({ suit, rank, id: `${rank}-${suit}` });
    }
  }
  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---- startMatch -----------------------------------------------------------
const StartMatchSchema = z.object({
  roomId: z.string().uuid(),
  deviceId: z.string().min(1),
});

async function startMatch(input: z.infer<typeof StartMatchSchema>) {
  const room = await fetchRoomById(input.roomId);
  if (!room) throw new Error("room_not_found");
  if (room.host_device !== input.deviceId) throw new Error("forbidden");
  if (room.status !== "lobby") throw new Error("not_in_lobby");

  // Verifica que los 4 asientos están cubiertos (humano sentado o bot).
  const players = await fetchPlayers(room.id);
  const occupied = new Set(players.map((p) => p.seat));
  for (let i = 0; i < 4; i++) {
    if (room.seat_kinds[i] === "human" && !occupied.has(i)) {
      throw new Error("seat_empty:" + i);
    }
    if (room.seat_kinds[i] === "empty") throw new Error("seat_empty:" + i);
  }

  // Reparte 12 cartas (3 por jugador) siguiendo el orden de la mano.
  const deck = shuffle(buildDeck());
  const hands: Record<number, Card[]> = { 0: [], 1: [], 2: [], 3: [] };
  const mano = room.initial_mano as 0 | 1 | 2 | 3;
  const dealer = ((mano + 3) % 4) as 0 | 1 | 2 | 3;
  let p = mano;
  for (let i = 0; i < 12; i++) {
    hands[p]!.push(deck[i]!);
    p = ((p + 1) % 4) as 0 | 1 | 2 | 3;
  }

  const nowTs = nowIso();

  // Forma exacta del MatchState que espera el frontend (src/game/types.ts).
  const matchState = {
    scores: {
      nos: { males: 0, bones: 0 },
      ells: { males: 0, bones: 0 },
    },
    camesWon: { nos: 0, ells: 0 },
    cames: 0,
    targetCama: room.target_cama,
    targetCames: room.target_cames,
    dealer,
    history: [] as unknown[],
    round: {
      hands,
      mano,
      turn: mano,
      tricks: [{ cards: [] as unknown[] }],
      trucState: { kind: "none", level: 0 },
      envitState: { kind: "none" },
      envitResolved: false,
      phase: "envit",
      log: [{ type: "deal", dealer }],
    },
  };

  const { error } = await supabase
    .from("rooms")
    .update({
      status: "playing",
      match_state: matchState,
      turn_started_at: nowTs,
      paused_at: null,
      pending_proposal: null,
    })
    .eq("id", room.id);
  if (error) throw new Error(error.message);

  return { ok: true as const, roomId: room.id, mano, turn: mano };
}

// ---------------------------------------------------------------------------
// Stubs para fases siguientes
// ---------------------------------------------------------------------------
const notImplemented = async () => {
  throw new Error("not_implemented");
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type Handler = (data: unknown) => Promise<unknown>;

function withSchema<S extends z.ZodTypeAny>(
  schema: S,
  fn: (input: z.infer<S>) => Promise<unknown>,
): Handler {
  return async (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        "invalid_input:" + JSON.stringify(parsed.error.flatten().fieldErrors),
      );
    }
    return fn(parsed.data);
  };
}

const handlers: Record<string, Handler> = {
  ping: async () => ({ ok: true as const, version: "phase-2" }),

  // Fase 2
  createRoom: withSchema(CreateRoomSchema, createRoom),
  joinRoom: withSchema(JoinRoomSchema, joinRoom),
  getRoom: withSchema(GetRoomSchema, getRoom),
  listLobbyRooms: listLobbyRooms as Handler,
  listMyActiveRooms: withSchema(ListMyActiveSchema, listMyActiveRooms),
  heartbeat: withSchema(HeartbeatSchema, heartbeat),
  leaveRoom: withSchema(LeaveRoomSchema, leaveRoom),
  setRoomSettings: withSchema(SetSettingsSchema, setRoomSettings),
  setSeatKind: withSchema(SetSeatKindSchema, setSeatKind),
  updatePlayerName: withSchema(UpdateNameSchema, updatePlayerName),
  adminCloseRoom: withSchema(AdminCloseSchema, adminCloseRoom),

  // Fase 3 — chats y moderación
  sendChatPhrase: notImplemented,
  sendTextMessage: notImplemented,
  flagPlayerInChat: notImplemented,
  adminListChatFlags: notImplemented,
  adminDecideChatFlag: notImplemented,
  adminListChatFlagAudit: notImplemented,

  // Fase 4 — motor del juego
  startMatch: withSchema(StartMatchSchema, startMatch),
  submitAction: notImplemented,
  setPaused: notImplemented,
  rematchStay: notImplemented,
  proposeAction: notImplemented,
  respondProposal: notImplemented,
  cancelProposal: notImplemented,

  // Fase 5 — bots
  advanceBots: notImplemented,
};

function resolveFn(fn: string): string {
  const normalized = fn.replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "startmatch") return "startMatch";
  return fn;
}

const RequestSchema = z.object({
  fn: z.string().min(1),
  data: z.unknown().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_body" }, 400);

  const { fn, data } = parsed.data;
  const handlerKey = resolveFn(fn);
  const handler = handlers[handlerKey];
  if (!handler) return json({ error: `unknown_fn:${fn}` }, 400);

  try {
    const result = await handler(data);
    return json(result ?? { ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "not_implemented" ? 501
      : msg === "forbidden" ? 403
      : msg === "room_not_found" ? 404
      : 400;
    return json({ error: msg }, status);
  }
});