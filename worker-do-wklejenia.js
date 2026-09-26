// ===========================================================================
// ICON LAB WORKER — accounts (Firebase Auth) + tokens (Firestore) + payments
// (Stripe) + CHATS (Firestore) + generating:
//   - images (OpenAI images) in two CATEGORIES: "icon" and "thumbnail"
//   - 3D models (Tripo: Text-to-3D + Image-to-3D)
//   - free CHAT with automatic intent detection (Gemini)
//   - UI -> LUA: UI screenshot from Roblox -> responsive LocalScript
// ============================================================================

const FREE_TOKENS_ON_SIGNUP = 3;

const TOKEN_PACKAGES = {
    starter: { tokens: 50, priceEnv: "STRIPE_PRICE_STARTER" },
    basic: { tokens: 110, priceEnv: "STRIPE_PRICE_BASIC" },
    creator: { tokens: 290, priceEnv: "STRIPE_PRICE_CREATOR" },
    pro: { tokens: 620, priceEnv: "STRIPE_PRICE_PRO" },
    studio: { tokens: 1300, priceEnv: "STRIPE_PRICE_STUDIO" }
};

const TOKEN_COSTS = {
    imageGeneration: 2,
    imageToUi: 2,
    codeGeneration: 1,
    textTo3d: 25,
    textTo3dTexture: 30,
    imageTo3d: 30,
    imageTo3dTexture: 35,

    // Bench work on a model that already exists. Cheaper than generating one,
    // because that is what it is: a pass over geometry we already paid for.
    meshRepair: 5,      // decimate, complete, segment
    meshTexture: 12,    // new UVs and a PBR bake
    meshRig: 8,         // rig-check is free, rig is not
    meshAnimate: 6,     // retarget onto an existing rig
    meshConvert: 2,     // a format change, nothing is computed
    multiview3d: 35     // several views into one mesh
};

// What each bench operation costs and which V3 route it is. rig-check is
// deliberately free: it only reports whether rigging is possible at all, and
// charging for a "no" would be charging for a refusal.
const TRIPO_V3_OPS = {
    decimate:    { path: "/mesh/decimate",          cost: "meshRepair" },
    segment:     { path: "/mesh/segment",           cost: "meshRepair" },
    complete:    { path: "/mesh/complete",          cost: "meshRepair" },
    texture:     { path: "/models/texture",         cost: "meshTexture" },
    convert:     { path: "/models/convert",         cost: "meshConvert" },
    "rig-check": { path: "/animations/rig-check",   cost: null },
    rig:         { path: "/animations/rig",         cost: "meshRig" },
    retarget:    { path: "/animations/retarget",    cost: "meshAnimate" },
    multiview:   { path: "/generation/multiview-to-model", cost: "multiview3d" }
};

// Marża doliczana do realnego kosztu API, żeby generowanie kodu zawsze się opłacało.
const MARGIN_MULTIPLIER = 1.15;


// Gemini 3.8 Flash stays as the one alternative for code: it scores higher on
// coding benchmarks and the user pays its real cost. Introductory rate until
// 31 December 2026; from 1 January 2027 it doubles to $1.50/$7.50.
const GEMINI_CODE_MODEL = "gemini-3.8-flash";
const GEMINI_CODE_PRICE_INPUT_PER_M = 0.75;
const GEMINI_CODE_PRICE_OUTPUT_PER_M = 3.75;

const DEFAULT_CODE_MODEL = "luna"; // "luna" | "gemini"

// GPT-6 Luna, released 22 September 2026. It runs the assistant, UI -> Lua,
// code by default and the Studio agent. Rates per 1M tokens: $0.10 input,
// $0.01 cached input, $0.125 cache write, $0.50 output — half of GPT-5.6 Luna.
//
// OpenAI writes any prompt prefix past 1,024 tokens to its cache and bills
// that write at 1.25x input; usage reports it as cache_write_tokens. When a
// response leaves that field out, all uncached input is billed at the write
// rate, which can only err on the side of covering the bill.
const LUNA_MODEL = "gpt-6-luna";
const LUNA_API_BASE = "https://api.openai.com/v1";
const LUNA_PRICE_INPUT_PER_M = 0.10;
const LUNA_PRICE_CACHE_WRITE_PER_M = 0.125;
const LUNA_PRICE_CACHED_PER_M = 0.01;
const LUNA_PRICE_OUTPUT_PER_M = 0.50;

// The assistant reasons a little before it answers: enough to pick the right
// action, not so much that the first streamed word is seconds late.
const ASSISTANT_REASONING_EFFORT = "low";

// The assistant is GPT-6 behind a chat box, so it is metered. Each account
// gets a few messages a day free; after that every reply is charged at what
// it actually cost, in thousandths of a token and with no margin, so it
// comes out even. The rest are limits no person hits and every script does.
const CHAT_FREE_PER_DAY = 3;
const CHAT_MAX_PER_MINUTE = 6;
const CHAT_MAX_PER_DAY = 300;
const CHAT_MAX_MESSAGE_CHARS = 4000;
const CHAT_MAX_IMAGES = 3;
const CHAT_MAX_IMAGE_CHARS = 8_000_000;   // one data URL, ~6 MB of picture
const CHAT_MAX_OUTPUT_TOKENS = 2500;      // includes the model's reasoning
const CHAT_MIN_MILLI = 1;

// Wartość 1 tokena platformy w USD, liczona z NAJTAŃSZEGO pakietu
// (Studio: 1300 tokenów / $27.99) — czyli najgorszego dla nas przypadku,
// żeby generowanie zawsze się zwracało niezależnie jaki pakiet kupił user.
const TOKEN_VALUE_USD = 27.99 / 1300; // ≈ 0.02153 $/token

const CODE_GEN_MIN_MILLI_TOKENS = 5; // minimalna opłata za pojedyncze wywołanie

const MAX_THUMBNAIL_BYTES = 400_000;
const CHATS_PAGE_SIZE = 60;
const MESSAGES_PAGE_SIZE = 100;
const CHAT_TITLE_MAX_LEN = 60;
const CHAT_CONTEXT_MESSAGES = 10;

// The assistant's fallback: if GPT-6 Luna cannot answer, the same request
// goes to Gemini 3.6 Flash, which ran the assistant before. $0.75/$3.75.
const ASSISTANT_FALLBACK_MODEL = "gemini-3.6-flash";
// Retry policy shared by every model call below (the name is historical).
const GEMINI_MAX_RETRIES = 2;
const GEMINI_RETRY_BASE_DELAY_MS = 600;

const OPENAI_IMAGE_MODEL = "gpt-image-2";
const OPENAI_IMAGE_QUALITY = "low";

const TRIPO_API_BASE = "https://api.tripo3d.ai/v2/openapi";

// V3 runs alongside V2 rather than replacing it. Generation stays on V2,
// which is tuned and working; the bench operations below exist only in V3.
// They take a public HTTPS URL as their input, and every model we produce is
// already served from R2 over HTTPS, so nothing has to be re-uploaded and no
// V2 task id ever has to be understood by V3.
const TRIPO_V3_BASE = "https://openapi.tripo3d.ai/v3";
const TRIPO_MODEL_VERSION_P1 = "P1-20260311"; // niski, czysty poly-count — pod Roblox/gry
const TRIPO_MODEL_VERSION_H  = "v3.1-20260211";
const TRIPO_P1_MAX_FACE_LIMIT = 20000;
const TRIPO_P1_MIN_FACE_LIMIT = 48;
const TRIPO_H_MAX_FACE_LIMIT = 2000000;
const TRIPO_H_MIN_FACE_LIMIT = 500;

const H_ADDON_COSTS = {
    textureDetailed: 5,
    textureExtreme: 10,
    hdGeometry: 10,
    quadMesh: 5,
    smartLowPoly: 5,
    generateParts: 10
};

// ── Community Store ──
const SHARE_SELL_DISCOUNT = 1;
const CREATOR_REVENUE_PERCENT = 20;
const STORE_PAGE_SIZE = 24;
const PLATFORM_SYSTEM_UID = "PLATFORM_SYSTEM";
const STORE_CATEGORIES = ["props", "buildings", "vehicles", "characters", "environment", "nature", "roblox", "weapons", "other"];

function normalizeSettings(s) {
    s = s || {};
    const allowedPoly = [500, 1000, 2000, 5000, 10000, 15000, 20000];
    const series = s.series === "h" ? "h" : "p1";

    return {
        series,
        polygonCount: allowedPoly.includes(Number(s.polygonCount)) ? Number(s.polygonCount) : 10000,
        geometryQuality: s.geometryQuality === "detailed" ? "detailed" : "standard",
        lowPoly: !!s.lowPoly,
        textures: !!s.textures,
        pbr: !!s.textures && !!s.pbr,
        textureQuality: ["standard", "detailed", "extreme"].includes(s.textureQuality) ? s.textureQuality : "standard",

        // --- opcje wyłącznie dla H-Series ---
        hdTexture: series === "h" && !!s.hdTexture,
        ultra8kTexture: series === "h" && !!s.ultra8kTexture,
        hdGeometry: series === "h" && !!s.hdGeometry,
        quadMesh: series === "h" && !!s.quadMesh,
        smartLowPoly: series === "h" && !!s.smartLowPoly,
        generateParts: series === "h" && !!s.generateParts
    };
}

// Jedyne, autorytatywne miejsce liczenia kosztu — zawsze licz po stronie
// workera (frontend tylko odzwierciedla tę samą logikę dla podglądu).
function calcModel3DCost(rawSettings, isImage = false) {
    const s = normalizeSettings(rawSettings);
    
    let base = isImage
        ? (s.textures ? TOKEN_COSTS.imageTo3dTexture : TOKEN_COSTS.imageTo3d)
        : (s.textures ? TOKEN_COSTS.textTo3dTexture : TOKEN_COSTS.textTo3d);

    if (s.series === "h") {
        base = 15;
        
        if (s.textures) {
            base += 5;
            if (s.textureQuality === "detailed") base += H_ADDON_COSTS.textureDetailed;
            if (s.textureQuality === "extreme") base += H_ADDON_COSTS.textureExtreme;
        }
        if (s.hdGeometry) base += H_ADDON_COSTS.hdGeometry;
        if (s.quadMesh) base += H_ADDON_COSTS.quadMesh;
        if (s.smartLowPoly) base += H_ADDON_COSTS.smartLowPoly;
        if (s.generateParts) base += H_ADDON_COSTS.generateParts;
    }
    
    return base;
}

async function tripoUploadImage(env, imageDataUrl) {
    const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) throw new Error("Nieprawidłowy format obrazu");
    const [, mimeType, base64] = match;
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    const form = new FormData();
    form.append("file", new Blob([binary], { type: mimeType }), "reference.png");

    const res = await fetch(`${TRIPO_API_BASE}/upload/sts`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}` },
        body: form
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0) throw new Error(data.message || JSON.stringify(data));
    return data.data.image_token;
}

function buildTripoTaskBody({ type, prompt, imageToken, settings }) {
    const s = normalizeSettings(settings);
    const isH = s.series === "h";

    const modelVersion = isH ? TRIPO_MODEL_VERSION_H : TRIPO_MODEL_VERSION_P1;
    const minLimit = isH ? TRIPO_H_MIN_FACE_LIMIT : TRIPO_P1_MIN_FACE_LIMIT;
    const maxLimit = isH ? TRIPO_H_MAX_FACE_LIMIT : TRIPO_P1_MAX_FACE_LIMIT;

    const clampedFaceLimit = Math.min(Math.max(s.polygonCount, minLimit), maxLimit);

    const body = {
        type,
        model_version: modelVersion,
        face_limit: clampedFaceLimit
    };

    // Dla generate_parts nie wysyłamy tekstur, pbr, quad, smart_low_poly
    if (!isH || (isH && !s.generateParts)) {
        body.texture = s.textures;
        body.pbr = s.textures && s.pbr;
        body.format = (isH && s.quadMesh) ? "FBX" : "GLB";
    } else {
        body.generate_parts = true;
        body.format = "GLB";
    }

    if (body.texture) {
        body.texture_quality = s.textureQuality;
    }

    if (isH && !s.generateParts) {
        if (s.hdGeometry) body.geometry_quality = "detailed";
        if (s.quadMesh) body.quad = true;
        if (s.smartLowPoly) body.smart_low_poly = true;
    }

    if (type === "text_to_model") body.prompt = String(prompt || "").slice(0, 600);
    if (type === "image_to_model") body.file = { type: "image", file_token: imageToken };

    return body;
}

async function tripoCreateTask(env, body) {
    console.log("TRIPO CREATE TASK BODY:", JSON.stringify(body));
    const res = await fetch(`${TRIPO_API_BASE}/task`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log("TRIPO CREATE TASK RESPONSE:", JSON.stringify(data));
    if (!res.ok || data.code !== 0) throw new Error(data.message || JSON.stringify(data));
    return data.data.task_id;
}

// The API describes input as "task_id, file_token, or URL" — one value,
// not a wrapper — and rejects the object form the documentation showed.
// Both shapes are built here so the call can fall back to the other one.
function tripoV3Ref(ref) {
    const v = String(ref || "").trim();
    if (!v) throw new Error("Missing input model");
    return v;
}

function tripoV3Input(ref) {
    const v = tripoV3Ref(ref);
    if (/^https?:\/\//i.test(v)) return { url: v };
    if (/^task[_-]/i.test(v)) return { task_id: v };
    return { file_token: v };
}

// A mesh from someone's disk is neither a task id nor a public URL, so it
// is given one: the file goes into R2 and is referred to by the address it
// is served from, which is the same shape the bench already uses for a
// model this app generated. Tripo fetches it itself, so nothing is pushed
// through an upload endpoint. The body is streamed straight into the
// bucket rather than base64'd into JSON — these files run to tens of
// megabytes.
const TRIPO_MODEL_TYPES = {
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    fbx: "application/octet-stream",
    obj: "text/plain",
    stl: "model/stl"
};

async function handleTripoUpload(request, env) {
    const uid = await requireAuth(request, env);
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "model.glb").replace(/[^\w.\-]/g, "_");
    const ext = (name.includes(".") ? name.split(".").pop() : "glb").toLowerCase();
    if (!TRIPO_MODEL_TYPES[ext]) {
        return json({ error: `${ext.toUpperCase()} is not a mesh Tripo reads — use GLB, GLTF, FBX, OBJ or STL.` }, 400);
    }

    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: "Empty file" }, 400);
    if (bytes.byteLength > 150 * 1024 * 1024) return json({ error: "Over Tripo's 150 MB limit" }, 413);

    const key = `uploads/mesh/${uid}-${Date.now()}-${crypto.randomUUID()}.${ext}`;
    await env.ASSETS_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: TRIPO_MODEL_TYPES[ext] }
    });
    const ref = `${env.PUBLIC_WORKER_URL}/asset/${encodeURIComponent(key)}`;

    // fileToken is kept alongside ref so an older page keeps working.
    return json({ ref, fileToken: ref, name });
}

// The V3 paths here were read off documentation rather than off the API,
// and /files/upload turned out not to exist. This asks the API itself:
// every candidate path gets an empty POST, and a path that answers with a
// complaint about the BODY exists, while "No endpoint found" means it does
// not. Read-only as far as Tripo is concerned — an empty body never starts
// a task. Safe to delete once the paths are settled.
const TRIPO_V3_PROBE_PATHS = [
    "/mesh/decimate", "/mesh/segment", "/mesh/complete",
    "/models/texture", "/models/convert",
    "/animations/rig-check", "/animations/rig", "/animations/retarget",
    "/generation/multiview-to-model",
    "/files/upload", "/file/upload", "/upload", "/files", "/uploads",
    "/task", "/tasks"
];

async function handleTripoProbe(request, env) {
    await requireAuth(request, env);
    const out = [];
    for (const path of TRIPO_V3_PROBE_PATHS) {
        try {
            const res = await fetch(`${TRIPO_V3_BASE}${path}`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}`, "Content-Type": "application/json" },
                body: "{}"
            });
            const text = (await res.text()).slice(0, 300);
            let message = text;
            try { const d = JSON.parse(text); message = d.message || d.error || text; } catch (e) { /* keep the text */ }
            out.push({ path, status: res.status, exists: !/no endpoint found/i.test(message), message });
        } catch (e) {
            out.push({ path, status: 0, exists: false, message: String(e && e.message || e) });
        }
    }
    return json({ base: TRIPO_V3_BASE, results: out });
}

async function tripoV3Post(env, op, body) {
    const spec = TRIPO_V3_OPS[op];
    if (!spec) throw new Error("Unknown operation: " + op);
    const res = await fetch(`${TRIPO_V3_BASE}${spec.path}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    console.log("TRIPO V3", op, res.status, JSON.stringify(data).slice(0, 400));
    const ok = res.ok && data.code === 0;
    return {
        ok,
        data: data.data,
        status: res.status,
        message: data.message || data.error || (ok ? "" : `Tripo V3 ${op} failed (${res.status})`)
    };
}

async function tripoV3Create(env, op, body) {
    const raw = body && body.input;
    let out = await tripoV3Post(env, op, body);

    // The two candidate shapes for input are a bare string and a one-key
    // object. Documentation showed the object; the API asks for the string.
    // Rather than leave the user holding an error either of them would have
    // answered, the other shape is tried once when the complaint names input.
    if (!out.ok && typeof raw === "string" && /\binput\b/i.test(out.message || "")) {
        console.log("TRIPO V3", op, "retrying with the object input shape");
        out = await tripoV3Post(env, op, { ...body, input: tripoV3Input(raw) });
    }

    if (!out.ok) throw new Error(out.message || `Tripo V3 ${op} failed (${out.status})`);
    return out.data;
}

async function tripoV3Get(env, taskId) {
    const res = await fetch(`${TRIPO_V3_BASE}/tasks/${encodeURIComponent(taskId)}`, {
        headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) throw new Error(data.message || `Tripo V3 status failed (${res.status})`);
    return data.data;
}

async function tripoGetTask(env, taskId) {
    const res = await fetch(`${TRIPO_API_BASE}/task/${taskId}`, {
        headers: { "Authorization": `Bearer ${env.TRIPO_API_KEY}` }
    });
    const data = await res.json();
    if (data.data?.status === "success") console.log("TRIPO TASK SUCCESS:", JSON.stringify(data.data));
    if (!res.ok || data.code !== 0) throw new Error(data.message || JSON.stringify(data));
    return data.data;
}

const MODES = {
    TEXT: "text2img",
    EDIT: "image2img",
    STYLE: "reference2img"
};

const CATEGORIES = {
    ICON: "icon",
    THUMBNAIL: "thumbnail"
};

// The image API takes a fixed set of sizes, not arbitrary dimensions: 1920x1080
// is rejected, so asking for it only burns a failed call before the retry.
// 1536x1024 is the widest landscape on offer. It is 3:2, not the 16:9 a Roblox
// thumbnail wants, which has to come from cropping rather than from the API.
const IMAGE_SIZE_BY_CATEGORY = {
    icon: "1024x1024",
    thumbnail: "1536x1024"
};

export default {

    async fetch(request, env, ctx) {

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders() });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {

            if (request.method === "GET" && path === "/me") {
                return await handleMe(request, env);
            }
            if (request.method === "POST" && path === "/promo/redeem") {
                return await handlePromoRedeem(request, env);
            }
            if (path === "/promo/admin" && (request.method === "GET" || request.method === "POST")) {
                return await handlePromoAdmin(request, env);
            }
            if (request.method === "GET" && path === "/roblox/avatar") {
                return await handleRobloxAvatarProxy(request, env, url);
            }
            if (request.method === "GET" && path === "/auth/roblox/start") {
                return await handleRobloxOAuthStart(request, env);
            }
            if (request.method === "GET" && path === "/auth/roblox/callback") {
                return await handleRobloxOAuthCallback(request, env, url);
            }
            if (request.method === "GET" && path === "/roblox/dev-stats") {
                return await handleRobloxDevStats(request, env);
            }
            if (request.method === "GET" && path === "/roblox/groups") {
                return await handleRobloxGroupsList(request, env);
            }
            if (request.method === "POST" && path === "/roblox/groups") {
                return await handleRobloxGroupsSave(request, env);
            }
            if (request.method === "GET" && path === "/roblox/unlink") {
                return await handleRobloxUnlink(request, env);
            }
            if (request.method === "POST" && path === "/plugin/check") {
                return await handlePluginCheck(request, env);
            }

            if (request.method === "POST" && path === "/settings/theme") {
                return await handleSetTheme(request, env);
            }
            if (request.method === "POST" && path === "/plugin/proxy") {
                return await handlePluginProxy(request, env, ctx);
            }

            if (request.method === "POST" && path === "/enhance") {
                return await handleEnhance(request, env);
            }

            if (request.method === "POST" && path === "/analyze-image") {
                return await handleAnalyzeImage(request, env);
            }

            if (request.method === "POST" && path === "/generate") {
                return await handleGenerate(request, env);
            }

            if (request.method === "POST" && path === "/generate-ui-lua") {
                return await handleGenerateUiLua(request, env);
            }

            if (request.method === "POST" && path === "/generate-code") {
                return await handleGenerateCode(request, env);
            }

            // ── Agent v2 ──
            if (request.method === "POST" && path === "/agent/v2/step") {
                return await handleAgentStepV2(request, env, ctx);
            }
            if (request.method === "POST" && path === "/agent/v2/sync") {
                return await handleAgentSyncV2(request, env);
            }
            if (request.method === "POST" && path === "/agent/v2/forget") {
                return await handleAgentForgetV2(request, env);
            }

            // Legacy agent. Kept so the old plugin keeps working; delete once
            // every user is on the v2 plugin.
            if (request.method === "POST" && path === "/agent/step") {
                return await handleAgentStep(request, env, ctx);
            }

            if (request.method === "POST" && path === "/chat") {
                return await handleChat(request, env);
            }

            if (request.method === "POST" && path === "/chat/stream") {
                return await handleChatStream(request, env);
            }

            if (request.method === "POST" && path === "/tripo/generate") {
                return await handleTripoGenerate(request, env);
            }
            if (request.method === "POST" && path === "/images/edit") {
                return await handleImagesEdit(request, env);
            }
            if (request.method === "POST" && path === "/images/variations") {
                return await handleImagesVariations(request, env);
            }
            if (request.method === "POST" && path === "/tripo/upload") {
                return await handleTripoUpload(request, env);
            }
            // The web page reaching into an open Studio session.
            if (request.method === "POST" && path === "/studio/deploy") {
                return await handleStudioDeploy(request, env, ctx);
            }
            if (request.method === "GET" && path === "/studio/status") {
                return await handleStudioStatus(request, env, url);
            }
            // The page is the machine that does the work: it fetches what the
            // plugin left and posts back what it made of it.
            if (request.method === "GET" && path === "/studio/toolwork") {
                return await handleStudioToolWork(request, env, url);
            }
            if (request.method === "POST" && path === "/studio/toolresult") {
                return await handleStudioToolResult(request, env);
            }

            // The same road the generated decals have always taken: Open
            // Cloud, signed with the user's own linked Roblox account.
            if (request.method === "POST" && path === "/roblox/uploadmodel") {
                return await handleRobloxUploadModel(request, env, url);
            }

            if (request.method === "POST" && path === "/studio/cancel") {
                return await handleStudioCancel(request, env);
            }

            if (request.method === "GET" && path === "/tripo/probe") {
                return await handleTripoProbe(request, env);
            }
            if (request.method === "POST" && path === "/tripo/bench") {
                return await handleTripoBench(request, env);
            }
            if (request.method === "GET" && path === "/tripo/bench/status") {
                return await handleTripoBenchStatus(request, env, url);
            }
            if (request.method === "GET" && path === "/tripo/status") {
                return await handleTripoStatus(request, env, url);
            }
            if (request.method === "GET" && path.startsWith("/asset/")) {
                return await handleServeAsset(request, env, path);
            }
            if (request.method === "GET" && path === "/proxy-download") {
                return await handleProxyDownload(request, env, url);
            }

            if (request.method === "POST" && path === "/create-checkout-session") {
                return await handleCreateCheckout(request, env);
            }

            if (request.method === "POST" && path === "/stripe-webhook") {
                return await handleStripeWebhook(request, env);
            }

            if (request.method === "POST" && path === "/chats") {
                return await handleChatCreate(request, env);
            }

            if (request.method === "GET" && path === "/chats") {
                return await handleChatsList(request, env);
            }


            if (request.method === "POST" && path === "/game-widgets") {
                return await handleGameWidgetAdd(request, env);
            }
            if (request.method === "GET" && path === "/game-widgets/stats") {
                return await handleGameWidgetStatsRefresh(request, env, url);
            }
            if (request.method === "GET" && path === "/game-widgets") {
                return await handleGameWidgetsList(request, env);
            }
            const gwMatch = path.match(/^\/game-widgets\/([^/]+)$/);
            if (gwMatch && request.method === "DELETE") {
                return await handleGameWidgetDelete(request, env, gwMatch[1]);
            }

            const chatMatch = path.match(/^\/chats\/([^/]+)$/);
            if (chatMatch && request.method === "DELETE") {
                return await handleChatDelete(request, env, chatMatch[1]);
            }
            if (chatMatch && request.method === "PATCH") {
                return await handleChatRename(request, env, chatMatch[1]);
            }

            const msgMatch = path.match(/^\/chats\/([^/]+)\/messages$/);
            if (msgMatch && request.method === "POST") {
                return await handleChatMessageAdd(request, env, msgMatch[1]);
            }
            if (msgMatch && request.method === "GET") {
                return await handleChatMessagesList(request, env, msgMatch[1]);
            }

            // ── Community Store routes ──
            if (request.method === "POST" && path === "/store/publish") {
                return await handleStorePublish(request, env);
            }
            if (request.method === "GET" && path === "/store/assets") {
                return await handleStoreAssetsList(request, env, url);
            }
            if (request.method === "GET" && path === "/store/my-library") {
                return await handleStoreMyLibrary(request, env);
            }
            if (request.method === "GET" && path === "/store/my-assets") {
                return await handleStoreMyAssets(request, env);
            }
            if (request.method === "GET" && path === "/store/dashboard") {
                return await handleStoreDashboard(request, env);
            }
            const storeAssetMatch = path.match(/^\/store\/assets\/([^/]+)$/);
            if (storeAssetMatch && request.method === "GET") {
                return await handleStoreAssetDetail(request, env, storeAssetMatch[1]);
            }
            const storeBuyMatch = path.match(/^\/store\/assets\/([^/]+)\/buy$/);
            if (storeBuyMatch && request.method === "POST") {
                return await handleStoreAssetBuy(request, env, storeBuyMatch[1]);
            }
            const storeLikeMatch = path.match(/^\/store\/assets\/([^/]+)\/like$/);
            if (storeLikeMatch && request.method === "POST") {
                return await handleStoreAssetLike(request, env, storeLikeMatch[1]);
            }
            const storeCreatorMatch = path.match(/^\/store\/creator\/([^/]+)$/);
            if (storeCreatorMatch && request.method === "GET") {
                return await handleStoreCreatorProfile(request, env, storeCreatorMatch[1]);
            }

        } catch (error) {
            console.error(error);
            return json({ error: error.message }, error.status || 500);
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders() });
    }
};

// ============================================================================
// AGENT /agent/step
// ============================================================================

const AGENT_SYSTEM_PROMPT = "Jesteś agentem AI asystującym programiście Roblox Studio. Masz dostęp do środowiska Roblox poprzez zestaw narzędzi (tools).\n\n" +
"ZANIM zaczniesz cokolwiek analizować lub tworzyć: jeśli prośba usera jest ogólna lub dotyczy nowego systemu/mechaniki (np. 'zrób system inwentarza', 'dodaj questy') i NIE jest jasne z kontekstu, czy ma to (a) współgrać z istniejącym kodem, czy (b) być zrobione od zera — zapytaj o to KRÓTKO w zwykłej odpowiedzi (BEZ wywoływania narzędzi) i poczekaj na odpowiedź usera, zamiast zgadywać. Jedno, konkretne pytanie wystarczy, np. 'Czy mam to spiąć z Twoim obecnym systemem X, czy wolisz nowy, niezależny moduł?'. Jeśli user już podał wystarczający kontekst (np. wskazał konkretny skrypt/ścieżkę, albo wcześniej w rozmowie ustalono zakres), NIE pytaj ponownie — działaj.\n\n" +
"OSZCZĘDZAJ narzędzia: nie wywołuj describe_project ani search_scripts więcej niż raz na turę, chyba że wynik poprzedniego wywołania faktycznie tego wymaga (np. musisz wejść głębiej w konkretną gałąź). Analizę (describe_project/search_scripts/get_script) wykonuj TYLKO gdy faktycznie nie znasz jeszcze potrzebnej ścieżki/zawartości. Jeśli user w wiadomości podał już nazwę skryptu lub dokładnie opisał gdzie i co zmienić, przejdź od razu do edit_script/create_script — NIE rób rozpoznania na wyrost. Jeśli robisz analizę, ogranicz się do minimum (1 wywołanie), zanim przejdziesz do działania.\n\n" +
"Jeśli musisz stworzyć wiele obiektów, ZAWSZE używaj create_instances zamiast wielu create_instance. Ograniczaj równoległe wywołania narzędzi do max 3 na raz. Nie zwracaj markdownowego kodu bezpośrednio, chyba że user o to prosi. Na koniec krótkie podsumowanie działań.";

const AGENT_TOOLS_SCHEMA = [
    {
        name: "describe_project",
        description: "Zwraca drzewo katalogów i hierarchię najważniejszych serwisów (Workspace, ReplicatedStorage itp.). Użyj by zorientować się w strukturze.",
        parameters: { type: "object", properties: {} }
    },
    {
        name: "find_instance",
        description: "Szuka obiektu (Instance) po pełnej ścieżce (np. 'ServerScriptService.Systems.Foo') lub nazwie ('Foo').",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "search_scripts",
        description: "Szuka skryptów po nazwie lub zawartości.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string" },
                searchSource: { type: "boolean", description: "Czy szukać w treści (Source) skryptów" }
            },
            required: ["query"]
        }
    },
    {
        name: "get_script",
        description: "Zwraca pełną treść (Source) skryptu. UWAGA: kosztowne tokenowo — jeśli szukasz konkretnego fragmentu/funkcji, użyj najpierw grep_script.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "grep_script",
        description: "Szuka wzorca (tekst lub prosty pattern) w treści jednego skryptu i zwraca tylko pasujące linie z kilkoma liniami kontekstu — znacznie tańsze niż get_script gdy szukasz konkretnej funkcji/zmiennej, a nie potrzebujesz całego pliku.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                query: { type: "string" },
                contextLines: { type: "integer", description: "Liczba linii kontekstu przed/po dopasowaniu (domyślnie 3)" }
            },
            required: ["path", "query"]
        }
    },
    {
        name: "get_instance",
        description: "Zwraca informacje o obiekcie (właściwości, dzieci).",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "get_selection",
        description: "Zwraca aktualnie zaznaczone obiekty w Roblox Studio.",
        parameters: { type: "object", properties: {} }
    },
    {
        name: "get_errors",
        description: "Zwraca ostatnie błędy z Output/LogService.",
        parameters: {
            type: "object",
            properties: { limit: { type: "integer", description: "Max ilość błędów (np. 10)" } }
        }
    },
    {
        name: "create_script",
        description: "Tworzy nowy skrypt w danym rodzicu.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Ścieżka rodzica, np. ServerScriptService" },
                name: { type: "string" },
                className: { type: "string", description: "Script, LocalScript lub ModuleScript" },
                source: { type: "string", description: "Kod skryptu" }
            },
            required: ["path", "name", "className", "source"]
        }
    },
    {
        name: "edit_script",
        description: "Edytuje istniejący skrypt używając patcha (znajdź i zamień).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                patch: {
                    type: "object",
                    properties: {
                        type: { type: "string", description: "'replace', 'insert_after', 'insert_before', lub 'full_replace'" },
                        old: { type: "string", description: "Dla type='replace': tekst do podmienienia (musi występować dokładnie 1 raz)" },
                        new: { type: "string", description: "Dla type='replace' i 'full_replace': nowy tekst" },
                        anchor: { type: "string", description: "Dla type='insert_after' / 'insert_before': kotwica (musi występować dokładnie 1 raz)" },
                        code: { type: "string", description: "Dla type='insert_after' / 'insert_before': wklejany kod" }
                    },
                    required: ["type"]
                }
            },
            required: ["path", "patch"]
        }
    },
    {
        name: "create_instance",
        description: "Tworzy obiekt inny niż skrypt (np. Part, Folder, RemoteEvent).",
        parameters: {
            type: "object",
            properties: {
                className: { type: "string" },
                parent: { type: "string" },
                name: { type: "string" },
                properties: { type: "object", description: "Słownik string->wartość dla właściwości obiektu" }
            },
            required: ["className", "parent"]
        }
    },
    {
        name: "create_instances",
        description: "Tworzy wiele obiektów (np. Part, Folder) jednocześnie w ramach jednej operacji. Znacznie szybsze niż wielokrotne wywołanie create_instance dla modeli wieloelementowych.",
        parameters: {
            type: "object",
            properties: {
                instances: {
                    type: "array",
                    description: "Lista obiektów do stworzenia",
                    items: {
                        type: "object",
                        properties: {
                            className: { type: "string" },
                            parent: { type: "string" },
                            name: { type: "string" },
                            properties: { type: "object", description: "Słownik string->wartość dla właściwości obiektu" }
                        },
                        required: ["className", "parent"]
                    }
                }
            },
            required: ["instances"]
        }
    },
    {
        name: "set_property",
        description: "Zmienia właściwość istniejącego obiektu.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                property: { type: "string" },
                value: { type: "string" }
            },
            required: ["path", "property", "value"]
        }
    },
    {
        name: "delete_instance",
        description: "Usuwa obiekt z projektu.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
        }
    },
    {
        name: "rename_instance",
        description: "Zmienia nazwę obiektu.",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, newName: { type: "string" } },
            required: ["path", "newName"]
        }
    },
    {
        name: "move_instance",
        description: "Zmienia rodzica obiektu (przenosi go).",
        parameters: {
            type: "object",
            properties: { path: { type: "string" }, newParent: { type: "string" } },
            required: ["path", "newParent"]
        }
    }
];

// Maksymalny rozmiar (w znakach) treści pojedynczego tool-resultu,
// jaki trzymamy w historii sesji. Powyżej tego przycinamy do skrótu —
// model i tak zwykle nie potrzebuje ponownego pełnego dostępu do
// starych wyników w kolejnych krokach tej samej lub kolejnej tury.
const HISTORY_TOOL_RESULT_MAX_CHARS = 2000;

// Narzędzia, których wyniki mogą być bardzo duże i warto je przycinać
// bardziej agresywnie (pełny kod / pełne drzewo).
const HEAVY_TOOLS = new Set(["get_script", "describe_project", "search_scripts", "grep_script", "get_instance"]);

function compactToolResultForHistory(toolName, rawContent) {
    if (typeof rawContent !== "string") return rawContent;
    const limit = HEAVY_TOOLS.has(toolName) ? 1200 : HISTORY_TOOL_RESULT_MAX_CHARS;
    if (rawContent.length <= limit) return rawContent;
    
    // Zwracamy poprawny JSON, żeby nie psuć parsera modelu i nie powodować timeoutów/błędów API
    return JSON.stringify({
        _truncated_from_history: true,
        original_length: rawContent.length,
        note: "Oryginalny wynik został przycięty w historii ze względu na limit tokenów. Wywołaj narzędzie ponownie jeśli potrzebujesz pełnej zawartości."
    });
}

// Przechodzi po CAŁEJ historii sesji i przycina wyniki narzędzi ze
// STARSZYCH kroków (wszystkich poza bieżącym), żeby historia nie
// rosła w nieskończoność w obrębie jednej sesji/tury.
function compactOlderToolResults(history, keepRecent = 2) {
    const cutoff = Math.max(0, history.length - keepRecent);
    for (let i = 0; i < cutoff; i++) {
        const msg = history[i];
        if (msg && msg.role === "tool" && typeof msg.content === "string") {
            msg.content = compactToolResultForHistory(msg.name, msg.content);
        }
    }
    return history;
}

async function runAgentStep(env, uid, body, ctx) {
    const { message, toolCallId, tool, toolResult } = body;
    let sessionId = body.sessionId;
    
    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    const canGenerate = await canGenerateCode(env, accessToken, uid);
    if (!canGenerate) return json({ error: "Brak tokenów na korzystanie z agenta." }, 402);

    let history = [];
    if (Array.isArray(body.history)) {
        history = body.history;
    } else if (sessionId) {
        const sessionUrl = `${firestoreBaseUrl(env)}/users/${uid}/agentSessions/${sessionId}`;
        try {
            const res = await fetch(sessionUrl, { headers: { "Authorization": `Bearer ${accessToken}` } });
            if (res.ok) {
                const data = await res.json();
                if (data.fields && data.fields.history && data.fields.history.stringValue) {
                    history = JSON.parse(data.fields.history.stringValue);
                }
            }
        } catch (e) {
            console.error("Error reading agent session", e);
        }
    }

    // Normalize history to OpenAI format if needed (for backwards compatibility)
    history = history.map(msg => {
        if (msg.parts) {
            // Old Gemini format, discard to prevent errors or map roughly
            return { role: msg.role === "model" ? "assistant" : "user", content: msg.parts.map(p => p.text).join(" ") || "..." };
        }
        
        // Naprawa uszkodzonych stringów po pierwszej łatce (unikamy 400 Bad Request ze strony DeepSeek)
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes("…[przycięto do historii")) {
            msg.content = JSON.stringify({
                _truncated_from_history: true,
                note: "Wyczyszczono zepsuty string z poprzedniej łatki."
            });
        }
        
        return msg;
    });

    let newItemsCount = 1;
    if (message) {
        history.push({ role: "user", content: message });
    } else if (body.toolResults && Array.isArray(body.toolResults)) {
        newItemsCount = body.toolResults.length;
        for (const tr of body.toolResults) {
            history.push({
                role: "tool",
                tool_call_id: tr.toolCallId || "unknown",
                name: tr.tool,
                content: JSON.stringify(tr.toolResult)
            });
        }
    } else if (toolCallId && toolResult) {
        newItemsCount = 1;
        history.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: tool,
            content: JSON.stringify(toolResult)
        });
    }

    // Przytnij wyniki narzędzi ze starszych kroków tej sesji, zanim
    // wyślemy cały kontekst do modelu — to główna redukcja tokenów.
    history = compactOlderToolResults(history, newItemsCount);

    const openAiTools = AGENT_TOOLS_SCHEMA.map(t => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }
    }));

    // DeepSeek (i OpenAI) odrzuca pole 'name' w wiadomościach o roli 'tool' (wymagają tylko role, content, tool_call_id).
    // Musimy stworzyć kopię historii bez niedozwolonych pól dla API, zachowując je w Firestore.
    // Dodatkowo musimy zadbać o rygorystyczną walidację sekwencji tool_calls -> tool.
    let deepseekHistory = [];
    
    // 1. Podstawowe czyszczenie pól
    for (let i = 0; i < history.length; i++) {
        const msg = { ...history[i] };
        
        if (msg.role === "tool") {
            delete msg.name;
            // DeepSeek wymusza by content w tool message był zawsze stringiem
            if (typeof msg.content !== "string") {
                msg.content = JSON.stringify(msg.content);
            }
        } else if (msg.role === "assistant") {
            // Asystent musi mieć content jako string lub null
            if (msg.content === undefined) msg.content = "";
        }
        
        deepseekHistory.push(msg);
    }

    // 2. Walidacja sekwencji tool_calls i odpowiadających im wiadomości tool
    for (let i = 0; i < deepseekHistory.length; i++) {
        const msg = deepseekHistory[i];
        if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
            const expectedIds = msg.tool_calls.map(tc => tc.id);
            const foundIds = new Set();
            
            // Patrzymy w przód, by upewnić się, że istnieją odp. wiadomości "tool"
            let j = i + 1;
            while (j < deepseekHistory.length && deepseekHistory[j].role === "tool") {
                foundIds.add(deepseekHistory[j].tool_call_id);
                j++;
            }
            
            const allFound = expectedIds.every(id => foundIds.has(id));
            const extraOrMissing = expectedIds.length !== (j - i - 1);
            
            if (!allFound || extraOrMissing) {
                // Uszkodzona sekwencja (np. błąd skryptu przerwał cykl). 
                // Skasuj tool_calls, by uniknąć błędu 400.
                delete msg.tool_calls;
                if (!msg.content || msg.content === "") {
                    msg.content = "[Zignorowano przerwane wywołanie narzędzi]";
                }
            }
        }
    }

    // 3. Usunięcie sierot (wiadomości tool bez asystenta z odpowiadającymi tool_calls)
    const finalHistory = [];
    for (let i = 0; i < deepseekHistory.length; i++) {
        const msg = deepseekHistory[i];
        if (msg.role === "tool") {
            let hasValidParent = false;
            // Szukamy najbliższego asystenta ze spójnym tool_calls
            for (let j = finalHistory.length - 1; j >= 0; j--) {
                const prev = finalHistory[j];
                if (prev.role === "user" || prev.role === "system") break; 
                if (prev.role === "assistant" && prev.tool_calls && prev.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
                    hasValidParent = true;
                    break;
                }
            }
            if (!hasValidParent) {
                // Sierota - pomiń tę wiadomość aby nie wywołać HTTP 400
                continue;
            }
        }
        
        // Zabezpieczenie na wypadek pustego content bez tool_calls
        if (msg.role === "assistant" && (!msg.tool_calls || msg.tool_calls.length === 0)) {
            if (msg.content === null || msg.content === "") {
                msg.content = "...";
            }
        }
        
        finalHistory.push(msg);
    }
    
    deepseekHistory = finalHistory;

    const deepseekRes = await fetchLunaWithRetry(env, [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        ...deepseekHistory
    ], {
        tools: openAiTools
    });

    if (!deepseekRes.ok) {
        return json({ error: "Model error: " + await deepseekRes.text() }, deepseekRes.status);
    }

    const dsData = await deepseekRes.json();
    const candidateMessage = dsData.choices?.[0]?.message;
    if (!candidateMessage) {
        return json({ error: "Pusta odpowiedź z modelu" }, 500);
    }
    
    const costUsd = calcLunaCostUsd(dsData.usage || {});
    const chargePromise = chargeForCodeGenerationByCost(env, accessToken, uid, costUsd).catch(e => console.error("Agent charge error:", e));
    if (ctx) ctx.waitUntil(chargePromise); else await chargePromise;

    // Upewnijmy się, że zachowujemy tylko dozwolone pola.
    // DeepSeek może zwracać dodatkowe pola (np. reasoning_content), 
    // które przy ponownym wysłaniu w historii spowodują błąd HTTP 400.
    const cleanMessage = {
        role: candidateMessage.role || "assistant",
        content: candidateMessage.content || ""
    };
    if (candidateMessage.tool_calls) {
        cleanMessage.tool_calls = candidateMessage.tool_calls;
    }
    
    history.push(cleanMessage);

    // Kompakcja jeszcze raz przed zapisem — nowa wiadomość candidateMessage
    // staje się "starsza" przy kolejnym kroku, ale sam zapis do Firestore
    // też powinien być jak najmniejszy.
    history = compactOlderToolResults(history, 1);
    
    const payload = {
        fields: {
            history: { stringValue: JSON.stringify(history) },
            updatedAt: { timestampValue: new Date().toISOString() }
        }
    };
    
    let sessionCreated = false;
    if (!sessionId) {
        const collectionUrl = `${firestoreBaseUrl(env)}/users/${uid}/agentSessions`;
        const postRes = await fetch(collectionUrl, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (postRes.ok) {
            const doc = await postRes.json();
            sessionId = doc.name.split("/").pop();
            sessionCreated = true;
        } else {
            console.error("Failed to create session:", await postRes.text());
            sessionId = "temp_" + Date.now();
        }
    }

    if (candidateMessage.tool_calls && candidateMessage.tool_calls.length > 0) {
        const calls = candidateMessage.tool_calls.map(tc => ({
            toolCallId: tc.id,
            tool: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || "{}")
        }));
        
        return json({
            type: "tool_calls",
            sessionId: sessionId,
            text: candidateMessage.content || "",
            calls: calls,
            history: history
        });
    }
    
    if (sessionId && !sessionCreated && !sessionId.startsWith("temp_")) {
        const sessionUrl = `${firestoreBaseUrl(env)}/users/${uid}/agentSessions/${sessionId}?updateMask.fieldPaths=history&updateMask.fieldPaths=updatedAt`;
        const savePromise = fetch(sessionUrl, {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(r => { if (!r.ok) r.text().then(t => console.error("Session save failed:", t)); });
        
        if (ctx) ctx.waitUntil(savePromise); else await savePromise;
    }

    return json({
        type: "final",
        sessionId: sessionId,
        reply: candidateMessage.content || "...",
        actions: [] 
    });
}

async function handleAgentStep(request, env, ctx) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runAgentStep(env, uid, body, ctx);
}

// ============================================================================
// /me
// ============================================================================

async function handleMe(request, env) {
    const claims = await getAuthClaims(request, env);
    const uid = claims.sub;
    const accessToken = await getGoogleAccessToken(env);
    const balance = await ensureUserDoc(env, uid, accessToken);

    let robloxUserId = null, robloxUsername = null, codeDebtMilli = 0;
    try {
        const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
        if (res.ok) {
            const doc = await res.json();
            robloxUserId = doc.fields?.robloxUserId?.stringValue || null;
            robloxUsername = doc.fields?.robloxUsername?.stringValue || null;
            // Runs 0..999: chargeForCodeGenerationByCost takes a whole token at
            // 1000. The web app shows it as a meter, same value /plugin/check
            // already returns to the Studio plugin.
            codeDebtMilli = parseInt(doc.fields?.codeDebtMilli?.integerValue || "0", 10);
        }
    } catch (e) { /* ignore */ }

    return json({ tokens: balance, robloxUserId, robloxUsername, codeDebtMilli, isAdmin: isAdminClaims(claims, env) });
}

async function fetchLunaWithRetry(env, messages, options = {}) {
    const url = `${LUNA_API_BASE}/chat/completions`;
    // Reasoning models accept only the default temperature and reject the
    // call outright for any other value, so options.temperature is dropped.
    //
    // Chat Completions takes tools on GPT-6 only with reasoning_effort
    // "none"; with tools present that is forced here. Tool calls that should
    // think first go through the Responses API instead (the Studio agent).
    const body = {
        model: LUNA_MODEL,
        messages,
        response_format: options.jsonMode ? { type: "json_object" } : undefined
    };
    if (options.tools) {
        body.tools = options.tools;
        body.tool_choice = options.toolChoice || "auto";
        body.reasoning_effort = "none";
    } else if (options.reasoningEffort) {
        body.reasoning_effort = options.reasoningEffort;
    }
    if (options.maxTokens) body.max_completion_tokens = options.maxTokens;
    if (options.stream) {
        body.stream = true;
        body.stream_options = { include_usage: true };
    }

    let lastRes;
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
        lastRes = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${env.OPENAI_API_KEY}`
            },
            body: JSON.stringify(body)
        });
        if (lastRes.ok) return lastRes;
        const retryable = lastRes.status === 503 || lastRes.status === 429;
        if (!retryable || attempt === GEMINI_MAX_RETRIES) return lastRes;
        await new Promise(r => setTimeout(r, GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt)));
    }
    return lastRes;
}

// completion_tokens already includes the reasoning tokens, which bill as
// output; cached_tokens is the part of the prompt read back from the cache.
function calcLunaCostUsd(usage) {
    const promptTokens = usage?.prompt_tokens || 0;
    const details = usage?.prompt_tokens_details || {};
    const cached = Math.min(promptTokens, details.cached_tokens || 0);
    const uncached = promptTokens - cached;
    const written = details.cache_write_tokens === undefined
        ? uncached
        : Math.min(uncached, details.cache_write_tokens || 0);
    const completionTokens = usage?.completion_tokens || 0;
    const raw = ((uncached - written) / 1_000_000) * LUNA_PRICE_INPUT_PER_M +
        (written / 1_000_000) * LUNA_PRICE_CACHE_WRITE_PER_M +
        (cached / 1_000_000) * LUNA_PRICE_CACHED_PER_M +
        (completionTokens / 1_000_000) * LUNA_PRICE_OUTPUT_PER_M;
    return raw * MARGIN_MULTIPLIER;
}

// Gemini bills its thinking as output but reports it apart from the answer
// (thoughtsTokenCount), so it has to be added in or the thinking goes free.
function calcGeminiCodeCostUsd(usageMetadata) {
    const promptTokens = usageMetadata?.promptTokenCount || 0;
    const completionTokens = (usageMetadata?.candidatesTokenCount || 0) +
        (usageMetadata?.thoughtsTokenCount || 0);
    const raw = (promptTokens / 1_000_000) * GEMINI_CODE_PRICE_INPUT_PER_M +
        (completionTokens / 1_000_000) * GEMINI_CODE_PRICE_OUTPUT_PER_M;
    return raw * MARGIN_MULTIPLIER;
}

// ── The assistant on GPT-6 Luna ──────────────────────────────────────────
// Everything the assistant does (chat, the streamed chat, choosing actions,
// enhancing prompts, reading pictures, the art director) was written against
// Gemini's request and response shapes. Rather than rewrite each of those,
// these two functions take the same Gemini-shaped body, send it to Luna, and
// hand back a Gemini-shaped answer, so the callers stay as they were.

function assistantMessagesFromGeminiBody(body) {
    const messages = [];
    const sys = (body.system_instruction || body.systemInstruction)?.parts
        ?.map(p => p.text || "").join("\n").trim();
    if (sys) messages.push({ role: "system", content: sys });

    for (const c of body.contents || []) {
        const role = c.role === "model" ? "assistant" : "user";
        const parts = [];
        for (const p of c.parts || []) {
            if (p.text != null && p.text !== "") parts.push({ type: "text", text: String(p.text) });
            const inl = p.inline_data || p.inlineData;
            if (inl?.data) {
                const mime = inl.mime_type || inl.mimeType || "image/png";
                parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${inl.data}` } });
            }
        }
        if (role === "assistant") {
            messages.push({ role, content: parts.filter(p => p.type === "text").map(p => p.text).join("") || "..." });
        } else if (parts.length === 1 && parts[0].type === "text") {
            messages.push({ role, content: parts[0].text });
        } else {
            messages.push({ role, content: parts.length ? parts : "..." });
        }
    }

    const gc = body.generationConfig || body.generation_config || {};
    const wantsJson = (gc.response_mime_type || gc.responseMimeType) === "application/json";
    const maxTokens = gc.maxOutputTokens || gc.max_output_tokens || null;
    // JSON mode is refused unless the word JSON appears in the messages.
    if (wantsJson && !/json/i.test(JSON.stringify(messages))) {
        messages.unshift({ role: "system", content: "Answer with a single JSON object." });
    }
    return { messages, wantsJson, maxTokens };
}

function geminiShapeFromLuna(data) {
    const msg = data?.choices?.[0]?.message || {};
    const text = msg.content || "";
    const u = data?.usage || {};
    return {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        ...(!text && msg.refusal ? { promptFeedback: { blockReason: "REFUSED" } } : {}),
        usageMetadata: lunaUsageMetadata(u),
        modelVersion: LUNA_MODEL
    };
}

function lunaUsageMetadata(u) {
    const d = u?.prompt_tokens_details || {};
    return {
        promptTokenCount: u?.prompt_tokens || 0,
        candidatesTokenCount: u?.completion_tokens || 0,
        cachedContentTokenCount: d.cached_tokens || 0,
        ...(d.cache_write_tokens !== undefined ? { cacheWriteTokenCount: d.cache_write_tokens } : {})
    };
}

// If Luna cannot answer, the request goes to Gemini as it is; either way
// the caller gets a Gemini-shaped response.
async function assistantFallback(env, body, res, stream) {
    if (!env.GEMINI_API_KEY) return res;
    const detail = await res.clone().text().catch(() => "");
    console.error("assistant: " + LUNA_MODEL + " failed (" + res.status + "), using " +
        ASSISTANT_FALLBACK_MODEL + ": " + detail.slice(0, 300));
    return stream
        ? fetchGeminiStream(env, body, ASSISTANT_FALLBACK_MODEL)
        : fetchGeminiWithRetry(env, body, ASSISTANT_FALLBACK_MODEL);
}

async function fetchAssistant(env, body) {
    const { messages, wantsJson, maxTokens } = assistantMessagesFromGeminiBody(body);
    const res = await fetchLunaWithRetry(env, messages, {
        jsonMode: wantsJson,
        reasoningEffort: ASSISTANT_REASONING_EFFORT,
        maxTokens
    });
    if (!res.ok) return assistantFallback(env, body, res, false);
    const data = await res.json();
    return new Response(JSON.stringify(geminiShapeFromLuna(data)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}

// Luna streams OpenAI chunks; the chat reader expects Gemini's. Each text
// delta is re-emitted as a Gemini SSE line, a refusal as a blocked prompt.
async function fetchAssistantStream(env, body) {
    const { messages, wantsJson, maxTokens } = assistantMessagesFromGeminiBody(body);
    const res = await fetchLunaWithRetry(env, messages, {
        jsonMode: wantsJson,
        reasoningEffort: ASSISTANT_REASONING_EFFORT,
        maxTokens,
        stream: true
    });
    if (!res.ok || !res.body) return assistantFallback(env, body, res, true);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let buf = "";
    const emitLine = (line, controller) => {
        line = line.trim();
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch (e) { return; }
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) {
            controller.enqueue(enc.encode("data: " + JSON.stringify({
                candidates: [{ content: { parts: [{ text: delta.content }] } }]
            }) + "\n\n"));
        }
        if (delta.refusal) {
            controller.enqueue(enc.encode("data: " + JSON.stringify({
                promptFeedback: { blockReason: "REFUSED" }
            }) + "\n\n"));
        }
        if (chunk.usage) {
            controller.enqueue(enc.encode("data: " + JSON.stringify({
                usageMetadata: lunaUsageMetadata(chunk.usage),
                modelVersion: LUNA_MODEL
            }) + "\n\n"));
        }
    };
    const toGemini = new TransformStream({
        transform(bytes, controller) {
            buf += dec.decode(bytes, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) !== -1) {
                emitLine(buf.slice(0, nl), controller);
                buf = buf.slice(nl + 1);
            }
        },
        flush(controller) {
            buf += dec.decode();
            if (buf) emitLine(buf, controller);
        }
    });
    return new Response(res.body.pipeThrough(toGemini), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
    });
}

// Gemini itself is only used for code, when the user picks Gemini 3.8 Flash.
async function fetchGeminiWithRetry(env, body, modelOverride) {
    const model = modelOverride || GEMINI_CODE_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    let lastRes;
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
        lastRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (lastRes.ok) return lastRes;

        const retryable = lastRes.status === 503 || lastRes.status === 429;
        if (!retryable || attempt === GEMINI_MAX_RETRIES) return lastRes;

        const delay = GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    return lastRes;
}



// Streaming twin of fetchGeminiWithRetry, used by the assistant's fallback.
// Same retry policy; the caller owns the body and must read it as SSE.
async function fetchGeminiStream(env, body, modelOverride) {
    const model = modelOverride || ASSISTANT_FALLBACK_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;

    let lastRes;
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
        lastRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        if (lastRes.ok) return lastRes;

        const retryable = lastRes.status === 503 || lastRes.status === 429;
        if (!retryable || attempt === GEMINI_MAX_RETRIES) return lastRes;

        const delay = GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    return lastRes;
}

// The chat model answers with a JSON object, so a raw token stream is not
// displayable on its own. This walks the partial text and returns the decoded
// value of "reply" as far as it has arrived, so the UI can render real prose
// while the object is still being written. Returns null until the opening
// quote shows up, and stops short of any half-received escape sequence.
function extractPartialReply(raw) {
    const keyIdx = raw.indexOf('"reply"');
    if (keyIdx === -1) return null;

    const colon = raw.indexOf(":", keyIdx + 7);
    if (colon === -1) return null;

    let i = colon + 1;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== '"') return null;
    i++;

    const SHORT_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
    let out = "";
    let escaped = false;

    for (; i < raw.length; i++) {
        const ch = raw[i];

        if (escaped) {
            if (ch === "u") {
                const hex = raw.slice(i + 1, i + 5);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete \uXXXX — wait for more
                out += String.fromCharCode(parseInt(hex, 16));
                i += 4;
            } else {
                out += SHORT_ESCAPES[ch] || ch;
            }
            escaped = false;
            continue;
        }

        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') break; // closing quote — the value is complete
        out += ch;
    }

    return out;
}

function extractGeminiText(geminiData) {
    return (geminiData.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || "")
        .join("")
        .trim();
}

// Wyciąga czysty JSON z odpowiedzi Gemini, nawet jeśli model owinął go w
// ```json ... ``` albo dodał białe znaki dookoła. Rzuca, jeśli treść w
// ogóle nie parsuje się jako JSON — wywołujący ma wtedy sensowny fallback.
function parseJsonFromGemini(rawText) {
    let cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

    // Gemini czasem dokleja komentarz przed/po obiekcie JSON — wytnij
    // wszystko poza pierwszym { ... } / ostatnim dopasowanym nawiasem.
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    return JSON.parse(cleaned);
}

// Wyciąga pole tekstowe z "JSON-a", nawet jeśli jest uszkodzony
// (surowe \n / niecytowane cudzysłowy w środku stringa).
function extractJsonFieldLoose(rawText, field) {
    const re = new RegExp('"' + field + '"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"[a-zA-Z_]+"\\s*:|\\}\\s*$)', "m");
    const match = rawText.match(re);
    if (!match) return null;
    return match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

// Usuwa resztki JSON-a, które czasem zostają na końcu wyciętego kodu
// (np. `","language":"lua"}`).
function sanitizeExtractedCode(code) {
    return String(code)
        .replace(/["']?\s*,?\s*"?(language|description)"?\s*:\s*"[^"]*"\s*\}?\s*$/i, "")
        .replace(/\}\s*$/, (m, offset, str) => {
            const opens = (str.match(/\{/g) || []).length;
            const closes = (str.match(/\}/g) || []).length;
            return closes > opens ? "" : m;
        });
}

// ============================================================================
// WSKAZÓWKI STYLISTYCZNE
// ============================================================================

const AESTHETIC_REASONING_GUIDANCE =
    "Before choosing any visual treatment (lighting, color palette, mood, " +
    "effects), first work out what the subject actually is and what tone " +
    "genuinely fits it — do not default to the same 'vibrant neon glow' " +
    "look for every image regardless of subject. Reason about the scene, " +
    "then match the treatment to it, for example:\n" +
    "- Vehicles (cars, bikes, planes), tools, tech, real-world objects -> " +
    "clean, sleek, well-lit, professional/product-shot treatment (studio " +
    "lighting, subtle reflections, realistic materials, controlled " +
    "background) — not neon, not glowing.\n" +
    "- Cute mascots, cartoonish characters, party/game subjects -> " +
    "bright, colorful, playful and fun, but still tasteful, not garish.\n" +
    "- Nature, animals, plants, landscapes, food -> natural, organic " +
    "lighting and colors that fit the real setting (sunlight, soft " +
    "shadows), not artificial glow.\n" +
    "- Action, horror, villains, danger, combat -> darker, more dramatic " +
    "and moody lighting and contrast.\n" +
    "- Calm, cozy, everyday, wholesome subjects -> soft, warm, inviting " +
    "lighting.\n" +
    "Only reach for neon / glow / vibrant-light effects when the subject " +
    "or the user's own wording actually calls for that (e.g. cyberpunk, " +
    "esports, nightlife, sci-fi tech, disco). The user's own explicit " +
    "words always take priority over any of the above — if they already " +
    "specify a style, color, mood, or setting, keep it exactly as they " +
    "said it; only fill in the details they left unspecified, inferred " +
    "sensibly from what the subject actually is.";

const GFX_QUALITY_GUIDANCE_ICON =
    "The render itself should look like professional game artwork made for " +
    "a square GAME ICON / gamepass / badge / group icon on Roblox, not a " +
    "generic AI-generated picture. Roblox is where it is shown, not how it " +
    "looks: no Roblox avatars, blocky characters, studs or toy-plastic " +
    "look unless the user asks for them. Concretely:\n" +
    "- Sharp, clean focus on the main subject with a clear, readable " +
    "silhouette at SMALL size (icons are often shown tiny) — avoid soft, " +
    "blurry, or 'melted' details.\n" +
    "- Physically plausible, intentional lighting and materials instead " +
    "of the flat, overly smooth, plastic 'AI sheen' look.\n" +
    "- Confident, deliberate composition — subject filling the frame, " +
    "centered or dynamically angled — not a generic centered stock-photo " +
    "pose.\n" +
    "- Avoid common AI-art artifacts: warped or extra limbs/fingers, " +
    "nonsensical text, inconsistent or duplicated details, waxy or " +
    "uncanny faces.\n" +
    "- Do not default to a cutesy, fairytale, or storybook look for " +
    "everything — only lean that way if the subject or the user's own " +
    "words actually call for it.";

const GFX_QUALITY_GUIDANCE_THUMBNAIL =
    "The render itself should look like professional game key art used as " +
    "a GAME THUMBNAIL / store-listing banner (the wide promotional image " +
    "shown in the Roblox discovery grid), not a generic AI-generated " +
    "picture and not a square icon composition. Roblox is where it is " +
    "shown, not how it looks: no Roblox avatars, blocky characters, studs " +
    "or toy-plastic look unless the user asks for them. Concretely:\n" +
    "- Wide, cinematic composition that reads clearly as a small thumbnail " +
    "in a crowded browse grid — bold silhouette, strong focal point, high " +
    "contrast between subject and background.\n" +
    "- Leave sensible negative space / breathing room (commonly on one " +
    "side) where a game logo or title text could later be overlaid, " +
    "unless the user's prompt clearly wants the frame fully filled.\n" +
    "- Dynamic, exciting, 'click me' energy appropriate to the game genre " +
    "— action, adventure, or cozy, matched to the subject — with " +
    "professional game-marketing lighting and color grading.\n" +
    // The API's widest size is 3:2, but Roblox shows thumbnails at 16:9, so
    // the top and bottom ~8% get cropped off in practice. Composing for that
    // safe area costs nothing and stops faces and logos losing their tops.
    "- IMPORTANT FRAMING: the image is 3:2, but it will be displayed cropped " +
    "to 16:9, losing roughly the top 8% and bottom 8% of the height. Compose " +
    "for that safe area: keep the focal subject, any faces, and any space " +
    "reserved for a logo or title inside the middle 84% of the frame " +
    "vertically. Put only background, sky, ground or atmosphere in the top " +
    "and bottom bands, and never let a head, hand or key silhouette edge sit " +
    "in them.\n" +
    "- Avoid common AI-art artifacts: warped or extra limbs/fingers, " +
    "nonsensical text, inconsistent or duplicated details, waxy or " +
    "uncanny faces.";

// Text is the one thing an image model adds on its own that nobody can
// remove afterwards, and a thumbnail with a made-up title is worse than
// none. So it is never added unless the request actually asks for it.
const TEXT_RULE_NONE =
    "No text of any kind: no letters, words, numbers, titles, logos, " +
    "watermarks, signatures, captions, UI or speech bubbles anywhere in the image.";

function requestWantsText(text) {
    const t = String(text || "");
    if (/["“”„«»][^"“”„«»]{1,60}["“”„«»]/.test(t)) return true;
    return /\b(text|title[ds]?|caption|lettering|typography|font|words?|written|writing|says|saying|slogan|tagline|headline|label(led|ed)?|logo\s+(with|that says|reading)|name\s+on|napis\w*|tekst\w*|tytu\w*|podpis\w*|z\s+nazw\w*|nazw\w*\s+gry)\b/i.test(t);
}

function guidanceForCategory(category) {
    const quality = category === CATEGORIES.THUMBNAIL
        ? GFX_QUALITY_GUIDANCE_THUMBNAIL
        : GFX_QUALITY_GUIDANCE_ICON;
    return AESTHETIC_REASONING_GUIDANCE + "\n\n" + quality + "\n\n" +
        "Text: unless the user explicitly asks for text (a title, a name, " +
        "words), the prompt must say the image contains no text, letters, " +
        "numbers or logos. If they do ask, keep exactly their words.";
}

function subjectLabel(category) {
    return category === CATEGORIES.THUMBNAIL
        ? "Roblox game thumbnails (wide store-listing promotional banners)"
        : "Roblox game icons (game icons, gamepass icons, badges, group icons)";
}

// ============================================================================
// /enhance
// ============================================================================

async function handleEnhance(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runEnhance(env, uid, body);
}

async function runEnhance(env, uid, body) {
    const { prompt, hasReference, category } = body;
    if (!prompt) return json({ error: "Missing prompt" }, 400);

    const cat = category === CATEGORIES.THUMBNAIL ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;

    const systemPrompt = hasReference ?
        "You are a prompt engineer who writes EDIT INSTRUCTIONS for an AI " +
        "image editing model that modifies an existing reference photo " +
        "into a " + subjectLabel(cat) + ". The user has already uploaded a " +
        "reference image — your job is NOT to describe a new scene from " +
        "scratch, it is to describe what to CHANGE about the existing " +
        "photo while keeping its main subject, character, and pose " +
        "recognizable. Given a short idea from the user (it may be in " +
        "any language), rewrite it as a single, concise English edit " +
        "instruction (1-2 sentences): what to change (background, colors, " +
        "props, lighting, outfit, effects) — never re-describe or replace " +
        "the subject itself. Do not add quotation marks, labels, or any " +
        "explanation — reply with ONLY the final instruction text, " +
        "nothing else.\n\n" + guidanceForCategory(cat) :
        "You are a prompt engineer who writes prompts for an AI image " +
        "generator that makes " + subjectLabel(cat) + ". Given a short " +
        "idea from the user (it may be in any language), rewrite it as a " +
        "single, vivid, detailed English prompt for the image model. Keep " +
        "the user's core subject and intent, but add concrete visual " +
        "detail: pose, materials, lighting, mood, color palette, and " +
        "composition. Write 1-3 sentences. Do not add quotation marks, " +
        "labels, or any explanation — reply with ONLY the final prompt " +
        "text, nothing else.\n\n" + guidanceForCategory(cat);

    const geminiRes = await fetchAssistant(env, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8 }
    });

    if (!geminiRes.ok) {
        return json({ error: "Model error: " + await geminiRes.text() }, geminiRes.status);
    }

    const geminiData = await geminiRes.json();
    const blockReason = geminiData.promptFeedback?.blockReason;
    if (blockReason) return json({ error: "The model refused the prompt (" + blockReason + ")." }, 400);

    const enhanced = extractGeminiText(geminiData);
    if (!enhanced) return json({ error: "Model nie zwrócił treści" }, 500);

    return json({ enhanced });
}

// ============================================================================
// /analyze-image
// ============================================================================

async function handleAnalyzeImage(request, env) {
    await requireAuth(request, env);

    const { prompt, image, styleMode, category } = await request.json();
    if (!image) return json({ error: "Brak obrazu do analizy" }, 400);

    const match = image.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return json({ error: "Nieprawidłowy format obrazu" }, 400);

    const mimeType = match[1];
    const base64 = match[2];
    const cat = category === CATEGORIES.THUMBNAIL ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;

    const instruction = styleMode ?
        "You are a visual analyst and prompt engineer. The attached image " +
        "is a STYLE REFERENCE photo. Separately, the end user also has a " +
        "different MAIN photo that will be edited to adopt this " +
        "reference's visual style (its lighting, color palette, mood, " +
        "material/render treatment, atmosphere), while the main photo's " +
        "own subject, character, and pose stay exactly as they are.\n\n" +
        "Do two things, in order:\n" +
        "1. \"description\": Look at the attached reference image and " +
        "describe its VISUAL STYLE only (lighting, colors, mood, " +
        "textures/materials, atmosphere) in 1-2 English sentences — not " +
        "the reference's own subject matter.\n" +
        "2. \"enhanced_prompt\": Combine that style description with the " +
        "user's idea below (it may be in any language) into a single, " +
        "concise English edit instruction (1-2 sentences) telling an " +
        "image-editing model to restyle the MAIN photo — background, " +
        "colors, lighting, materials, mood — to match this reference " +
        "style, producing a " + subjectLabel(cat) + ". Never describe or " +
        "introduce a new subject; the main photo's subject must stay " +
        "recognizable.\n\n" +
        guidanceForCategory(cat) + "\n\n" +
        "User's idea (optional, may be empty): " + ((prompt || "").trim() ||
            "(brak — oprzyj się wyłącznie na stylu wzorca)") + "\n\n" +
        "Respond with ONLY a raw JSON object, no markdown code fences, no " +
        "extra text before or after, in exactly this shape: " +
        '{"description":"...","enhanced_prompt":"..."}'
        :
        "You are a visual analyst and prompt engineer preparing an edit " +
        "instruction for an AI image editing model that will turn the " +
        "attached reference photo into a " + subjectLabel(cat) + ".\n\n" +
        "Do two things, in order:\n" +
        "1. \"description\": Look carefully at the attached image and " +
        "write a short, neutral, factual description of what's actually " +
        "in it (main subject, pose, notable features, colors, setting) " +
        "in 1-2 English sentences.\n" +
        "2. \"enhanced_prompt\": Base this step on the description you " +
        "just wrote, combined with the user's idea below (it may be " +
        "written in any language). Write a single, concise English edit " +
        "instruction (1-2 sentences) that describes what to CHANGE about " +
        "the photo — background, colors, props, lighting, outfit, " +
        "effects. Never re-describe or replace the main subject; keep it " +
        "recognizable.\n\n" +
        guidanceForCategory(cat) + "\n\n" +
        "User's idea: " + ((prompt || "").trim() ||
            "(brak dodatkowego opisu od użytkownika — zaproponuj coś, co " +
            "dobrze pasuje do tego, co widać na zdjęciu)") + "\n\n" +
        "Respond with ONLY a raw JSON object, no markdown code fences, no " +
        "extra text before or after, in exactly this shape: " +
        '{"description":"...","enhanced_prompt":"..."}';

    const geminiRes = await fetchAssistant(env, {
        contents: [{
            role: "user",
            parts: [{ text: instruction }, { inline_data: { mime_type: mimeType, data: base64 } }]
        }],
        generationConfig: { temperature: 0.6 }
    });

    if (!geminiRes.ok) return json({ error: "Model error: " + await geminiRes.text() }, geminiRes.status);

    const geminiData = await geminiRes.json();
    const blockReason = geminiData.promptFeedback?.blockReason;
    if (blockReason) return json({ error: "Model odrzucił zdjęcie (" + blockReason + ")." }, 400);

    const rawText = extractGeminiText(geminiData);
    if (!rawText) return json({ error: "The model returned no content." }, 500);

    let parsed;
    try { parsed = parseJsonFromGemini(rawText); }
    catch (e) { return json({ error: "Could not read the model's answer." }, 500); }

    const description = String(parsed.description || "").trim();
    const enhanced = String(parsed.enhanced_prompt || "").trim();
    if (!enhanced) return json({ error: "Model nie zwrócił promptu." }, 500);

    return json({ description, enhanced });
}

// ============================================================================
// ART DIRECTION — what the image model is actually asked for
// ============================================================================
//
// The page sends the user's words (translated) and, separately, a short
// brief for the format they picked (icon, thumbnail, badge...). Handing
// both straight to the image model made everything look the same: the word
// "Roblox" in a brief reads to it as a style, so every picture came back as
// blocky avatars in candy colours, with a made-up title on top. This step
// reads the request the way an art director would — what it is, what genre
// and mood it belongs to, what style was asked for or fits — and writes the
// one prompt the image model gets. If it fails, the request still goes
// through, with the text rule attached.

const ART_DIRECTOR_RULES =
    "You are the art director at a studio that makes promotional art and " +
    "in-game assets for games published on Roblox. You turn a request into " +
    "one precise prompt for an image model.\n\n" +
    "1. Read the request: the subject, what is happening, the genre of the " +
    "game it is for, the mood, and whether the user named an art style or " +
    "colours.\n\n" +
    "2. Choose the art style.\n" +
    "- If the user named one (realistic, photoreal, cinematic, anime, " +
    "manga, pixel art, low poly, voxel, watercolor, oil painting, comic, " +
    "cel-shaded, claymation, cartoon, 'Roblox style', blocky...), use " +
    "exactly that and say it first in the prompt.\n" +
    "- Otherwise pick what the subject and genre call for: horror -> dark " +
    "cinematic realism, desaturated, heavy shadows; war, military, " +
    "police, crime, sports, cars, racing -> photoreal or high-end cinematic " +
    "3D with real materials; fantasy, RPG, adventure -> painterly key art " +
    "or high-end cinematic 3D; sci-fi -> cinematic 3D, restrained palette; " +
    "anime-themed games -> polished anime illustration; simulator, tycoon, " +
    "pets, kids, obby, cooking -> stylized 3D with soft believable " +
    "materials (feature-animation quality), never candy plastic. When " +
    "nothing points anywhere: polished cinematic 3D game key art with " +
    "realistic materials and grounded colour.\n" +
    "- 'Roblox' names the platform the image is for, never the look. Do " +
    "not draw Roblox avatars, blocky or noob characters, studs, the Roblox " +
    "logo, or a toy-like, candy, plasticky, oversaturated cartoon look " +
    "unless the user asks for Roblox characters, avatars, a blocky or " +
    "Roblox style, or cartoon.\n\n" +
    "3. Light and colour follow the mood, not a default: dramatic and " +
    "contrasty for action and danger, cold and dim for horror, warm and " +
    "soft for cozy, natural daylight for nature. Keep colour restrained " +
    "and coherent; use saturated neon only when the request calls for it " +
    "(cyberpunk, nightlife, arcade, esports).\n\n" +
    "4. Text. If the user did not explicitly ask for text (a title, the " +
    "game's name, words, numbers), the image has none: end the prompt " +
    "with 'No text, letters, numbers or logos anywhere in the image.' If " +
    "they did, include exactly the words they gave, spelled exactly, and " +
    "no other text.\n\n" +
    "5. Follow the format brief for composition and framing, but never let " +
    "it change the style chosen above.\n\n" +
    "6. Write the prompt: 60-140 words of plain English. Start with the " +
    "art style and medium, then the subject and action, setting, camera " +
    "and composition, lighting, colour palette, materials and detail. " +
    "Concrete visual words only; no filler like 'masterpiece', '8k', " +
    "'trending'. Keep every specific thing the user asked for.";

const FORMAT_BRIEFS = {
    icon: "Square game icon: one clear subject filling the frame, a silhouette that reads at small size, simple uncluttered background.",
    thumbnail: "Wide 3:2 game thumbnail, shown cropped to 16:9: cinematic key-art composition with one strong focal point; keep faces and the subject inside the middle 84% of the height, only sky, ground or atmosphere in the top and bottom bands."
};

async function directImagePrompt(env, { userPrompt, brief, category, mode, images }) {
    const cat = category === CATEGORIES.THUMBNAIL ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;
    const formatBrief = [brief, FORMAT_BRIEFS[cat]].filter(Boolean).join(" ");
    const wantsText = requestWantsText(userPrompt);

    let task;
    if (mode === MODES.EDIT) {
        task = "The attached image is the user's picture, which will be EDITED. " +
            "Write an edit instruction (40-90 words) for the image model: apply " +
            "only what the user asked; keep the subject, identity, pose, framing " +
            "and the picture's own art style unless the user asks to change it; " +
            "match new elements to its existing lighting and rendering.";
    } else if (mode === MODES.STYLE) {
        task = "The first attached image is the MAIN picture; the second is a " +
            "STYLE REFERENCE. Look at the reference and name its style precisely " +
            "(medium, rendering technique, palette, lighting, texture, line " +
            "work). Write an instruction (40-90 words) that restyles the main " +
            "picture to match it while keeping the main picture's subject, " +
            "pose and composition. Do not copy the reference's subject.";
    } else {
        task = "Write the prompt for generating a new image from scratch.";
    }

    const text =
        task + "\n\n" +
        "Format brief: " + formatBrief + "\n" +
        "The user's request (already translated to English): " + (String(userPrompt || "").trim() || "(none — base it on the attached image)") + "\n" +
        "The user " + (wantsText ? "DID" : "did NOT") + " ask for text in the image.\n\n" +
        "Reply with only a raw JSON object, no code fences: " +
        '{"style":"<the style you chose, a few words>","prompt":"<the prompt>"}';

    const parts = [{ text }];
    for (const img of images || []) {
        if (img && img.base64) parts.push({ inline_data: { mime_type: img.mimeType || "image/png", data: img.base64 } });
    }

    const res = await fetchAssistant(env, {
        system_instruction: { parts: [{ text: ART_DIRECTOR_RULES }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.7 }
    });
    if (!res.ok) throw new Error("art director: " + res.status);
    const data = await res.json();
    if (data.promptFeedback?.blockReason) throw new Error("art director blocked: " + data.promptFeedback.blockReason);
    const parsed = parseJsonFromGemini(extractGeminiText(data) || "");
    const prompt = String(parsed.prompt || "").trim();
    if (prompt.length < 20) throw new Error("art director returned no prompt");
    return { prompt: withTextRule(prompt, wantsText), style: String(parsed.style || "").trim() };
}

// The rule is appended by code as well, so it holds even when the director
// forgets it.
function withTextRule(prompt, wantsText) {
    if (wantsText) return prompt + " Render only the text the request asks for, spelled exactly, and no other text.";
    return /no text/i.test(prompt) ? prompt : prompt + " " + TEXT_RULE_NONE;
}

// ============================================================================
// GENEROWANIE OBRAZU (OpenAI)
// ============================================================================

async function runImageGeneration(env, { prompt, images, category, mask, background, size: sizeOverride }) {
    const size = sizeOverride || IMAGE_SIZE_BY_CATEGORY[category] || IMAGE_SIZE_BY_CATEGORY.icon;

    let response;
    if (!images || images.length === 0) {
        const payload = { model: OPENAI_IMAGE_MODEL, prompt, size, quality: OPENAI_IMAGE_QUALITY, n: 1 };
        if (background) payload.background = background;
        response = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
            body: JSON.stringify(payload)
        });
    } else {
        const form = new FormData();
        images.forEach((file, i) => {
            const binary = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
            form.append("image[]", new Blob([binary], { type: file.mimeType }), `input-${i}.png`);
        });
        form.append("prompt", prompt || "Apply the reference image's visual style to the main image, keeping its subject and pose unchanged.");
        form.append("model", OPENAI_IMAGE_MODEL);
        form.append("quality", OPENAI_IMAGE_QUALITY);
        form.append("size", size);

        // The mask marks what may be repainted through its ALPHA channel:
        // alpha 0 is open, alpha 255 is protected. It has to match the image
        // pixel for pixel, and it is sent as a file part of its own.
        if (mask) {
            const mBin = Uint8Array.from(atob(mask.base64), c => c.charCodeAt(0));
            form.append("mask", new Blob([mBin], { type: mask.mimeType || "image/png" }), "mask.png");
        }
        if (background) form.append("background", background);

        response = await fetch("https://api.openai.com/v1/images/edits", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
            body: form
        });
    }

    if (!response.ok) {
        return { ok: false, status: response.status, error: await response.text() };
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
        const data = await response.json();
        if (data.data?.[0]?.b64_json) {
            return { ok: true, base64: data.data[0].b64_json, mimeType: "image/png" };
        }
        const remoteUrl = data.data?.[0]?.url || data.url;
        if (remoteUrl) {
            const imgRes = await fetch(remoteUrl);
            const buf = await imgRes.arrayBuffer();
            return {
                ok: true,
                base64: arrayBufferToBase64Std(buf),
                mimeType: imgRes.headers.get("content-type") || "image/png"
            };
        }
        return { ok: false, status: 500, error: "API nie zwróciło obrazu: " + JSON.stringify(data) };
    }

    const buf = await response.arrayBuffer();
    return { ok: true, base64: arrayBufferToBase64Std(buf), mimeType: contentType || "image/png" };
}

function arrayBufferToBase64Std(buf) {
    let binary = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// ============================================================================
// /generate — TRYB WYMUSZONY (Icon lub Thumbnail, metoda już wybrana)
// ============================================================================

async function persistBytesToR2(env, base64, key, contentType) {
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    await env.ASSETS_BUCKET.put(key, binary, {
        httpMetadata: { contentType: contentType || "application/octet-stream" }
    });
    return `${env.PUBLIC_WORKER_URL}/asset/${encodeURIComponent(key)}`;
}

async function handleGenerate(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runGenerate(env, uid, body, false);
}

async function runGenerate(env, uid, body, returnJson = false) {
    const { prompt, image, referenceImage, mode, category } = body;
    if (!prompt && !(mode === MODES.STYLE && (image || referenceImage))) {
        return json({ error: "Missing prompt" }, 400);
    }
    const cat = category === CATEGORIES.THUMBNAIL ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const charged = await chargeTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
    if (!charged) return json({ error: "Not enough tokens. Doładuj konto, aby wygenerować kolejną grafikę." }, 402);

    try {
        const images = [];
        if (image) images.push(parseDataUrl(image));
        if (referenceImage) images.push(parseDataUrl(referenceImage));

        // The page sends the user's own words and the format brief apart;
        // an older page sends them joined in `prompt`, which still works.
        const userPrompt = body.userPrompt != null ? body.userPrompt : prompt;
        let finalPrompt = prompt;
        let style = "";
        try {
            const directed = await directImagePrompt(env, {
                userPrompt, brief: body.presetBrief || "", category: cat, mode, images
            });
            finalPrompt = directed.prompt;
            style = directed.style;
        } catch (e) {
            console.warn("art director unavailable, using the prompt as sent:", e && e.message);
            finalPrompt = withTextRule(prompt || "", requestWantsText(userPrompt));
        }

        const result = await runImageGeneration(env, { prompt: finalPrompt, images, category: cat });

        if (!result.ok) {
            await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
            return json({ error: result.error }, result.status || 500);
        }

        let imageUrl = null;
        try {
            const key = `images/${cat}/${uid}-${Date.now()}-${crypto.randomUUID()}.png`;
            imageUrl = await persistBytesToR2(env, result.base64, key, result.mimeType);
        } catch (uploadErr) {
            console.error("Błąd podczas wgrywania obrazka do R2:", uploadErr);
        }

        if (returnJson) {
            return json({
                base64: result.base64,
                mimeType: result.mimeType,
                imageUrl: imageUrl || "",
                style
            });
        }

        const binary = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
        return new Response(binary, {
            headers: {
                "Content-Type": result.mimeType,
                "X-Image-Url": imageUrl || "",
                // Header values must be Latin-1; the style is short English.
                "X-Image-Style": style.replace(/[^\x20-\x7E]/g, "").slice(0, 120),
                ...corsHeaders()
            }
        });

    } catch (error) {
        await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
        throw error;
    }
}

// ============================================================================
// /images/edit — paint a region, extend past the edges, cut out on alpha
// ============================================================================
//
// All three are the same call with different pieces supplied:
//   region   image + mask  (mask alpha 0 over what should change)
//   extend   image only, already sitting on a larger transparent canvas —
//            the hole in its own alpha is what gets filled
//   cutout   image + background: "transparent"
//
// The client builds the alpha, because it is the one that knows where the
// brush went; the worker's job is to bill it, forward it and keep the result.
async function handleImagesEdit(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    const { image, mask, prompt, category, background, size } = body;

    if (!image) return json({ error: "Missing image" }, 400);
    if (!prompt) return json({ error: "Missing prompt" }, 400);

    const cat = category === CATEGORIES.THUMBNAIL ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;
    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const charged = await chargeTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
    if (!charged) return json({ error: "Not enough tokens." }, 402);

    try {
        const result = await runImageGeneration(env, {
            prompt,
            images: [parseDataUrl(image)],
            category: cat,
            mask: mask ? parseDataUrl(mask) : null,
            background: background === "transparent" ? "transparent" : null,
            size: size || null
        });

        if (!result.ok) {
            await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
            return json({ error: result.error }, result.status || 500);
        }

        let imageUrl = null;
        try {
            const key = `images/${cat}/${uid}-${Date.now()}-${crypto.randomUUID()}.png`;
            imageUrl = await persistBytesToR2(env, result.base64, key, result.mimeType);
        } catch (uploadErr) {
            console.error("R2 upload failed:", uploadErr);
        }

        const binary = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
        return new Response(binary, {
            headers: { "Content-Type": result.mimeType, "X-Image-Url": imageUrl || "", ...corsHeaders() }
        });
    } catch (error) {
        await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration);
        throw error;
    }
}

// ============================================================================
// /images/variations — several takes on one image, no prompt involved
// ============================================================================
//
// This is the one route that cannot use gpt-image-2: variations exist only on
// dall-e-2, which wants a square PNG under 4 MB and returns n images at once.
async function handleImagesVariations(request, env) {
    const uid = await requireAuth(request, env);
    const { image, count } = await request.json();
    if (!image) return json({ error: "Missing image" }, 400);

    const n = Math.min(Math.max(parseInt(count, 10) || 3, 1), 4);
    const cost = TOKEN_COSTS.imageGeneration * n;

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const charged = await chargeTokens(env, accessToken, uid, cost);
    if (!charged) return json({ error: "Not enough tokens." }, 402);

    try {
        const file = parseDataUrl(image);

        // /v1/images/variations only ever spoke dall-e-2, and a key without
        // access to that model is answered with a 404 that reads as if the
        // route were missing. When that happens the takes are re-run through
        // the same image model the rest of the app uses, which is the one
        // model the key is certain to have.
        let items = [];
        let firstError = null;
        try {
            const binary = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
            const form = new FormData();
            form.append("image", new Blob([binary], { type: "image/png" }), "input.png");
            form.append("model", "dall-e-2");
            form.append("n", String(n));
            form.append("size", "1024x1024");
            form.append("response_format", "b64_json");

            const res = await fetch("https://api.openai.com/v1/images/variations", {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
                body: form
            });

            if (res.ok) {
                const data = await res.json();
                items = (data.data || []).filter(it => it && it.b64_json).map(it => it.b64_json);
            } else {
                firstError = await res.text();
                console.warn("variations unavailable, falling back to edits:", res.status, firstError);
            }
        } catch (e) {
            firstError = String(e && e.message || e);
            console.warn("variations threw, falling back to edits:", firstError);
        }

        if (!items.length) {
            const results = await Promise.all(Array.from({ length: n }, () => runImageGeneration(env, {
                prompt: "Another take on this exact image: same subject, same framing, same palette and the same style. Vary only the small things — pose, lighting, incidental detail. Do not add text.",
                images: [file],
                category: CATEGORIES.ICON
            })));
            for (const r of results) {
                if (r.ok && r.base64) items.push(r.base64);
                else if (!firstError && r && r.error) firstError = r.error;
            }
        }

        if (!items.length) {
            await refundTokens(env, accessToken, uid, cost);
            return json({ error: firstError || "The API returned no images." }, 502);
        }

        // Only what actually came back is paid for.
        if (items.length < n) {
            await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageGeneration * (n - items.length));
        }

        const images = [];
        for (const b64 of items) {
            let url = null;
            try {
                const key = `images/icon/${uid}-${Date.now()}-${crypto.randomUUID()}.png`;
                url = await persistBytesToR2(env, b64, key, "image/png");
            } catch (e) { console.error("R2 upload failed:", e); }
            images.push({ base64: b64, imageUrl: url || "" });
        }

        return json({ images, cost: TOKEN_COSTS.imageGeneration * images.length });
    } catch (error) {
        await refundTokens(env, accessToken, uid, cost);
        throw error;
    }
}

function parseDataUrl(dataUrl) {
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) throw new Error("Nieprawidłowy format obrazu");
    return { mimeType: match[1], base64: match[2] };
}

// ============================================================================
// /generate-ui-lua — Zrzut ekranu UI z Robloxa -> responsywny skrypt LUA
// ============================================================================

// The brief that does not change: how a Roblox UI script has to be built.
// What changes is where the design comes from — a screenshot, a written
// description, or a layout someone arranged out of blocks — and whether an
// HTML preview is wanted alongside the Lua. Those are composed on top.
const UI_TO_LUA_SYSTEM_PROMPT =
    "You are an expert Roblox UI/UX engineer. You will be given a design for " +
    "a Roblox game UI (a menu, HUD, shop, inventory, settings panel, etc). " +
    "Your job is to reproduce that UI as a single, self-contained Roblox Lua " +
    "LocalScript that builds the ENTIRE UI at runtime via Instance.new(...) — " +
    "do not describe it, do not use Roblox Studio explorer syntax, write real " +
    "executable Lua.\n\n" +
    "HARD REQUIREMENTS:\n" +
    "1. RESPONSIVENESS IS MANDATORY. Never hardcode pixel-only positions/sizes " +
    "(no bare UDim2.new(0, 400, 0, 300)). Use UDim2 Scale components as the " +
    "primary layout mechanism, combined with UIAspectRatioConstraint where an " +
    "element must keep its proportions (icons, avatars, square buttons), and " +
    "UISizeConstraint (MinSize/MaxSize in offset) to stop things from becoming " +
    "unreadably small on phones or absurdly huge on ultrawide monitors. " +
    "Frames that hold rows/columns of children (lists, grids, button bars) " +
    "MUST use UIListLayout or UIGridLayout with SortOrder, Padding, and " +
    "FillDirection set appropriately, plus UIPadding on their container, " +
    "instead of manually offsetting each child.\n" +
    "2. Wrap the whole UI in a ScreenGui with IgnoreGuiInset = true and " +
    "ResetOnSpawn = false, parented to game.Players.LocalPlayer.PlayerGui. " +
    "Give the ScreenGui and every major Frame clear, descriptive Names.\n" +
    "3. Style it properly: colours as Color3.fromRGB, corner rounding via " +
    "UICorner, borders via UIStroke, gradients via UIGradient, fonts via " +
    "Enum.Font. Icons and images go on an ImageLabel/ImageButton with a " +
    "placeholder rbxassetid://0 and a comment telling the user to replace " +
    "the asset id.\n" +
    "4. Add basic interactivity that's obviously implied by the UI (close " +
    "buttons that call :Destroy() or toggle Visible, tab buttons that switch " +
    "which frame is visible, hover/press color feedback via MouseEnter/" +
    "MouseLeave or GuiButton states). Keep this lightweight — don't invent " +
    "entire game systems, just the UI wiring.\n" +
    "5. Organize the code top-to-bottom in the order elements would " +
    "logically be created (parent before children), with short comments " +
    "grouping sections (e.g. -- Main frame, -- Header, -- Button list).\n" +
    "6. Output ONLY valid Lua inside the JSON \"code\" field — no explanation " +
    "mixed into the code besides Lua comments (--).\n";

// Where the design came from. Each one tells the model what it is looking at
// and how much licence it has: a screenshot is copied, a description is
// designed, a block layout is honoured as structure but finished as craft.
const UI_SOURCE_BRIEFS = {
    screenshot:
        "THE DESIGN: a screenshot of an existing UI. Match what is visually " +
        "there as closely as reasonably possible — layout structure, " +
        "approximate colours (as Color3.fromRGB), corner rounding (UICorner), " +
        "borders (UIStroke), gradients (UIGradient) where visible, the text, " +
        "and the fonts (Enum.Font, closest match). For icons and images use a " +
        "placeholder rbxassetid://0 on an ImageLabel/ImageButton with a " +
        "comment telling the user to replace the asset id.\n",
    text:
        "THE DESIGN: a written description, with no picture. You are the " +
        "designer as well as the engineer. Decide the layout, the hierarchy, " +
        "the spacing and a coherent colour palette yourself, and make it look " +
        "like a UI a competent Roblox studio would ship — consistent corner " +
        "radii, deliberate padding, a clear type scale, one accent colour " +
        "used sparingly. Invent only what the description leaves open, never " +
        "contradict what it states.\n",
    layout:
        "THE DESIGN: a layout the user arranged out of blocks, given as JSON " +
        "and as a picture of the same arrangement. Every block has a type, a " +
        "position and a size in SCREEN FRACTIONS (0-1, origin top-left), and " +
        "may carry text and a colour. Treat that arrangement as the structure " +
        "to honour: keep the reading order, the grouping and the rough " +
        "proportions. Do not copy the fractions blindly into offsets — read " +
        "the intent (a row of buttons, a sidebar, a header) and rebuild it " +
        "with the proper layout objects. Anything drawn freehand is an " +
        "annotation about intent, not an element to reproduce. Where the " +
        "layout is silent on styling, apply the same craft as for a written " +
        "description.\n"
};

// The preview is a second, separate rendering of the SAME design, in HTML,
// so someone can see what they are about to paste into Studio.
const UI_PREVIEW_BRIEF =
    "ALSO produce an HTML preview of the same UI, in the \"html\" field.\n" +
    "- One self-contained HTML document: a <style> block and the markup, no " +
    "external requests of any kind — no <img src> to a URL, no web fonts, no " +
    "scripts fetching anything. Inline SVG and CSS gradients only.\n" +
    "- It renders inside a 16:9 box. Fill it edge to edge with the game view " +
    "behind the UI suggested by a CSS gradient, and size everything in %, vw, " +
    "vh, em or flex so it survives being scaled down.\n" +
    "- Match the Lua: the same elements, the same arrangement, the same " +
    "colours and text. This is what the script will build, not a variation " +
    "on it.\n" +
    "- Small interactions are welcome where the Lua has them (hover states, " +
    "tab switching) using CSS or a short inline <script>. Nothing that needs " +
    "the network.\n";

function uiLuaSystemPrompt(source, wantPreview) {
    const brief = UI_SOURCE_BRIEFS[source] || UI_SOURCE_BRIEFS.screenshot;
    const shape = wantPreview
        ? '{"description":"1-2 sentence Polish description of the UI and how you approached responsiveness","code":"-- full Lua script as a single string, with \\n newlines","html":"<!doctype html>… the preview as a single string"}'
        : '{"description":"1-2 sentence Polish description of the UI and how you approached responsiveness","code":"-- full Lua script as a single string, with \\n newlines"}';
    return UI_TO_LUA_SYSTEM_PROMPT + "\n" + brief +
        (wantPreview ? "\n" + UI_PREVIEW_BRIEF : "") +
        "\nRespond with ONLY a raw JSON object, no markdown fences around the " +
        "JSON itself, no extra text before or after, in exactly this shape:\n" + shape;
}

async function handleGenerateUiLua(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runGenerateUiLua(env, uid, body);
}

// A design can arrive three ways now, and be read by either of two models.
// Everything downstream of the call is shared, so the differences are
// resolved into one pair — a system prompt and a set of user parts — before
// anything is sent.
const UI_SOURCES = ["screenshot", "text", "layout"];
const UI_MODELS = ["luna"];
const UI_DEFAULT_MODEL = "luna";

function uiLayoutSummary(layout) {
    if (!layout || typeof layout !== "object") return "";
    const blocks = Array.isArray(layout.blocks) ? layout.blocks.slice(0, 120) : [];
    const strokes = Array.isArray(layout.strokes) ? layout.strokes.length : 0;
    const lines = blocks.map((b, i) => {
        const r = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
        const bits = [
            `${i + 1}. ${String(b.type || "frame")}`,
            `x=${r(b.x)} y=${r(b.y)} w=${r(b.w)} h=${r(b.h)}`
        ];
        if (b.text) bits.push(`text=${JSON.stringify(String(b.text).slice(0, 120))}`);
        if (b.color) bits.push(`colour=${String(b.color).slice(0, 24)}`);
        return bits.join("  ");
    });
    return "BLOCKS (screen fractions, origin top-left):\n" + (lines.join("\n") || "(none)") +
        (strokes ? `\n\nPlus ${strokes} freehand annotation stroke(s), drawn over the layout in the picture.` : "");
}

async function runGenerateUiLua(env, uid, body) {
    const { image, prompt, layout } = body;
    const source = UI_SOURCES.includes(body.source) ? body.source : "screenshot";
    const model = UI_MODELS.includes(body.model) ? body.model : UI_DEFAULT_MODEL;
    const wantPreview = body.preview !== false;

    if (source === "screenshot" && !image) return json({ error: "Brak zrzutu ekranu UI" }, 400);
    if (source === "text" && !String(prompt || "").trim()) {
        return json({ error: "Describe the interface you want first." }, 400);
    }
    if (source === "layout" && !(layout && Array.isArray(layout.blocks) && layout.blocks.length)) {
        return json({ error: "Put at least one block on the stage first." }, 400);
    }

    let parsedImg = null;
    if (image) {
        try { parsedImg = parseDataUrl(image); }
        catch (e) { return json({ error: "Nieprawidłowy format obrazu" }, 400); }
    }

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const charged = await chargeTokens(env, accessToken, uid, TOKEN_COSTS.imageToUi);
    if (!charged) return json({ error: "Not enough tokens. Doładuj konto." }, 402);

    const refund = () => refundTokens(env, accessToken, uid, TOKEN_COSTS.imageToUi);

    try {
        const system = uiLuaSystemPrompt(source, wantPreview);
        const said = String(prompt || "").trim();
        let userText;
        if (source === "text") {
            userText = "Design and build this Roblox UI as a Lua script.\n\nWhat it should be:\n" + said;
        } else if (source === "layout") {
            userText = "Build this arranged layout as a Roblox UI Lua script.\n\n" +
                uiLayoutSummary(layout) +
                (said ? "\n\nWhat the user says about it:\n" + said : "");
        } else {
            userText = "Recreate this Roblox UI as a Lua script." +
                (said ? (" Additional instructions from the user: " + said) : "");
        }

        let rawText = "";
        {
            const content = [{ type: "text", text: userText }];
            if (parsedImg) {
                content.push({ type: "image_url", image_url: { url: `data:${parsedImg.mimeType};base64,${parsedImg.base64}` } });
            }
            const res = await fetchLunaWithRetry(env, [
                { role: "system", content: system },
                { role: "user", content }
            ], { jsonMode: true });

            if (!res.ok) {
                await refund();
                return json({ error: "Luna Error: " + await res.text() }, res.status);
            }
            const data = await res.json();
            rawText = data.choices?.[0]?.message?.content || "";
        }

        if (!rawText) {
            await refund();
            return json({ error: "The model returned no content." }, 500);
        }

        let parsed = null;
        let codeExtracted = null;
        let descExtracted = null;
        try {
            parsed = parseJsonFromGemini(rawText);
        } catch (e) {
            const codeMatch = rawText.match(/```(?:lua)?\s*([\s\S]*?)```/i);
            if (codeMatch) {
                codeExtracted = codeMatch[1].trim();
            } else {
                codeExtracted = extractJsonFieldLoose(rawText, "code");
                descExtracted = extractJsonFieldLoose(rawText, "description");
            }
        }

        let code = (parsed?.code ? String(parsed.code) : codeExtracted) || "";
        code = sanitizeExtractedCode(code).trim();
        if (!code) {
            await refund();
            return json({ error: "The model returned no code, or it could not be read." }, 500);
        }

        // A preview that was asked for and did not arrive is not worth
        // failing the whole thing over — the script is what was paid for.
        const html = wantPreview ? sanitizeUiPreviewHtml(parsed?.html || extractJsonFieldLoose(rawText, "html")) : "";

        return json({
            description: String(parsed?.description || descExtracted || "").trim(),
            code,
            html,
            model,
            source
        });

    } catch (error) {
        await refund();
        throw error;
    }
}

// The preview is model-written HTML that the page will put in a sandboxed
// frame. The sandbox is the guard that matters; this only holds it to the
// promise that it reaches nothing over the network, so a preview cannot
// quietly phone home or hang waiting on a font.
function sanitizeUiPreviewHtml(raw) {
    let html = String(raw || "").trim();
    if (!html) return "";
    html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!/<[a-z!]/i.test(html)) return "";
    html = html
        .replace(/<link\b[^>]*>/gi, "")
        .replace(/@import\s+[^;]+;/gi, "")
        .replace(/\bsrc\s*=\s*("|')(?:https?:)?\/\/[^"']*\1/gi, 'src="data:,"')
        .replace(/url\(\s*(["']?)(?:https?:)?\/\/[^)]*\1\s*\)/gi, "none");
    return html.slice(0, 200000);
}

// ============================================================================
// /generate-code - Skrypty LUA na podstawie tekstu, z uwzględnieniem poprzedniego kodu
// ============================================================================

const CODE_GEN_SYSTEM_PROMPT =
    "You are an expert Roblox Lua developer helping inside a creative tool. " +
    "You write complete, working Lua scripts (LocalScript/Script/ModuleScript as " +
    "appropriate) based on the user's request. Reply in the same language the " +
    "user used for any explanation text, but code itself stays in Lua with " +
    "English identifiers/comments unless told otherwise.\n\n" +
    "You may be given PREVIOUS CODE from earlier in this session. If present:\n" +
    "- Treat it as the current state of the project.\n" +
    "- Apply the user's new instruction ON TOP of it (add functions, fix bugs, " +
    "refactor) rather than starting from scratch, unless the instruction " +
    "clearly asks for something unrelated/new.\n" +
    "- Always return the FULL updated script, not a diff or snippet.\n\n" +
    "If isFix is true, the user is reporting the previous code doesn't work " +
    "as expected. Carefully re-read the previous code, find likely bugs/" +
    "logic errors relative to the described problem, and return a corrected " +
    "full script. Briefly note in \"description\" what you think was wrong.\n\n" +
    "Respond with ONLY a raw JSON object, no markdown fences around the JSON " +
    "itself, in exactly this shape:\n" +
    '{"description":"1-2 sentence explanation of what you did/fixed, in the user\'s language","language":"lua","code":"-- full script as a single string with \\n newlines"}';

// A system is not several files, it is a tree of instances — some of which
// happen to be scripts. Roblox developers already read that tree fluently in
// the Explorer, so the model is asked to answer in it: every node has a path,
// a class, and a reason to exist, and the scripts carry their code.
const CODE_SYSTEM_SYSTEM_PROMPT =
    "You are an expert Roblox Lua architect. The user wants a WHOLE WORKING " +
    "SYSTEM, not a single script: the scripts, the instances they need " +
    "around them, where each one goes in the Explorer, and how they talk to " +
    "each other.\n\n" +
    "Design it the way a competent Roblox studio would:\n" +
    "- Server logic in ServerScriptService. Shared code and remotes in " +
    "ReplicatedStorage. Client code in StarterPlayer/StarterPlayerScripts or " +
    "StarterGui. Server-only data in ServerStorage.\n" +
    "- Never trust the client: validate every RemoteEvent and RemoteFunction " +
    "argument on the server, and keep authority there.\n" +
    "- Put tunable numbers in one ModuleScript config rather than scattering " +
    "them through the logic.\n" +
    "- Group the system's remotes in a named Folder instead of dropping them " +
    "loose in ReplicatedStorage.\n" +
    "- Use WaitForChild on the client for anything replicated.\n" +
    "- Keep each script to one job. A system of four focused scripts beats " +
    "one script with four sections.\n\n" +
    "EVERY node the user has to create is listed, including the ones with no " +
    "code: Folders, RemoteEvents, RemoteFunctions, BindableEvents, " +
    "ScreenGuis, Values. A script that fires a remote the user was never " +
    "told to create is a broken answer.\n\n" +
    "Paths are full Explorer paths from the service down, separated by " +
    "forward slashes, e.g. " +
    "\"ReplicatedStorage/ShopRemotes/BuyItem\". Parents must appear in the " +
    "list before their children.\n\n" +
    "Respond with ONLY a raw JSON object, no markdown fences around the JSON " +
    "itself, no text before or after, in exactly this shape:\n" +
    '{"name":"Short name for the system","description":"2-4 sentences in the user\'s language: what it does and how the pieces fit together",' +
    '"tree":[{"path":"ServerScriptService/ShopServer","class":"Script","note":"one line on what this one is for, in the user\'s language","code":"-- full Lua as a single string with \\n newlines, omit this field for nodes that are not scripts"}],' +
    '"steps":["numbered things to do in Studio after pasting, in the user\'s language — only what is not obvious from the tree"]}';

// A system you cannot try is a system you cannot trust. This writes the
// harness: one script you drop in, press Play, and watch the thing work —
// with whatever the system needs in order to be exercised at all conjured
// on the spot, so nobody has to build a test level first.
const CODE_TEST_SYSTEM_PROMPT =
    "You are an expert Roblox Lua developer. You are given a system someone " +
    "just generated, and you write ONE script that proves it works.\n\n" +
    "The script is dropped into ServerScriptService, the user presses Play, " +
    "and the system's behaviour becomes visible and testable without them " +
    "building anything first. So:\n" +
    "- CONJURE WHAT IS MISSING. If the system collects items, spawn a few " +
    "collectible parts in front of the spawn point. If it awards XP or " +
    "currency, give the player some on join and print the running total. If " +
    "it needs a shop trigger, create the part and the ProximityPrompt. " +
    "Build it in code — never assume anything is already in the place.\n" +
    "- MAKE IT OBVIOUS. Print a labelled line for every step, so the output " +
    "reads as a transcript of what happened: what was set up, what fired, " +
    "what the value was before and after.\n" +
    "- CHECK, DO NOT JUST RUN. Where there is a value that should change, " +
    "compare before and after and print whether it matched, in the form " +
    "\"[PASS] coins 120 -> 30 after buying sword\" or \"[FAIL] ...\". End " +
    "with a summary line counting passes and failures.\n" +
    "- DRIVE THE REAL PATH. Fire the system's own remotes and call its own " +
    "modules rather than reimplementing the logic. A test that reimplements " +
    "what it tests proves nothing.\n" +
    "- ALSO TRY TO BREAK IT. Send one obviously invalid request too (a " +
    "nonexistent item id, a negative amount, a purchase with no money) and " +
    "check the system refuses it. Print that as a [PASS] when it is refused.\n" +
    "- CLEAN UP after itself where it can, and be safe to delete.\n" +
    "- Guard everything the place may not have yet with WaitForChild, and " +
    "wrap remote calls so one failure does not stop the whole run.\n\n" +
    "Start the script with a comment block saying what it tests and how to " +
    "read the output, and tell the user in \"description\" where to put it " +
    "and what they should see in the Output window.\n\n" +
    "Respond with ONLY a raw JSON object, no markdown fences around the JSON " +
    "itself, in exactly this shape:\n" +
    '{"description":"where to put it and what the Output should show, in the user\'s language","language":"lua","code":"-- the full test script as a single string with \\n newlines"}';

// Classes the tree may name. Anything else is a hallucinated instance type
// and would send someone looking for a menu entry that does not exist.
const ROBLOX_CLASSES = [
    "Script", "LocalScript", "ModuleScript",
    "Folder", "RemoteEvent", "RemoteFunction", "BindableEvent", "BindableFunction",
    "ScreenGui", "Frame", "TextLabel", "TextButton", "ImageLabel", "ImageButton",
    "StringValue", "IntValue", "NumberValue", "BoolValue", "ObjectValue",
    "Configuration", "Part", "Model", "Tool", "Attachment", "ProximityPrompt"
];

const ROBLOX_SERVICES = [
    "ServerScriptService", "ServerStorage", "ReplicatedStorage", "ReplicatedFirst",
    "StarterGui", "StarterPack", "StarterPlayer", "Workspace", "Lighting",
    "SoundService", "Teams", "Chat"
];

const CODE_SCRIPT_CLASSES = ["Script", "LocalScript", "ModuleScript"];

// The model is good at the design and careless about the bookkeeping, so the
// tree is put in order here rather than trusted: paths cleaned, classes held
// to the list above, parents guaranteed to exist and to come first.
function normaliseSystemTree(raw) {
    const rows = Array.isArray(raw) ? raw : [];
    const byPath = new Map();

    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const path = String(row.path || "")
            .replace(/^[\/.]+|[\/]+$/g, "")
            .replace(/[\/]{2,}/g, "/")
            .split("/")
            .map(seg => seg.trim())
            .filter(Boolean)
            .join("/");
        if (!path) continue;

        let cls = String(row.class || "").trim();
        if (!ROBLOX_CLASSES.includes(cls)) {
            cls = row.code ? "Script" : "Folder";
        }
        // Code inside a JSON string field still comes back fenced often
        // enough to be worth undoing here; pasting ```lua into Studio is
        // a syntax error on line one.
        const code = CODE_SCRIPT_CLASSES.includes(cls) && row.code
            ? sanitizeExtractedCode(String(row.code)
                .replace(/^\s*```[a-z]*\s*\n?/i, "")
                .replace(/\n?\s*```\s*$/i, "")).trim()
            : "";

        byPath.set(path, {
            path,
            class: cls,
            note: String(row.note || "").slice(0, 300),
            code
        });
    }

    // A script under a Folder nobody was told to make is a dead end, so any
    // missing ancestor is filled in as a Folder — except the service at the
    // root, which already exists in every place.
    for (const path of [...byPath.keys()]) {
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i++) {
            const parent = segs.slice(0, i).join("/");
            if (i === 1 && ROBLOX_SERVICES.includes(parent)) continue;
            if (!byPath.has(parent)) {
                byPath.set(parent, { path: parent, class: "Folder", note: "", code: "" });
            }
        }
    }

    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function handleGenerateCode(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runGenerateCode(env, uid, body);
}

async function runGenerateCode(env, uid, body) {
    const { instruction, previousCode, previousLanguage, isFix, model } = body;
    if (!instruction) return json({ error: "Brak polecenia" }, 400);

    // One script or a whole system. Everything below is shared; only the
    // brief and the shape of the answer differ.
    const wantsSystem = body.mode === "system";
    const wantsTest = body.mode === "test";
    const selectedModel = model === "gemini" ? "gemini" : DEFAULT_CODE_MODEL;

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    const canGenerate = await canGenerateCode(env, accessToken, uid);
    if (!canGenerate) return json({ error: "Not enough tokens." }, 402);

    const systemPrompt = wantsSystem ? CODE_SYSTEM_SYSTEM_PROMPT
        : wantsTest ? CODE_TEST_SYSTEM_PROMPT
        : CODE_GEN_SYSTEM_PROMPT;

    const userText = wantsTest
        ? "THE SYSTEM TO TEST:\n```\n" + (previousCode || "") + "\n```\n\n" +
          "Write the test script for it." + (instruction ? " Pay particular attention to: " + instruction : "")
        : wantsSystem
        ? (previousCode
            ? "THE SYSTEM SO FAR:\n```\n" + previousCode + "\n```\n\nExtend it, keeping what is already there.\n\n"
            : "") +
          "Design and build this system: " + instruction
        : (previousCode
            ? "PREVIOUS CODE (" + (previousLanguage || "lua") + "):\n```\n" + previousCode + "\n```\n\n"
            : "") +
          "isFix: " + (!!isFix) + "\n" +
          "User instruction: " + instruction;

    let rawText, costUsd, pricingNote = null;

    if (selectedModel === "luna") {
        const lunaRes = await fetchLunaWithRetry(env, [
            { role: "system", content: systemPrompt },
            { role: "user", content: userText }
        ], { temperature: isFix ? 0.2 : 0.4, jsonMode: true });

        if (!lunaRes.ok) return json({ error: "Błąd modelu kodującego: " + await lunaRes.text() }, lunaRes.status);

        const lunaData = await lunaRes.json();
        rawText = lunaData.choices?.[0]?.message?.content || "";
        costUsd = calcLunaCostUsd(lunaData.usage || {});
    } else {
        const geminiRes = await fetchGeminiWithRetry(env, {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userText }] }],
            generationConfig: { temperature: isFix ? 0.2 : 0.4, response_mime_type: "application/json" }
        }, GEMINI_CODE_MODEL);

        if (!geminiRes.ok) return json({ error: "Błąd modelu kodującego: " + await geminiRes.text() }, geminiRes.status);

        const geminiData = await geminiRes.json();
        const blockReason = geminiData.promptFeedback?.blockReason;
        if (blockReason) return json({ error: "Model odrzucił zapytanie (" + blockReason + ")." }, 400);

        rawText = extractGeminiText(geminiData);
        costUsd = calcGeminiCodeCostUsd(geminiData.usageMetadata);
    }

    if (!rawText) return json({ error: "Model nie zwrócił treści." }, 500);

    let parsed = null;
    let codeExtracted = null;
    let descExtracted = null;
    let langExtracted = null;
    try {
        parsed = parseJsonFromGemini(rawText);
    } catch (e) {
        const codeMatch = rawText.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
        if (codeMatch) {
            codeExtracted = codeMatch[1].trim();
        } else {
            codeExtracted = extractJsonFieldLoose(rawText, "code");
            descExtracted = extractJsonFieldLoose(rawText, "description");
            langExtracted = extractJsonFieldLoose(rawText, "language");
        }
    }

    if (wantsSystem) {
        const tree = normaliseSystemTree(parsed && parsed.tree);
        if (!tree.some(n => n.code)) {
            return json({ error: "The model described a system but did not write any of its scripts." }, 500);
        }
        await chargeForCodeGenerationByCost(env, accessToken, uid, costUsd);
        return json({
            mode: "system",
            name: String(parsed?.name || "System").slice(0, 80),
            description: String(parsed?.description || descExtracted || "").trim(),
            tree,
            steps: (Array.isArray(parsed?.steps) ? parsed.steps : [])
                .slice(0, 12).map(x => String(x).slice(0, 400)),
            language: "lua",
            model: selectedModel,
            pricingNote
        });
    }

    let code = (parsed?.code ? String(parsed.code) : codeExtracted) || "";
    code = sanitizeExtractedCode(code).trim();
    if (!code) return json({ error: "Nie udało się przetworzyć odpowiedzi modelu." }, 500);

    await chargeForCodeGenerationByCost(env, accessToken, uid, costUsd);

    return json({
        description: String(parsed?.description || descExtracted || "").trim(),
        language: String(parsed?.language || langExtracted || previousLanguage || "lua"),
        code,
        model: selectedModel,
        pricingNote
    });
}

// ============================================================================
// /chat — GŁÓWNY, DOMYŚLNY tryb.
//
// Gdy Gemini wykryje intencję "generate_icon" / "generate_thumbnail", NIE
// generujemy obrazu od razu w tym endpointzie. Zamiast tego zwracamy
// action: { type: "need_image_method", category, prompt }, żeby frontend
// pokazał wspólny mechanizm wyboru trybu (chooser message), tak jak dla
// modelu 3D. Realne generowanie odbywa się dopiero po wyborze metody, przez
// istniejący endpoint /generate.
//
// Body: { chatId (opcjonalne), message, image (opcjonalny base64, zachowane
//         dla kompatybilności), images (opcjonalna tablica base64) }
// ============================================================================

const CHAT_SYSTEM_PROMPT_BASE =
    "You are the in-app assistant for \"RoPeak\", a creative tool for " +
    "Roblox game developers. You can have a normal, friendly conversation " +
    "(the user usually writes in Polish — reply in the same language they " +
    "used), answer questions, and describe/analyze any image(s) they " +
    "attach. You can ALSO detect when the user actually wants you to " +
    "CREATE something, and in that case you trigger the right action " +
    "instead of just talking about it.\n\n" +
    "There are four things the user might want you to create:\n" +
    "- A Roblox GAME ICON (square icon, gamepass icon, badge, group icon).\n" +
    "- A Roblox THUMBNAIL (wide promotional/store-listing banner image).\n" +
    "- A 3D MODEL (an actual .glb 3D asset, e.g. for a game object, prop, " +
    "character, weapon, vehicle, item — anything the user explicitly wants " +
    "as a 3D model, not a flat picture).\n" +
    "- A ROBLOX LUA UI SCRIPT recreated from an attached UI screenshot " +
    "(they upload a picture of an existing Roblox interface and want the " +
    "actual LocalScript that builds it).\n\n" +
    "Reply with ONLY a raw JSON object (no markdown fences, no extra text), " +
    "in exactly this shape:\n" +
    '{"reply":"...", "action": null | {"type":"generate_icon"|"generate_thumbnail"|"generate_3d"|"generate_ui_lua"|"generate_code", "prompt":"...", "needs_reference_choice": false, "use_attached_image": false}}\n\n' +
    "Rules:\n" +
    "- If the user is just chatting, asking a question, greeting you, or " +
    "asking you to describe/analyze attached image(s) (without wanting a " +
    "NEW image or script generated) — set action to null. Put your real, " +
    "helpful answer in \"reply\". When your reply includes any code, wrap " +
    "it in a proper fenced code block (```lua ... ``` or the right " +
    "language) inside the reply string, using real \\n newlines, so the " +
    "app can render it nicely — never paste raw code inline without " +
    "fences.\n" +
    "- If they clearly want a new Roblox game icon created — action.type = " +
    "\"generate_icon\". If they clearly want a thumbnail/banner created — " +
    "action.type = \"generate_thumbnail\". For both, you do NOT need to " +
    "write a detailed image prompt yourself — the app will ask the user " +
    "to pick a creation method next. Set \"reply\" to a short, friendly " +
    "Polish sentence like \"Jasne, zaraz stworzymy ikonę!\" (adapt to what " +
    "they asked for), and action.prompt can just restate their idea " +
    "briefly.\n" +
    "- If they want a 3D MODEL: action.type = \"generate_3d\".\n" +
    "  * If image(s) are attached AND they want a 3D model made from one " +
    "(or from what's in the picture) — set use_attached_image=true, " +
    "needs_reference_choice=false, and action.prompt to a short optional " +
    "texturing/style hint in English if they gave one (else empty string).\n" +
    "  * If they gave a clear, sufficient TEXT description of the object " +
    "to model (no image needed) — set needs_reference_choice=false, " +
    "use_attached_image=false, and action.prompt to a concise English " +
    "description of the object suitable for a text-to-3D model (max ~500 " +
    "characters, describe shape/appearance/material, not a scene).\n" +
    "  * If they only said something like \"zrób mi model 3D\" / \"chcę " +
    "model 3D\" without enough detail and without an image — set " +
    "needs_reference_choice=true so the app can ask them HOW they'd like " +
    "to provide it (describe it / upload a reference photo / generate an " +
    "image first). In that case \"reply\" should be a short Polish " +
    "sentence like \"Super! W jaki sposób chcesz stworzyć model 3D?\" and " +
    "action.prompt can be an empty string.\n" +
    "- If they attached an image of a Roblox UI/menu/HUD and want it " +
    "turned into a working script — action.type = \"generate_ui_lua\", " +
    "use_attached_image=true, and action.prompt to any extra instructions " +
    "they gave (else empty string). If they want this but have NOT " +
    "attached an image yet, set action to null and ask them in \"reply\" " +
    "to upload the UI screenshot.\n" +
    "- If the user wants a Lua/Roblox SCRIPT or general programming help (not a UI " +
    "screenshot recreation, not just explaining/reading code) — action.type = " +
    "\"generate_code\". This is a heavier coding task and should NOT be handled " +
    "by you directly, even if you could — always hand it off. Set action.prompt " +
    "to the user's coding request, kept in their own language, and \"reply\" to " +
    "a short, friendly sentence like \"Jasne, przechodzę w tryb Code i piszę " +
    "skrypt!\" Do not write or fix code yourself in \"reply\" for this case.\n" +
    "- Never invent an action the user didn't ask for. When genuinely " +
    "unsure, prefer action: null and ask a clarifying question in " +
    "\"reply\" instead of guessing.";

// ============================================================================
// AGENT (web app, protocol 2)
// ----------------------------------------------------------------------------
// The web app sends `agent: 2` and a `context` describing what is on the
// user's screen: the mode, the chosen image type, whether there is a last
// image / model / script to work on, what Studio is doing, and the image
// types the app offers. The assistant then answers with ONE action the app
// can run directly: generate or edit an image in a given type (optionally
// enhancing the prompt first), build a 3D model, write code, rebuild a UI,
// open the advanced frame already filled in, or ask Studio's agent to do
// something. Nothing here spends tokens by itself — the app runs the action
// through the same endpoints the buttons use, and anything costly or
// irreversible is confirmed there. The Roblox plugin still calls /chat
// without `agent`, and gets the old answer shape.
// ============================================================================

const AGENT_IMAGE_TYPES_FALLBACK = [
    "normal", "icon", "thumbnail", "particle", "ui", "background", "logo",
    "gamepass", "badge", "item", "weapon", "ability", "vehicle", "npc",
    "character", "map", "environment", "texture", "decal", "banner",
    "loadingscreen", "shop", "quest", "rank", "emote", "avatar", "ugc", "gameui"
];

const AGENT_WORKSPACE_TASKS = {
    image: ["create", "edit-photo", "restyle", "mark", "extend", "cutout", "takes"],
    model3d: ["m-text", "m-image", "m-gen", "m-multi", "m-retopo", "m-segment", "m-complete", "m-texture", "m-rig", "m-convert"],
    code: ["c-new", "c-system", "c-add", "c-fix", "c-refactor", "c-explain"],
    ui2lua: ["u-shot", "u-idea", "u-blocks"]
};

const AGENT_ACTION_TYPES = ["image", "model3d", "code", "ui_to_lua", "workspace", "studio", "enhance", "mode", "settings"];

function agentContextText(ctx) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const lines = [];
    const yes = v => v ? "yes" : "no";
    lines.push("Mode the app is in: " + String(c.mode || "chat"));
    // Written from inside a tool before a way in was picked: the options in
    // the chat were skipped, so the choice of way in falls to the assistant.
    const TOOL_DOES = {
        image: "an image action (create, edit or restyle; with one picture attached and a change asked for, edit it " +
            "with base \"attached\"; with two attached and a look to borrow, restyle with base \"attached\" and style " +
            "\"attached\" - the first picture is the base, the second the style; keep the image type chosen unless they name another)",
        model3d: "a model3d action (base \"attached\" when a photo of the object is attached)",
        ui2lua: "a ui_to_lua action when a screenshot is attached, otherwise a workspace action with mode ui2lua and task u-idea"
    };
    if (TOOL_DOES[c.fromTool]) {
        lines.push("Sent from inside the " + c.fromTool + " tool, without picking one of its options. If this asks for " +
            "something to be made, answer with " + TOOL_DOES[c.fromTool] + " right away instead of asking how. Only a " +
            "question or small talk gets a plain reply.");
    }
    if (c.imageType) lines.push("Image type currently chosen: " + String(c.imageType));
    lines.push("Images attached to this message: " + (Number(c.attachments) || 0));
    const li = c.lastImage || {};
    lines.push("A last image exists in this chat: " + yes(li.exists) +
        (li.exists ? " (type: " + String(li.type || "unknown") + (li.prompt ? ', made from: "' + String(li.prompt).slice(0, 200) + '"' : "") + ")" : ""));
    lines.push("A last 3D model exists in this chat: " + yes(c.lastModel));
    lines.push("A last script exists in this chat: " + yes(c.lastCode));
    const st = c.studio || {};
    lines.push("Roblox Studio plugin connected: " + yes(st.online) + (st.place ? " (place: " + String(st.place).slice(0, 80) + ")" : ""));
    lines.push("User lets Studio requests run without asking: " + yes(c.studioAutoApprove));
    const types = Array.isArray(c.imageTypes) && c.imageTypes.length
        ? c.imageTypes.map(t => typeof t === "string" ? t : (t.key + (t.label ? " (" + t.label + ")" : ""))).join(", ")
        : AGENT_IMAGE_TYPES_FALLBACK.join(", ");
    lines.push("Image types the app offers: " + types);
    return lines.join("\n");
}

const CHAT_AGENT_SYSTEM_PROMPT =
    "You are the assistant inside \"RoPeak\", a studio of tools for Roblox game developers. " +
    "You talk with the user AND you operate the app for them: when they want something made or " +
    "changed, you pick the right tool, set it up the way they described, and the app runs it. " +
    "Reply in the language the user wrote in.\n\n" +
    "Answer with ONLY a raw JSON object, \"reply\" first:\n" +
    "{\"reply\":\"...\",\"action\":null | {...}}\n\n" +
    "\"reply\" is what the user reads: short and specific when you are running a tool (say what you are " +
    "about to do, with the settings you chose), a full helpful answer when you are just talking. Code in " +
    "a reply goes in a fenced block.\n\n" +
    "Actions (at most one per answer):\n" +
    "1. {\"type\":\"image\",\"op\":\"create\"|\"edit\"|\"restyle\",\"image_type\":\"<one of the app's image types>\"," +
    "\"prompt\":\"...\",\"enhance\":true|false,\"base\":null|\"attached\"|\"last_image\",\"style\":null|\"attached\"|\"last_image\"}\n" +
    "   - create: a new image from words. edit: change an existing picture (base = the attached image or the last " +
    "image in the chat). restyle: keep base's subject, take the look from style.\n" +
    "   - image_type: pick the type that matches what they asked for (an icon -> icon, a game thumbnail -> thumbnail, " +
    "a badge -> badge, a gamepass -> gamepass...). When editing, keep the last image's type unless they ask for another.\n" +
    "   - prompt: the user's idea, written as a clear image description in English, keeping every detail they gave. " +
    "For edit, describe only the change.\n" +
    "   - enhance: true when their description is short or vague, or they ask for something better/more detailed; " +
    "false when they gave a detailed prompt or want it used as written.\n" +
    "2. {\"type\":\"model3d\",\"prompt\":\"...\",\"base\":null|\"attached\"|\"last_image\"} - a 3D model (.glb). The app shows " +
    "the mesh settings and the price before anything is spent. prompt: one object, plainly described, in English.\n" +
    "3. {\"type\":\"code\",\"prompt\":\"...\",\"shape\":\"script\"|\"system\",\"model\":null|\"luna\"|\"gemini\"} - " +
    "Luau code. script = one script; system = several scripts, remotes and instances that work together. Hand all " +
    "real coding to this tool rather than writing it in the reply. Keep prompt in the user's language and complete.\n" +
    "4. {\"type\":\"ui_to_lua\",\"prompt\":\"...\",\"base\":\"attached\"|\"last_image\"} - rebuild a pictured Roblox interface as a script.\n" +
    "5. {\"type\":\"workspace\",\"mode\":\"image\"|\"model3d\"|\"code\"|\"ui2lua\",\"task\":\"<task id>\",\"prompt\":\"...\"," +
    "\"image_type\":null|\"...\",\"base\":null|\"attached\"|\"last_image\",\"style\":null|\"attached\"|\"last_image\"} - open the " +
    "advanced frame on a task, already filled in, for the user to finish and run. Use it for the tasks the quick tools do not " +
    "cover, or when they ask to open it. Task ids - image: create, edit-photo, restyle, mark (paint a region), extend " +
    "(outpaint), cutout (transparent background), takes (variations); model3d: m-text, m-image, m-gen, m-multi, m-retopo, " +
    "m-segment, m-complete, m-texture, m-rig, m-convert; code: c-new, c-system, c-add, c-fix, c-refactor, c-explain; " +
    "ui2lua: u-shot, u-idea, u-blocks.\n" +
    "6. {\"type\":\"studio\",\"request\":\"...\"} - send an instruction to the agent inside the user's Roblox Studio (it builds " +
    "and edits the open place). Only when they want something done in Studio and the plugin is connected; if it is not, " +
    "say so instead. The app asks them to confirm unless they allowed it to run without asking.\n" +
    "7. {\"type\":\"enhance\",\"prompt\":\"...\",\"image_type\":\"...\"} - only improve an image prompt and put it in their box, " +
    "without generating.\n" +
    "8. {\"type\":\"mode\",\"mode\":\"chat\"|\"image\"|\"model3d\"|\"code\"|\"ui2lua\",\"image_type\":null|\"...\"} - only switch the tool, " +
    "and only when they explicitly ask to switch or open it (\"switch to code\", \"open the icon maker\"). Never use it to answer a " +
    "request to make something.\n" +
    "9. {\"type\":\"settings\",\"studio_auto_approve\":true|false} - when they say Studio requests may (or may no longer) run " +
    "without asking.\n\n" +
    "Rules:\n" +
    "- Read what they mean, not only the words: \"make it darker\", \"now as a thumbnail\", \"same but gold\" refer to the " +
    "last image; \"that sword\" may mean the last image or model. Use the conversation and the app state below.\n" +
    "- Never refer to a last image, model or script that the app state says does not exist, and never use \"attached\" " +
    "when nothing is attached: ask for it in the reply and set action to null.\n" +
    "- They want something made but have not said what it should show or do (\"make me an icon\", \"zrób ikonę\", \"napisz " +
    "skrypt\"): stay in the chat. Set action to null and ask one short question about the content, naming the kind of thing " +
    "you will make (\"Jasne, zrobię ikonę. Co ma na niej być?\"). Do not switch the mode. When they answer, run the tool " +
    "with the type from their first message, using the conversation above.\n" +
    "- They said what they want and what it is (\"ikona smoka\", \"a thumbnail for my obby\"): run the tool straight " +
    "away with the matching image_type; the app shows them the plan and they confirm it there, so do not also ask in the reply.\n" +
    "- Questions, advice, explanations and small talk: action null, answer properly.\n" +
    "- Do not invent a request they did not make. When it is genuinely unclear which of two things they want, ask.\n" +
    "- Never promise something no action here can do.";

function buildAgentSystemPrompt() {
    return CHAT_AGENT_SYSTEM_PROMPT;
}

// Keeps only what the app knows how to run, in the shapes it expects. A
// model answer is advice, not a command line: anything else is dropped.
function normalizeAgentAction(action, ctx) {
    if (!action || typeof action !== "object") return null;
    const type = String(action.type || "");
    if (!AGENT_ACTION_TYPES.includes(type)) return null;
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const str = (v, max) => (typeof v === "string" ? v : "").trim().slice(0, max || 4000);
    const types = Array.isArray(c.imageTypes) && c.imageTypes.length
        ? c.imageTypes.map(t => typeof t === "string" ? t : t.key)
        : AGENT_IMAGE_TYPES_FALLBACK;
    const imageType = v => types.includes(v) ? v : null;
    const hasAttached = (Number(c.attachments) || 0) > 0;
    const hasLast = !!(c.lastImage && c.lastImage.exists);
    const source = v => (v === "attached" && hasAttached) ? "attached" : (v === "last_image" && hasLast) ? "last_image" : null;

    switch (type) {
        case "image": {
            let op = ["create", "edit", "restyle"].includes(action.op) ? action.op : "create";
            const base = source(action.base);
            const style = source(action.style);
            if (op !== "create" && !base) return null;
            if (op === "restyle" && !style) op = "edit";
            const prompt = str(action.prompt);
            if (op !== "restyle" && !prompt) return null;
            return {
                type, op,
                image_type: imageType(action.image_type) || (op === "create" ? "normal" : imageType(c.lastImage && c.lastImage.type) || "normal"),
                prompt,
                enhance: action.enhance === true,
                base: op === "create" ? null : base,
                style: op === "restyle" ? style : null
            };
        }
        case "model3d":
            return { type, prompt: str(action.prompt, 800), base: source(action.base) };
        case "code": {
            const prompt = str(action.prompt, 8000);
            if (!prompt) return null;
            return {
                type, prompt,
                shape: action.shape === "system" ? "system" : "script",
                model: ["luna", "gemini"].includes(action.model) ? action.model : null
            };
        }
        case "ui_to_lua": {
            const base = source(action.base);
            if (!base) return null;
            return { type, prompt: str(action.prompt), base };
        }
        case "workspace": {
            const mode = Object.keys(AGENT_WORKSPACE_TASKS).includes(action.mode) ? action.mode : null;
            if (!mode) return null;
            const task = AGENT_WORKSPACE_TASKS[mode].includes(action.task) ? action.task : AGENT_WORKSPACE_TASKS[mode][0];
            return {
                type, mode, task,
                prompt: str(action.prompt, 8000),
                image_type: imageType(action.image_type),
                base: source(action.base),
                style: source(action.style)
            };
        }
        case "studio": {
            const request = str(action.request, 4000);
            if (!request) return null;
            return { type, request };
        }
        case "enhance": {
            const prompt = str(action.prompt);
            if (!prompt) return null;
            return { type, prompt, image_type: imageType(action.image_type) || imageType(c.imageType) || "normal" };
        }
        case "mode": {
            const mode = ["chat", "image", "model3d", "code", "ui2lua"].includes(action.mode) ? action.mode : null;
            if (!mode) return null;
            return { type, mode, image_type: imageType(action.image_type) };
        }
        case "settings":
            if (typeof action.studio_auto_approve !== "boolean") return null;
            return { type, studio_auto_approve: action.studio_auto_approve };
    }
    return null;
}

function buildChatSystemPrompt() {
    return CHAT_SYSTEM_PROMPT_BASE;
}

async function fetchRecentChatContext(env, accessToken, uid, chatId) {
    if (!chatId) return "";
    try {
        const res = await fetch(
            `${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages` +
            `?pageSize=${CHAT_CONTEXT_MESSAGES}&orderBy=${encodeURIComponent("createdAt desc")}`,
            { headers: { "Authorization": `Bearer ${accessToken}` } }
        );
        if (!res.ok) return "";
        const data = await res.json();
        const documents = (data.documents || []).reverse();
        const lines = [];
        for (const doc of documents) {
            const f = doc.fields || {};
            const userText = f.prompt?.stringValue || "";
            const category = f.category?.stringValue || "";
            const isImage = !!(f.thumbnail || f.imageUrl?.stringValue);
            const botText = f.reply?.stringValue ||
                (isImage ? "[made an image" + (category ? " (" + category + ")" : "") + (userText ? ' from "' + userText.slice(0, 160) + '"' : "") + "]"
                    : f.modelUrl ? "[made a 3D model]" : "");
            if (userText) lines.push("User: " + userText);
            if (botText) lines.push("Assistant: " + botText);
        }
        return lines.join("\n");
    } catch (e) {
        return "";
    }
}

async function handleChat(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runChat(env, uid, body);
}

async function runChat(env, uid, body) {
    const { chatId, message, image, images } = body;
    const agent = body.agent === 2;

    // Wsteczna kompatybilność: pojedyncze `image` traktujemy jak tablicę
    // jednoelementową, jeśli `images` nie zostało podane.
    const imageList = Array.isArray(images) && images.length > 0
        ? images
        : (image ? [image] : []);

    if (!message && imageList.length === 0) return json({ error: "Pusta wiadomość" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    const admit = await chatAdmit(env, accessToken, uid, message, imageList);
    if (admit.error) return admit.error;
    const meter = admit.meter;

    const contextText = await fetchRecentChatContext(env, accessToken, uid, chatId);

    const userParts = [];
    const contextBlock = contextText ? ("Recent conversation so far:\n" + contextText + "\n\n") : "";
    const stateBlock = agent ? ("What is on the user's screen right now:\n" + agentContextText(body.context) + "\n\n") : "";
    userParts.push({ text: contextBlock + stateBlock + "User's new message: " + (message || "(brak tekstu — zobacz załączone obrazy)") });

    const imageFiles = [];
    for (const img of imageList) {
        try {
            const parsed = parseDataUrl(img);
            imageFiles.push(parsed);
            userParts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.base64 } });
        } catch (e) { /* pomiń nieprawidłowy obraz */ }
    }

    const geminiRes = await fetchAssistant(env, {
        system_instruction: { parts: [{ text: agent ? buildAgentSystemPrompt() : buildChatSystemPrompt() }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: { temperature: agent ? 0.4 : 0.7, maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS }
    });

    const failed = async (res) => { await chatSettle(env, accessToken, uid, meter, false); return res; };
    if (!geminiRes.ok) return failed(json({ error: "Model error: " + await geminiRes.text() }, geminiRes.status));

    const geminiData = await geminiRes.json();
    const blockReason = geminiData.promptFeedback?.blockReason;
    if (blockReason) return failed(json({ error: "The model refused the message (" + blockReason + ")." }, 400));

    const rawText = extractGeminiText(geminiData);
    if (!rawText) return failed(json({ error: "The model returned no content." }, 500));

    const billing = await chatSettle(env, accessToken, uid, meter, true,
        geminiData.usageMetadata, geminiData.modelVersion, rawText.length);

    let parsed;
    try { parsed = parseJsonFromGemini(rawText); }
    catch (e) { return json({ reply: rawText, action: null, billing }); } // fallback: potraktuj jako zwykły tekst

    const reply = String(parsed.reply || "").trim() || "...";

    if (agent) return json({ reply, action: normalizeAgentAction(parsed.action, body.context), billing });

    return json(Object.assign(await resolveChatAction(env, accessToken, uid, {
        reply,
        action: parsed.action,
        message,
        imageList,
        imageFiles
    }), { billing }));
}

// ── Metering the assistant ────────────────────────────────────────────────
// One Firestore commit per message: it bumps today's count and this minute's
// count in users/{uid}/chatUsage/{day} and returns both, so the decision is
// made on numbers no parallel request can race.
async function chatUsageBump(env, accessToken, uid, by) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const minute = "m" + now.toISOString().slice(11, 16).replace(":", "");
    const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}/chatUsage/${day}`;
    const transforms = [{ fieldPath: "count", increment: { integerValue: String(by) } }];
    if (by > 0) transforms.push({ fieldPath: minute, increment: { integerValue: String(by) } });
    const res = await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{
                update: { name, fields: { day: { stringValue: day } } },
                updateMask: { fieldPaths: ["day"] },
                updateTransforms: transforms
            }]
        })
    });
    if (!res.ok) throw new Error("chat usage " + res.status + ": " + (await res.text()).slice(0, 200));
    const r = (await res.json()).writeResults?.[0]?.transformResults || [];
    return {
        count: parseInt(r[0]?.integerValue ?? "0", 10),
        perMinute: parseInt(r[1]?.integerValue ?? "0", 10)
    };
}

// Checks a chat message before any model is called. Returns { error } with
// a Response to send back, or { meter } describing how this one is paid.
async function chatAdmit(env, accessToken, uid, message, imageList) {
    if (String(message || "").length > CHAT_MAX_MESSAGE_CHARS) {
        return { error: json({ error: "That message is too long for the assistant (" + CHAT_MAX_MESSAGE_CHARS +
            " characters at most). For a long script, use the Code tool.", code: "CHAT_TOO_LONG" }, 400) };
    }
    if (imageList.length > CHAT_MAX_IMAGES || imageList.some(i => String(i).length > CHAT_MAX_IMAGE_CHARS)) {
        return { error: json({ error: "Attach up to " + CHAT_MAX_IMAGES + " pictures, each under about 6 MB.",
            code: "CHAT_TOO_BIG" }, 400) };
    }

    let usage;
    try {
        usage = await chatUsageBump(env, accessToken, uid, 1);
    } catch (e) {
        // The meter being down must not take the assistant with it; the
        // message is charged instead of counted as free.
        console.error("chat meter:", e.message);
        usage = { count: CHAT_FREE_PER_DAY + 1, perMinute: 1, unmetered: true };
    }

    if (usage.perMinute > CHAT_MAX_PER_MINUTE) {
        return { error: json({ error: "That is a lot of messages in a minute. Wait a moment and send it again.",
            code: "CHAT_RATE" }, 429) };
    }
    if (usage.count > CHAT_MAX_PER_DAY) {
        return { error: json({ error: "The assistant has answered " + CHAT_MAX_PER_DAY +
            " messages on this account today, which is the daily limit. It is back tomorrow.", code: "CHAT_DAY_CAP" }, 429) };
    }

    const free = usage.count <= CHAT_FREE_PER_DAY;
    if (!free && !(await canGenerateCode(env, accessToken, uid))) {
        // Nothing was used, so the attempt does not count.
        chatUsageBump(env, accessToken, uid, -1).catch(() => {});
        return { error: json({ error: "Your " + CHAT_FREE_PER_DAY + " free assistant messages for today are used. " +
            "Top up tokens to keep chatting: each reply costs a small fraction of a token.", code: "CHAT_NO_TOKENS" }, 402) };
    }
    return { meter: { free, count: usage.count, freeLeft: Math.max(0, CHAT_FREE_PER_DAY - usage.count) } };
}

// What one assistant reply cost, from the usage the model reported. Luna at
// its own rates; the Gemini fallback at Gemini's (thinking included). If a
// reply came back with no usage at all, it is estimated from its length.
function assistantCostUsd(usageMetadata, model, fallbackChars) {
    const u = usageMetadata || {};
    if (!u.promptTokenCount && !u.candidatesTokenCount) {
        const tokens = (fallbackChars || 0) / 3;
        return (tokens * 0.75 / 1e6) + (1500 * 0.125 / 1e6);
    }
    if (/^gpt-/i.test(model || LUNA_MODEL)) {
        return calcLunaCostUsd({
            prompt_tokens: u.promptTokenCount || 0,
            completion_tokens: u.candidatesTokenCount || 0,
            prompt_tokens_details: {
                cached_tokens: u.cachedContentTokenCount || 0,
                ...(u.cacheWriteTokenCount !== undefined ? { cache_write_tokens: u.cacheWriteTokenCount } : {})
            }
        }) / MARGIN_MULTIPLIER;
    }
    return ((u.promptTokenCount || 0) * 0.75 +
        ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * 3.75) / 1e6;
}

// Settles one reply: a free one is only counted, a paid one is charged its
// cost. A reply that failed gives its free slot back.
async function chatSettle(env, accessToken, uid, meter, ok, usageMetadata, model, chars) {
    if (!meter) return null;
    if (!ok) {
        if (meter.free) await chatUsageBump(env, accessToken, uid, -1).catch(() => {});
        return null;
    }
    if (meter.free) return { free: true, freeLeft: meter.freeLeft };
    const usd = assistantCostUsd(usageMetadata, model, chars);
    const milli = Math.max(CHAT_MIN_MILLI, Math.ceil((usd / TOKEN_VALUE_USD) * 1000));
    await chargeForCodeGenerationByCost(env, accessToken, uid, usd, CHAT_MIN_MILLI)
        .catch(e => console.error("chat charge failed", e));
    return { free: false, freeLeft: 0, chargedMilli: milli };
}

async function handleChatStream(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    return await runChatStream(env, uid, body);
}

// Web-app only. /chat stays a single JSON response because the Roblox plugin
// proxies it and reads it with res.clone().json() — and HttpService cannot
// stream anyway. Same model, same prompt, same action handling; only the
// transport differs.
async function runChatStream(env, uid, body) {
    const { chatId, message, image, images } = body;
    const agent = body.agent === 2;

    const imageList = Array.isArray(images) && images.length > 0
        ? images
        : (image ? [image] : []);

    if (!message && imageList.length === 0) return json({ error: "Pusta wiadomość" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    // Checked before the stream opens, so a refusal is a plain JSON error.
    const admit = await chatAdmit(env, accessToken, uid, message, imageList);
    if (admit.error) return admit.error;
    const meter = admit.meter;

    const contextText = await fetchRecentChatContext(env, accessToken, uid, chatId);

    const userParts = [];
    const contextBlock = contextText ? ("Recent conversation so far:\n" + contextText + "\n\n") : "";
    const stateBlock = agent ? ("What is on the user's screen right now:\n" + agentContextText(body.context) + "\n\n") : "";
    userParts.push({ text: contextBlock + stateBlock + "User's new message: " + (message || "(brak tekstu — zobacz załączone obrazy)") });

    const imageFiles = [];
    for (const img of imageList) {
        try {
            const parsed = parseDataUrl(img);
            imageFiles.push(parsed);
            userParts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.base64 } });
        } catch (e) { /* pomiń nieprawidłowy obraz */ }
    }

    const geminiBody = {
        system_instruction: { parts: [{ text: agent ? buildAgentSystemPrompt() : buildChatSystemPrompt() }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: { temperature: agent ? 0.4 : 0.7, maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS }
    };

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            let closed = false;
            const send = (event, data) => {
                if (closed) return;
                controller.enqueue(encoder.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"));
            };
            const finish = () => { if (!closed) { closed = true; controller.close(); } };
            let usageMetadata = null, modelVersion = null, settled = false;
            // Every way out of the stream goes through here exactly once.
            const settle = async (ok, chars) => {
                if (settled) return null;
                settled = true;
                return await chatSettle(env, accessToken, uid, meter, ok, usageMetadata, modelVersion, chars);
            };
            const fail = async (error) => { send("error", { error }); await settle(false); return finish(); };

            try {
                send("stage", { stage: imageFiles.length > 0 ? "reading_image" : "thinking" });

                const upstream = await fetchAssistantStream(env, geminiBody);
                if (!upstream.ok || !upstream.body) {
                    const detail = await upstream.text().catch(() => "status " + upstream.status);
                    return await fail("Model error: " + detail);
                }

                const reader = upstream.body.getReader();
                const decoder = new TextDecoder();
                let sseBuf = "";
                let raw = "";
                let emitted = 0;
                let blockReason = null;

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    sseBuf += decoder.decode(value, { stream: true });

                    let nl;
                    while ((nl = sseBuf.indexOf("\n")) !== -1) {
                        const line = sseBuf.slice(0, nl).trim();
                        sseBuf = sseBuf.slice(nl + 1);
                        if (!line.startsWith("data:")) continue;

                        const payload = line.slice(5).trim();
                        if (!payload || payload === "[DONE]") continue;

                        let chunk;
                        try { chunk = JSON.parse(payload); } catch (e) { continue; }

                        if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
                        if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
                        if (chunk.modelVersion) modelVersion = chunk.modelVersion;
                        raw += (chunk.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");

                        const soFar = extractPartialReply(raw);
                        if (soFar !== null && soFar.length > emitted) {
                            send("delta", { text: soFar.slice(emitted) });
                            emitted = soFar.length;
                        }
                    }
                }

                if (blockReason) return await fail("The model refused the message (" + blockReason + ").");
                if (!raw.trim()) return await fail("The model returned no content.");

                const billing = await settle(true, raw.length);

                let parsed;
                try {
                    parsed = parseJsonFromGemini(raw);
                } catch (e) {
                    // Same fallback as /chat: treat the whole output as prose.
                    const plain = raw.trim();
                    if (emitted === 0) send("delta", { text: plain });
                    else if (plain.length !== emitted) send("replace", { reply: plain });
                    send("done", { reply: plain, action: null, billing });
                    return finish();
                }

                const reply = String(parsed.reply || "").trim() || "...";

                if (agent) {
                    send("done", { reply, action: normalizeAgentAction(parsed.action, body.context), billing });
                    return finish();
                }

                // This branch charges tokens and rewrites the reply, so tell the
                // client work is still happening rather than looking finished.
                const willBuildUi = parsed.action?.type === "generate_ui_lua"
                    && parsed.action.use_attached_image
                    && imageList.length > 0;
                if (willBuildUi) send("stage", { stage: "ui_to_lua" });

                const result = await resolveChatAction(env, accessToken, uid, {
                    reply,
                    action: parsed.action,
                    message,
                    imageList,
                    imageFiles
                });

                // The streamed prose is only provisional when a branch replaced it.
                if (result.reply !== reply) send("replace", { reply: result.reply });

                send("done", { reply: result.reply, action: result.action || null, billing });
                return finish();

            } catch (e) {
                return await fail(String((e && e.message) || e));
            }
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            ...corsHeaders()
        }
    });
}

// Shared by /chat and /chat/stream. Returns a plain object instead of a
// Response so the streaming endpoint can emit the same outcome as SSE without
// a second copy of the token-charging branch below.
async function resolveChatAction(env, accessToken, uid, ctx) {
    const { reply, action, message, imageList, imageFiles } = ctx;

    if (!action || !action.type) {
        return { reply, action: null };
    }

    // ---- generate_icon / generate_thumbnail: NIE generujemy od razu.
    // Zwracamy sygnał dla frontendu, żeby pokazał wspólny chooser trybu
    // (ten sam mechanizm co przy modelu 3D). Realne generowanie odbywa się
    // dopiero po wyborze metody, przez istniejący endpoint /generate.
    if (action.type === "generate_icon" || action.type === "generate_thumbnail") {
        const category = action.type === "generate_thumbnail" ? CATEGORIES.THUMBNAIL : CATEGORIES.ICON;
        return {
            reply,
            action: { type: "need_image_method", category, prompt: String(action.prompt || message || "").trim() }
        };
    }

    // ---- generate_ui_lua ----
    if (action.type === "generate_ui_lua") {
        if (!action.use_attached_image || imageList.length === 0) {
            return { reply: reply || "Upload a UI screenshot that I should recreate as a script.", action: null };
        }

        const charged = await chargeTokens(env, accessToken, uid, TOKEN_COSTS.imageToUi);
        if (!charged) return { reply: reply + " (Not enough tokens for UI -> Lua generation — please top up.)", action: { type: "need_tokens" } };

        try {
            const userText = "Recreate this Roblox UI as a Lua script." +
                (action.prompt ? (" Additional instructions from the user: " + action.prompt) : "");
            const parsedImg = parseDataUrl(imageList[0]);

            const uiRes = await fetchAssistant(env, {
                system_instruction: { parts: [{ text: uiLuaSystemPrompt("screenshot", false) }] },
                contents: [{
                    role: "user",
                    parts: [
                        { text: userText },
                        { inline_data: { mime_type: parsedImg.mimeType, data: parsedImg.base64 } }
                    ]
                }],
                generationConfig: { temperature: 0.4 }
            });

            if (!uiRes.ok) throw new Error(await uiRes.text());
            const uiData = await uiRes.json();
            const uiBlock = uiData.promptFeedback?.blockReason;
            if (uiBlock) throw new Error("The model refused the image (" + uiBlock + ").");

            const uiRawText = extractGeminiText(uiData);
            if (!uiRawText) throw new Error("The model returned no content.");

            let uiParsed;
            try {
                uiParsed = parseJsonFromGemini(uiRawText);
            } catch (e) {
                const codeMatch = uiRawText.match(/```(?:lua)?\s*([\s\S]*?)```/i);
                if (!codeMatch) throw new Error("Could not read the model's answer.");
                uiParsed = { description: "", code: codeMatch[1].trim() };
            }

            const code = String(uiParsed.code || "").trim();
            if (!code) throw new Error("The model returned no code.");

            const description = String(uiParsed.description || "").trim();
            const combinedReply = (description || reply) + "\n\n```lua\n" + code + "\n```";

            return { reply: combinedReply, action: null };

        } catch (e) {
            await refundTokens(env, accessToken, uid, TOKEN_COSTS.imageToUi);
            return { reply: reply + " (Failed to generate UI script: " + e.message + ")", action: null };
        }
    }

    // ---- generate_3d ----
    if (action.type === "generate_3d") {
        if (action.needs_reference_choice) {
            return { reply, action: { type: "need_3d_method" } };
        }
        if (action.use_attached_image && imageFiles.length > 0) {
            return { reply, action: { type: "need_3d_settings", useAttachedImage: true, prompt: action.prompt || "" } };
        }
        const desc = String(action.prompt || "").trim();
        if (desc) {
            return { reply, action: { type: "need_3d_settings", useAttachedImage: false, prompt: desc } };
        }
        return { reply, action: { type: "need_3d_method" } };
    }

    // ---- generate_code: nie generujemy w czacie, tylko przenosimy do trybu Code,
    // żeby oszczędzić Gemini na cięższe zadania programistyczne.
    if (action.type === "generate_code") {
        return {
            reply,
            action: { type: "need_code_mode", prompt: String(action.prompt || message || "").trim() }
        };
    }

    return { reply, action: null };
}

// ============================================================================
// TRIPO
// ============================================================================

async function handleTripoGenerate(request, env) {
    const uid = await requireAuth(request, env);
    return await runTripoForUid(env, uid, await request.json());
}

// Same body, uid supplied by the caller — lets the plugin proxy reach it.
async function runTripoForUid(env, uid, requestBody) {
    const { prompt, image, settings, shareSell } = requestBody;
    if (!prompt && !image) return json({ error: "Missing description or image" }, 400);

    const baseCost = calcModel3DCost(settings, !!image);
    const finalCost = shareSell ? Math.max(0, baseCost - SHARE_SELL_DISCOUNT) : baseCost;

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const charged = await chargeTokens(env, accessToken, uid, finalCost);
    if (!charged) return json({ error: "Not enough tokens." }, 402);

    try {
        let taskId;
        if (image) {
            const imageToken = await tripoUploadImage(env, image);
            taskId = await tripoCreateTask(env, buildTripoTaskBody({ type: "image_to_model", imageToken, settings }));
        } else {
            taskId = await tripoCreateTask(env, buildTripoTaskBody({ type: "text_to_model", prompt, settings }));
        }

        const normalized = normalizeSettings(settings);
        
        // Save tripoTask mapping for publish verification and refunds
        await fetch(`${firestoreBaseUrl(env)}/tripoTasks?documentId=${encodeURIComponent(taskId)}`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                fields: {
                    uid: { stringValue: uid },
                    cost: { integerValue: String(finalCost) },
                    baseCost: { integerValue: String(baseCost) },
                    shareSell: { booleanValue: !!shareSell },
                    series: { stringValue: normalized.series },
                    hdTexture: { booleanValue: normalized.hdTexture },
                    ultra8kTexture: { booleanValue: normalized.ultra8kTexture },
                    hdGeometry: { booleanValue: normalized.hdGeometry },
                    quadMesh: { booleanValue: normalized.quadMesh },
                    smartLowPoly: { booleanValue: normalized.smartLowPoly },
                    generateParts: { booleanValue: normalized.generateParts },
                    prompt: { stringValue: String(prompt || "").slice(0, 600) },
                    status: { stringValue: "pending" },
                    createdAt: { timestampValue: new Date().toISOString() }
                }
            })
        });

        return json({ taskId, cost: finalCost, baseCost, shareSell: !!shareSell });
    } catch (e) {
        await refundTokens(env, accessToken, uid, finalCost);
        return json({ error: "Tripo: " + e.message }, 500);
    }
}


function isPrivateOrLocalHost(hostname) {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;

    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = +m[1], b = +m[2];
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
    }
    return false;
}

async function safeFetchFollowingRedirects(remoteUrl) {
    let currentUrl = remoteUrl;
    const browserLikeHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "*/*"
    };

    for (let redirects = 0; redirects <= 5; redirects++) {
        const parsed = new URL(currentUrl);
        if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || isPrivateOrLocalHost(parsed.hostname)) {
            throw new Error("Not allowed file source");
        }

        const upstream = await fetch(currentUrl, { redirect: "manual", headers: browserLikeHeaders });

        if (upstream.status >= 300 && upstream.status < 400) {
            const location = upstream.headers.get("Location");
            if (!location) throw new Error("File source returned an invalid redirect.");
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        return upstream;
    }

    throw new Error("Too many redirects from file source.");
}

async function persistToR2(env, remoteUrl, key, contentType) {
    const upstream = await safeFetchFollowingRedirects(remoteUrl);
    if (!upstream.ok || !upstream.body) {
        throw new Error(`Failed to fetch from ${remoteUrl}, status: ${upstream.status}`);
    }
    const finalContentType = contentType || upstream.headers.get("content-type") || "application/octet-stream";
    await env.ASSETS_BUCKET.put(key, upstream.body, { httpMetadata: { contentType: finalContentType } });
    return `${env.PUBLIC_WORKER_URL}/asset/${encodeURIComponent(key)}`;
}

async function handleServeAsset(request, env, path) {
    const key = decodeURIComponent(path.replace("/asset/", ""));
    const obj = await env.ASSETS_BUCKET.get(key);
    if (!obj) {
        return new Response("Not found", { status: 404, headers: corsHeaders() });
    }
    const headers = new Headers();
    headers.set("Content-Type", obj.httpMetadata?.contentType || "application/octet-stream");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    const reqUrl = new URL(request.url);
    if (reqUrl.searchParams.has("download")) {
        let dlParam = reqUrl.searchParams.get("download");
        let filename;
        if (dlParam && dlParam !== "1") {
            filename = dlParam;
        } else {
            const ext = key.includes('.') ? key.split('.').pop() : "bin";
            filename = `RoPeak-${Date.now()}.${ext}`;
        }
        filename = filename.replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, "_") || "RoPeak-Download";
        headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    }

    const cors = corsHeaders();
    for (const [k, v] of Object.entries(cors)) {
        headers.set(k, v);
    }

    return new Response(obj.body, { status: 200, headers });
}

async function handleProxyDownload(request, env, url) {
    await requireAuth(request, env);

    const rawUrl = url.searchParams.get("url");
    const filename = (url.searchParams.get("filename") || "download")
        .replace(/[^\w.\-]+/g, "_").slice(0, 120) || "download";
    if (!rawUrl) return json({ error: "Brak parametru url" }, 400);

    const remoteUrl = rawUrl.trim();

    let upstream;
    try {
        upstream = await safeFetchFollowingRedirects(remoteUrl);
    } catch (e) {
        console.error("proxy-download: fetch failed:", remoteUrl, e.message);
        return json({ error: "Failed to download file from source: " + e.message }, 502);
    }

    if (!upstream.ok || !upstream.body) {
        console.error("proxy-download: upstream fetch failed", upstream.status, remoteUrl);
        return json({ error: "Failed to download file from source (status " + upstream.status + ")" }, 502);
    }

    const headers = {
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders()
    };
    const len = upstream.headers.get("content-length");
    if (len) headers["Content-Length"] = len;

    return new Response(upstream.body, { status: 200, headers });
}

// ============================================================================
// /tripo/bench — every V3 operation behind one route
// ============================================================================
//
// The frontend names an operation and hands over the model it should work on:
// a public URL (what we serve from R2), a file token, or an earlier V3 task
// id. Rigging is the one chain with an order to it — retarget only accepts
// the task id of a finished rig, never a raw model — so that rule is enforced
// here rather than trusted to the caller.
async function handleTripoBench(request, env) {
    const uid = await requireAuth(request, env);
    const { op, input, params } = await request.json();

    const spec = TRIPO_V3_OPS[op];
    if (!spec) return json({ error: "Unknown operation: " + op }, 400);
    if (op !== "multiview" && !String(input || "").trim()) {
        return json({ error: "Pick a model first — there is nothing to work on." }, 400);
    }
    if (op === "retarget" && !/^task[_-]/i.test(String(input || ""))) {
        return json({ error: "Animations can only be applied to a finished rig, not to a raw model." }, 400);
    }

    const p = params || {};
    let body;

    if (op === "multiview") {
        // Generation, not bench work: several views in, one mesh out.
        const views = Array.isArray(p.images) ? p.images : [];
        if (views.length < 2) return json({ error: "Multiview needs at least two images." }, 400);
        const tokens = [];
        for (const v of views) tokens.push(await tripoUploadImage(env, v));
        body = {
            model: p.model || TRIPO_MODEL_VERSION_P1,
            files: tokens.map(t => ({ type: "image", file_token: t })),
            face_limit: clampInt(p.faceLimit, 1000, 50000, 10000),
            texture: p.texture !== false,
            pbr: !!p.pbr
        };
    } else {
        body = { input: tripoV3Ref(input) };

        if (op === "decimate") {
            body.face_limit = clampInt(p.faceLimit, 500, 200000, 10000);
            if (p.quad) body.quad = true;
        } else if (op === "texture") {
            body.texture_quality = ["standard", "detailed", "HD"].includes(p.textureQuality) ? p.textureQuality : "detailed";
            body.pbr = p.pbr !== false;
            if (p.textureSeed != null) body.texture_seed = clampInt(p.textureSeed, 0, 2147483647, 0);
        } else if (op === "convert") {
            const allowed = ["glb", "gltf", "fbx", "obj", "stl", "usdz", "3mf"];
            const fmt = String(p.format || "fbx").toLowerCase();
            if (!allowed.includes(fmt)) return json({ error: "Unsupported format: " + fmt }, 400);
            body.format = fmt;
        } else if (op === "rig") {
            body.rig_type = p.rigType || "biped";
            body.spec = p.spec === "tripo" ? "tripo" : "mixamo";
            body.out_format = p.outFormat === "fbx" ? "fbx" : "glb";
            if (p.model) body.model = p.model;
        } else if (op === "retarget") {
            const presets = Array.isArray(p.animations) && p.animations.length ? p.animations : ["preset:idle"];
            body.animations = presets.slice(0, 8);
            body.out_format = p.outFormat === "fbx" ? "fbx" : "glb";
        }
    }

    const cost = spec.cost ? TOKEN_COSTS[spec.cost] : 0;
    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    if (cost > 0) {
        const charged = await chargeTokens(env, accessToken, uid, cost);
        if (!charged) return json({ error: "Not enough tokens." }, 402);
    }

    try {
        const data = await tripoV3Create(env, op, body);

        // rig-check answers immediately instead of queueing a task, so it is
        // reported as a finished result rather than something to poll.
        if (op === "rig-check" && data && data.riggable !== undefined) {
            return json({ done: true, riggable: !!data.riggable, rigType: data.rig_type || data.suggested_rig_type || null });
        }

        const taskId = data.task_id || data.taskId;
        if (!taskId) throw new Error("Tripo V3 returned no task id.");

        if (cost > 0) {
            // Same record the V2 flow keeps, so a failure refunds the same way.
            await fetch(`${firestoreBaseUrl(env)}/tripoTasks?documentId=${encodeURIComponent(taskId)}`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    fields: {
                        uid: { stringValue: uid },
                        cost: { integerValue: String(cost) },
                        op: { stringValue: op },
                        api: { stringValue: "v3" },
                        status: { stringValue: "pending" },
                        createdAt: { timestampValue: new Date().toISOString() }
                    }
                })
            });
        }

        return json({ taskId, op, cost });
    } catch (e) {
        if (cost > 0) await refundTokens(env, accessToken, uid, cost);
        return json({ error: "Tripo V3: " + e.message }, 500);
    }
}

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

// V3 reports its own task shape, so it gets its own status route rather than
// bending the V2 one around two response formats.
async function handleTripoBenchStatus(request, env, url) {
    await requireAuth(request, env);
    const taskId = url.searchParams.get("id");
    if (!taskId) return json({ error: "Missing task id" }, 400);

    try {
        const data = await tripoV3Get(env, taskId);
        const statusMap = {
            queued: "PENDING", running: "PENDING", success: "SUCCEEDED",
            failed: "FAILED", cancelled: "CANCELED", banned: "FAILED", expired: "FAILED"
        };
        const status = statusMap[data.status] || "PENDING";

        if (status === "FAILED" || status === "CANCELED") {
            await processTripoRefund(env, taskId, data);
            return json({ status, taskId, errorMessage: data.error?.message || null });
        }

        if (status !== "SUCCEEDED") {
            return json({ status, progress: data.progress ?? 0, taskId });
        }

        const out = data.output || {};
        const rawModel = out.model_url || out.model || out.pbr_model || null;
        const rawThumb = out.rendered_image_url || out.rendered_image || null;
        // Segmentation returns a set of sub-objects rather than one mesh.
        const parts = Array.isArray(out.parts) ? out.parts : (Array.isArray(out.segments) ? out.segments : []);

        if (!rawModel && !parts.length) {
            await processTripoRefund(env, taskId, data);
            return json({ status: "FAILED", taskId, errorMessage: "Tripo returned no file." });
        }

        // Tripo's own links expire; ours do not, so the result is copied out
        // before it is handed to the page.
        let modelUrl = rawModel, thumbnailUrl = rawThumb;
        const ext = (rawModel || "").split("?")[0].split(".").pop().toLowerCase();
        const keepExt = ["glb", "gltf", "fbx", "obj", "stl", "usdz", "3mf"].includes(ext) ? ext : "glb";
        const jobs = [];
        if (rawModel) {
            jobs.push(persistToR2(env, rawModel, `models/${taskId}.${keepExt}`,
                keepExt === "glb" ? "model/gltf-binary" : "application/octet-stream").then(u => { modelUrl = u; }));
        }
        if (rawThumb) {
            jobs.push(persistToR2(env, rawThumb, `thumbnails/${taskId}.png`, "image/png").catch(() => null).then(u => { if (u) thumbnailUrl = u; }));
        }
        const partUrls = [];
        parts.slice(0, 12).forEach((part, i) => {
            const u = typeof part === "string" ? part : (part.model_url || part.url);
            if (!u) return;
            jobs.push(persistToR2(env, u, `models/${taskId}-part-${i}.glb`, "model/gltf-binary")
                .then(saved => { partUrls.push({ name: (part && part.name) || `part ${i + 1}`, modelUrl: saved }); })
                .catch(() => null));
        });
        await Promise.all(jobs);

        return json({
            status: "SUCCEEDED",
            progress: 100,
            taskId,
            format: keepExt,
            modelUrl: modelUrl || null,
            thumbnailUrl: thumbnailUrl || null,
            parts: partUrls
        });
    } catch (e) {
        return json({ error: "Tripo V3: " + e.message }, 500);
    }
}

async function handleTripoStatus(request, env, url) {
    await requireAuth(request, env);
    const taskId = url.searchParams.get("id");
    if (!taskId) return json({ error: "Brak id zadania" }, 400);

    try {
        const data = await tripoGetTask(env, taskId);
        const statusMap = { queued: "PENDING", running: "PENDING", success: "SUCCEEDED", failed: "FAILED", cancelled: "CANCELED", banned: "FAILED", expired: "FAILED", unknown: "FAILED" };
        const mappedStatus = statusMap[data.status] || "PENDING";

        // Wynik zadania konwersji -> zwróć finalnie
        if (data.type === "convert_model") {
            if (mappedStatus === "FAILED" || mappedStatus === "CANCELED") {
                await processTripoRefund(env, taskId, data);
                return json({
                    status: mappedStatus,
                    progress: data.progress ?? 0,
                    modelUrl: data.output?.model || null,
                    thumbnailUrl: data.output?.rendered_image || null,
                    taskId: data.task_id || taskId,
                    errorMessage: data.error?.message || null
                });
            }
            if (mappedStatus === "SUCCEEDED") {
                const rawModelUrl = data.output?.model || null;
                const rawThumbnailUrl = data.output?.rendered_image || null;

                let modelUrl = rawModelUrl;
                let thumbnailUrl = rawThumbnailUrl;

                if (rawModelUrl) {
                    const promises = [];
                    promises.push(persistToR2(env, rawModelUrl, `models/${taskId}.glb`, "model/gltf-binary").then(u => { modelUrl = u; }));
                    if (rawThumbnailUrl) {
                        promises.push(persistToR2(env, rawThumbnailUrl, `thumbnails/${taskId}.png`, "image/png").catch(() => null).then(u => { if (u) thumbnailUrl = u; }));
                    }
                    await Promise.all(promises);
                }

                return json({
                    status: mappedStatus,
                    progress: data.progress ?? 0,
                    modelUrl: modelUrl,
                    thumbnailUrl: thumbnailUrl,
                    taskId: data.task_id || taskId,
                    errorMessage: data.error?.message || null
                });
            }
            return json({
                status: mappedStatus,
                progress: data.progress ?? 0,
                modelUrl: data.output?.model || null,
                thumbnailUrl: data.output?.rendered_image || null,
                taskId: data.task_id || taskId,
                errorMessage: data.error?.message || null
            });
        }

        if (mappedStatus === "SUCCEEDED") {
            const rawModelUrl = data.output?.model || data.output?.pbr_model || data.output?.base_model || null;
            const actualType = (data.result?.model?.type || "").toLowerCase();

            if (!rawModelUrl) {
                await processTripoRefund(env, taskId, data);
                return json({ status: "FAILED", errorMessage: "Tripo did not return a model file.", taskId });
            }

            // Konwertuj TYLKO jeśli faktyczny typ (wg samego Tripo, nie rozszerzenia URL) nie jest glb
            if (actualType && actualType !== "glb") {
                const originalInput = data.input || {};
                const convertTaskId = await tripoCreateTask(env, {
                    type: "convert_model",
                    format: "GLB",
                    original_model_task_id: taskId
                });

                // Zapisz wpis o konwersji, aby móc zwrócić tokeny z oryginalnego zadania
                try {
                    const accessToken = await getGoogleAccessToken(env);
                    await fetch(`${firestoreBaseUrl(env)}/tripoTasks?documentId=${encodeURIComponent(convertTaskId)}`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ fields: { originalTaskId: { stringValue: taskId } } })
                    });
                } catch (e) { console.error("Error saving conversion task:", e); }

                return json({
                    status: "PENDING",
                    progress: 95,
                    thumbnailUrl: data.output?.rendered_image || null,
                    taskId: convertTaskId
                });
            }

            // Już jest glb -> zapisz w R2 i zwróć
            let modelUrl = rawModelUrl;
            let thumbnailUrl = data.output?.rendered_image || null;

            const promises = [];
            promises.push(persistToR2(env, rawModelUrl, `models/${taskId}.glb`, "model/gltf-binary").then(u => { modelUrl = u; }));
            if (thumbnailUrl) {
                promises.push(persistToR2(env, thumbnailUrl, `thumbnails/${taskId}.png`, "image/png").catch(() => null).then(u => { if (u) thumbnailUrl = u; }));
            }
            await Promise.all(promises);

            return json({
                status: "SUCCEEDED",
                progress: 100,
                modelUrl: modelUrl,
                thumbnailUrl: thumbnailUrl,
                taskId: data.task_id || taskId
            });
        }

        if (mappedStatus === "FAILED" || mappedStatus === "CANCELED") {
            await processTripoRefund(env, taskId, data);
            return json({ status: mappedStatus, errorMessage: data.error?.message || null, taskId });
        }

        return json({ status: mappedStatus, progress: data.progress ?? 0, thumbnailUrl: data.output?.rendered_image || null, taskId });
    } catch (e) {
        return json({ error: "Tripo: " + e.message }, 500);
    }
}

async function processTripoRefund(env, taskId, data) {
    try {
        const accessToken = await getGoogleAccessToken(env);
        let lookupTaskId = taskId;

        if (data && data.type === "convert_model") {
            const convDoc = await fetch(`${firestoreBaseUrl(env)}/tripoTasks/${taskId}`, { headers: { "Authorization": `Bearer ${accessToken}` } }).then(r => r.ok ? r.json() : null);
            if (convDoc && convDoc.fields?.originalTaskId?.stringValue) {
                lookupTaskId = convDoc.fields.originalTaskId.stringValue;
            } else if (data.input?.original_model_task_id) {
                lookupTaskId = data.input.original_model_task_id;
            }
        }

        const taskDoc = await fetch(`${firestoreBaseUrl(env)}/tripoTasks/${lookupTaskId}`, { headers: { "Authorization": `Bearer ${accessToken}` } }).then(r => r.ok ? r.json() : null);
        if (taskDoc && taskDoc.fields) {
            const taskUid = taskDoc.fields.uid?.stringValue;
            const cost = parseInt(taskDoc.fields.cost?.integerValue || "0", 10);
            const status = taskDoc.fields.status?.stringValue;

            if (taskUid && cost > 0 && status !== "refunded") {
                await refundTokens(env, accessToken, taskUid, cost);
                await fetch(`${firestoreBaseUrl(env)}/tripoTasks/${lookupTaskId}?updateMask.fieldPaths=status`, {
                    method: "PATCH",
                    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ fields: { status: { stringValue: "refunded" } } })
                });
            }
        }
    } catch (err) {
        console.error("Error refunding Tripo tokens:", err);
    }
}

// ============================================================================
// /create-checkout-session
// ============================================================================

async function handleCreateCheckout(request, env) {
    const uid = await requireAuth(request, env);
    const claims = await getAuthClaims(request, env);

    const { package: packageId } = await request.json();
    const pkg = TOKEN_PACKAGES[packageId];
    if (!pkg) return json({ error: "Nieznany pakiet" }, 400);

    const priceId = env[pkg.priceEnv];
    if (!priceId) return json({ error: `Brak skonfigurowanego ${pkg.priceEnv}` }, 500);

    const body = new URLSearchParams();
    body.append("mode", "payment");
    body.append("line_items[0][price]", priceId);
    body.append("line_items[0][quantity]", "1");
    body.append("success_url", env.CHECKOUT_SUCCESS_URL);
    body.append("cancel_url", env.CHECKOUT_CANCEL_URL);
    if (claims.email) body.append("customer_email", claims.email);
    body.append("metadata[uid]", uid);
    body.append("metadata[packageId]", packageId);
    body.append("payment_intent_data[metadata][uid]", uid);
    body.append("payment_intent_data[metadata][packageId]", packageId);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
        body
    });

    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || "Stripe error" }, res.status);
    return json({ url: data.url });
}

// ============================================================================
// /stripe-webhook
// ============================================================================

async function handleStripeWebhook(request, env) {
    const rawBody = await request.text();
    const sigHeader = request.headers.get("stripe-signature") || "";

    const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return json({ error: "Invalid webhook signature" }, 400);

    const event = JSON.parse(rawBody);

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = session.metadata?.uid;

        // Bezpieczne przypisanie na podstawie packageId ustawionego przez backend
        const packageId = session.metadata?.packageId;
        const pkg = packageId ? TOKEN_PACKAGES[packageId] : null;
        // Fallback dla starych trwających sesji
        const tokens = pkg ? pkg.tokens : parseInt(session.metadata?.tokens || "0", 10);

        if (uid && tokens > 0) {
            const accessToken = await getGoogleAccessToken(env);
            await ensureUserDoc(env, uid, accessToken);
            await addTokens(env, accessToken, uid, tokens);
            console.log(`Doładowano ${tokens} tokenów userowi ${uid} (Pakiet: ${packageId || 'custom'})`);
        }
    }

    return json({ received: true });
}

// ============================================================================
// CZATY
// ============================================================================

async function handleChatCreate(request, env) {
    const uid = await requireAuth(request, env);
    let body = {};
    try { body = await request.json(); } catch (e) { /* body opcjonalne */ }

    const accessToken = await getGoogleAccessToken(env);
    const now = new Date().toISOString();
    const title = String(body.title || "Nowy czat").slice(0, CHAT_TITLE_MAX_LEN);

    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                title: { stringValue: title },
                mode: { stringValue: String(body.mode || "chat") },
                createdAt: { timestampValue: now },
                updatedAt: { timestampValue: now }
            }
        })
    });

    if (!res.ok) return json({ error: "Failed to create chat: " + await res.text() }, 500);

    const doc = await res.json();
    const id = doc.name.split("/").pop();
    return json({ id, title, createdAt: now, updatedAt: now });
}

async function handleChatsList(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(
        `${firestoreBaseUrl(env)}/users/${uid}/chats?pageSize=${CHATS_PAGE_SIZE}&orderBy=${encodeURIComponent("updatedAt desc")}`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (!res.ok) return json({ error: "Failed to fetch chats: " + await res.text() }, 500);

    const data = await res.json();
    const documents = data.documents || [];

    const chats = documents.map(doc => ({
        id: doc.name.split("/").pop(),
        title: doc.fields?.title?.stringValue || "Czat",
        mode: doc.fields?.mode?.stringValue || "chat",
        updatedAt: doc.fields?.updatedAt?.timestampValue || null,
        createdAt: doc.fields?.createdAt?.timestampValue || null
    }));

    return json({ chats });
}

async function handleChatRename(request, env, chatId) {
    const uid = await requireAuth(request, env);
    const { title } = await request.json();
    if (!title) return json({ error: "Missing title" }, 400);

    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(
        `${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?updateMask.fieldPaths=title`,
        {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { title: { stringValue: String(title).slice(0, CHAT_TITLE_MAX_LEN) } } })
        }
    );

    if (!res.ok) return json({ error: "Failed to rename chat" }, 500);
    return json({ ok: true });
}

async function handleChatDelete(request, env, chatId) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` }
    });

    if (!res.ok) return json({ error: "Failed to delete chat" }, 500);
    return json({ ok: true });
}

async function handleChatMessageAdd(request, env, chatId) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    const type = ["text", "model3d", "generation", "chooser", "code"].includes(body.type) ? body.type : "generation";

    const fields = {
        type: { stringValue: type },
        prompt: { stringValue: String(body.prompt || "").slice(0, 300) },
        createdAt: { timestampValue: new Date().toISOString() }
    };

    if (type === "generation") {
        if (body.thumbnail && typeof body.thumbnail === "string" && body.thumbnail.startsWith("data:image/") && body.thumbnail.length <= MAX_THUMBNAIL_BYTES) {
            fields.thumbnail = { stringValue: body.thumbnail };
        }
        if (body.imageUrl && typeof body.imageUrl === "string") {
            fields.imageUrl = { stringValue: String(body.imageUrl || "").slice(0, 500) };
        }
        if (body.inputThumbnail && typeof body.inputThumbnail === "string" && body.inputThumbnail.startsWith("data:image/") && body.inputThumbnail.length <= MAX_THUMBNAIL_BYTES) {
            fields.inputThumbnail = { stringValue: body.inputThumbnail };
        }
        fields.mode = { stringValue: String(body.mode || "text2img") };
        fields.template = { stringValue: String(body.template || "square") };
        fields.category = { stringValue: String(body.category || "icon") };
    } else if (type === "text") {
        fields.reply = { stringValue: String(body.reply || "").slice(0, 200_000) };
        // A UI answer carries its HTML preview so reopening the chat shows
        // the interface again and not only the script that builds it.
        if (body.uiPreview) {
            fields.uiPreview = { stringValue: String(body.uiPreview).slice(0, 200_000) };
        }
    } else if (type === "code") {
        fields.reply = { stringValue: String(body.reply || "").slice(0, 200_000) };
        fields.language = { stringValue: String(body.language || "lua") };
        fields.model = { stringValue: String(body.model || "").slice(0, 40) };
        // A system is a tree, and reply only holds its flattened form. The
        // tree is kept beside it so reopening the chat gives the Explorer
        // back rather than a wall of headed code blocks.
        if (body.system) {
            fields.system = { stringValue: String(body.system).slice(0, 400_000) };
        }
    } else if (type === "chooser") {
        fields.category = { stringValue: String(body.category || "icon") };
        if (body.selectedOption) {
            fields.selectedOption = { stringValue: String(body.selectedOption) };
        }
    } else if (type === "model3d") {
        fields.modelUrl = { stringValue: String(body.modelUrl || "") };
        fields.thumbnailUrl = { stringValue: String(body.thumbnailUrl || "") };
        if (body.inputThumbnail && typeof body.inputThumbnail === "string" && body.inputThumbnail.startsWith("data:image/") && body.inputThumbnail.length <= MAX_THUMBNAIL_BYTES) {
            fields.inputThumbnail = { stringValue: body.inputThumbnail };
        }
        fields.taskType = { stringValue: String(body.taskType || "text-to-3d") };
    }

    const accessToken = await getGoogleAccessToken(env);
    const now = new Date().toISOString();

    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
    });

    if (!res.ok) return json({ error: "Failed to save message: " + await res.text() }, 500);

    const countRes = await fetch(
        `${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages?pageSize=2`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    const countData = await countRes.json();
    const isFirstMessage = (countData.documents || []).length <= 1;

    const patchFields = { updatedAt: { timestampValue: now } };
    let updateMask = "updateMask.fieldPaths=updatedAt";

    const titleSource = body.prompt || body.reply;
    if (isFirstMessage && titleSource) {
        patchFields.title = { stringValue: String(titleSource).slice(0, CHAT_TITLE_MAX_LEN) };
        updateMask += "&updateMask.fieldPaths=title";
    }

    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?${updateMask}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: patchFields })
    });

    return json({ ok: true });
}

async function handleChatMessagesList(request, env, chatId) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(
        `${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages` +
        `?pageSize=${MESSAGES_PAGE_SIZE}&orderBy=${encodeURIComponent("createdAt asc")}`,
        { headers: { "Authorization": `Bearer ${accessToken}` } }
    );

    if (!res.ok) return json({ error: "Failed to fetch messages: " + await res.text() }, 500);

    const data = await res.json();
    const documents = data.documents || [];

    const messages = documents.map(doc => {
        const f = doc.fields || {};
        return {
            id: doc.name.split("/").pop(),
            type: f.type?.stringValue || "generation",
            language: f.language?.stringValue || "lua",
            prompt: f.prompt?.stringValue || "",
            reply: f.reply?.stringValue || "",
            uiPreview: f.uiPreview?.stringValue || "",
            system: f.system?.stringValue || "",
            thumbnail: f.thumbnail?.stringValue || "",
            imageUrl: f.imageUrl?.stringValue || "",
            inputThumbnail: f.inputThumbnail?.stringValue || "",
            mode: f.mode?.stringValue || "text2img",
            template: f.template?.stringValue || "square",
            category: f.category?.stringValue || "icon",
            selectedOption: f.selectedOption?.stringValue || null,
            modelUrl: f.modelUrl?.stringValue || "",
            thumbnailUrl: f.thumbnailUrl?.stringValue || "",
            model: f.model?.stringValue || "",
            taskType: f.taskType?.stringValue || "",
            createdAt: f.createdAt?.timestampValue || null
        };
    });

    return json({ messages });
}

// ============================================================================
// STUDIO BRIDGE — the web page reaching into an open Studio session
// ----------------------------------------------------------------------------
// A Roblox plugin cannot be called; it can only call out. So everything here
// is a queue the plugin drains: the web enqueues work, the plugin polls for it,
// applies it, and reports back. That poll doubles as the heartbeat — if the
// plugin asked for work recently, Studio is open, and we know which place.
//
// Nothing new is needed on the apply side: a generated system is turned into
// the same write ops the agent already emits, so it runs through the editor
// path that already exists rather than a second one that would drift from it.
// ============================================================================

const STUDIO_ONLINE_MS = 25_000;      // a poll every ~3s; four missed = away
const STUDIO_JOB_TTL_MS = 30 * 60 * 1000;
const STUDIO_MAX_LOG = 200;

function studioDoc(env, uid, path) {
    return `${firestoreBaseUrl(env)}/users/${uid}/${path}`;
}

// Firestore keeps arrays as typed values; these two carry the log and the ops
// through without spreading them over a dozen fields.
function fsJson(value) {
    return { stringValue: JSON.stringify(value) };
}

function fsReadJson(field, fallback) {
    if (!field || typeof field.stringValue !== "string") return fallback;
    try { return JSON.parse(field.stringValue); } catch (e) { return fallback; }
}

// The tree speaks in slashes and the agent's ops speak in dots.
function studioParentPath(path) {
    const segs = String(path || "").split("/").filter(Boolean);
    return segs.slice(0, -1).join(".");
}

function studioLeafName(path) {
    const segs = String(path || "").split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
}

// A system tree becomes the write ops the editor already knows how to run.
// Non-scripts go first and in one call, because a script that references a
// remote should find it there when the place next runs.
function studioOpsFromTree(tree, overwrite) {
    const rows = Array.isArray(tree) ? tree : [];
    const ops = [];
    let n = 0;

    // What a node IS decides how it is made. Reading that off the presence of
    // a code field instead would turn a Folder that happens to carry a stray
    // string into a Script — the user asked for a Folder.
    const isScript = (r) => CODE_SCRIPT_CLASSES.includes(String(r.class));
    const deployable = rows.filter(r =>
        r && r.path && String(r.path).includes("/") && !ROBLOX_SERVICES.includes(String(r.path)));

    const instances = deployable.filter(r => !isScript(r)).map(r => ({
        className: String(r.class || "Folder"),
        parent: studioParentPath(r.path),
        name: studioLeafName(r.path)
    }));

    if (instances.length) {
        ops.push({ id: "op" + (++n), name: "create", args: { instances } });
    }

    for (const r of deployable) {
        if (!isScript(r)) continue;
        ops.push({
            id: "op" + (++n),
            name: "write_script",
            args: {
                parent: studioParentPath(r.path),
                name: studioLeafName(r.path),
                className: String(r.class),
                source: String(r.code || ""),
                // Off unless asked for. The editor refuses a name that is
                // already taken and says which, so a first deploy reports the
                // clash instead of quietly replacing something hand-written.
                overwrite: !!overwrite
            }
        });
    }

    return ops;
}

// ---------- the web side ----------

async function handleStudioDeploy(request, env, ctx) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    const kind = ["system", "script", "agent", "query", "ops"].includes(body.kind) ? body.kind : "system";

    let ops = [];
    let title = String(body.name || "").slice(0, 80);

    if (kind === "system") {
        ops = studioOpsFromTree(body.tree, body.overwrite === true);
        if (!ops.length) return json({ error: "There is nothing in this system to deploy." }, 400);
        title = title || "System";
    } else if (kind === "script") {
        const source = String(body.code || "").trim();
        if (!source) return json({ error: "There is no script to deploy." }, 400);
        const parent = String(body.parent || "ServerScriptService");
        ops = [{
            id: "op1",
            name: "write_script",
            args: {
                parent,
                name: title || "RoPeakScript",
                className: CODE_SCRIPT_CLASSES.includes(body.className) ? body.className : "Script",
                source,
                overwrite: body.overwrite === true
            }
        }];
        title = title || "Script";
    } else if (kind === "query") {
        // The web asking the place about itself. Nothing is changed, so this
        // needs no ops — just what to look at.
        const q = ["tree", "source"].includes(body.query) ? body.query : "tree";
        title = q === "source" ? String(body.path || "") : "Project";
        body.query = q;
    } else if (kind === "ops") {
        // Edits made in the project view: already in the editor's own
        // vocabulary, so they travel as they are.
        ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
        if (!ops.length) return json({ error: "There is nothing to apply." }, 400);
        ops = ops.map((o, i) => ({ id: "op" + (i + 1), name: String(o.name || ""), args: o.args || {} }));
        const unknown = ops.find(o => !AGENT2_WRITE_TOOLS.has(o.name));
        if (unknown) return json({ error: "Not an operation this can apply: " + unknown.name }, 400);
        const bad = ops.map(o => AGENT2_WRITE_VALIDATORS[o.name]?.(o.args)).find(Boolean);
        if (bad) return json({ error: bad }, 400);
        title = title || "Edit";
    } else {
        // Driving the agent from the web: the plugin runs its own turn loop,
        // so the job carries the message rather than a set of operations.
        const message = String(body.message || "").trim();
        if (!message) return json({ error: "Say what the agent should do." }, 400);
        title = title || message.slice(0, 60);
        ops = [];
        body.message = message;
    }

    const accessToken = await getGoogleAccessToken(env);
    const jobId = crypto.randomUUID();
    const now = Date.now();

    const fields = {
        kind: { stringValue: kind },
        title: { stringValue: title },
        status: { stringValue: "queued" },
        ops: fsJson(ops),
        log: fsJson([]),
        done: { integerValue: "0" },
        total: { integerValue: String(kind === "agent" ? 0 : ops.length) },
        createdAt: { integerValue: String(now) },
        updatedAt: { integerValue: String(now) }
    };
    if (kind === "agent") fields.message = { stringValue: String(body.message).slice(0, 4000) };
    if (kind === "query") {
        fields.query = { stringValue: String(body.query) };
        fields.path = { stringValue: String(body.path || "").slice(0, 400) };
    }
    if (body.placeId) fields.placeId = { stringValue: String(body.placeId) };

    // Every read of the tree and every save is a job, and a tree answer can
    // be most of a megabyte. Left alone they would accumulate for the life of
    // the account, so finished work older than the window goes when new work
    // arrives — which is rare enough to pay for and bounded by use.
    ctx_waitUntilSafe(ctx, studioPruneJobs(env, accessToken, uid));

    // A read that is still waiting when the next one is asked for is a read
    // nobody wants the answer to any more: the page has moved on. Clearing
    // them keeps a backlog of abandoned reads from making the one the user is
    // actually watching wait its turn behind them.
    if (kind === "query") ctx_waitUntilSafe(ctx, studioDropStaleQueries(env, accessToken, uid, jobId));

    const res = await fetch(`${studioDoc(env, uid, "studioJobs")}?documentId=${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
    });
    if (!res.ok) return json({ error: "Could not queue the deploy: " + await res.text() }, 500);

    return json({ jobId, kind, title, total: ops.length });
}

// Fire and forget: pruning must never be the reason a deploy is slow, and a
// failure to tidy is not a failure to deploy.
// A worker stops the moment it answers. Work left running without being
// handed to waitUntil is simply dropped, so this never once swept a bin or
// cleared a stale read - it only caught the errors of work that was not
// happening. It needs the context to keep a promise alive, and says so when
// it has not been given one.
function ctx_waitUntilSafe(ctx, promise) {
    const caught = promise.catch(e => console.error("studio background:", e));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(caught);
    return caught;
}

async function studioDropStaleQueries(env, accessToken, uid, keepId) {
    const docs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "studioJobs" }],
        where: {
            fieldFilter: {
                field: { fieldPath: "status" },
                op: "EQUAL",
                value: { stringValue: "queued" }
            }
        },
        limit: 20
    }, `users/${uid}`);

    const now = Date.now();
    for (const doc of docs) {
        if ((doc.fields?.kind?.stringValue || "") !== "query") continue;
        const id = doc.name.split("/").pop();
        // This runs alongside the write that queues the new read, so the new
        // read can already be in the answer. Cancelling the very job the page
        // is waiting for would be a far worse bug than the backlog.
        if (id === keepId) continue;
        await studioPatchJob(env, accessToken, uid, id, {
            status: { stringValue: "cancelled" },
            updatedAt: { integerValue: String(now) }
        }, ["status", "updatedAt"]);
    }
}

async function studioPruneJobs(env, accessToken, uid) {
    const cutoff = Date.now() - STUDIO_JOB_TTL_MS;
    const docs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "studioJobs" }],
        where: {
            fieldFilter: {
                field: { fieldPath: "createdAt" },
                op: "LESS_THAN",
                value: { integerValue: String(cutoff) }
            }
        },
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
        limit: 25
    }, `users/${uid}`);

    for (const doc of docs) {
        const status = doc.fields?.status?.stringValue || "";
        // A job still waiting for Studio is not litter, whatever its age —
        // studioPoll decides when an uncollected one has gone stale.
        if (status === "queued" || status === "running") continue;
        await fetch(`${firestoreBaseUrl(env)}/${doc.name.split("/documents/")[1]}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
    }
}

// ---------------------------------------------------------------------------
// TOOLS: WORK THE PAGE DOES FOR THE PLUGIN
//
// The plugin can read a place but has no business doing heavy arithmetic in
// Studio's own scheduler, and a server that did it would have to be paid for.
// The page is already open, already idle, and already the user's own machine,
// so the work goes there: the plugin leaves a job, the page picks it up,
// answers, and the plugin applies what came back.
//
// The waiting flag rides on the presence document the page already reads on
// every poll, so noticing there is work costs nothing at all.
// ---------------------------------------------------------------------------

// How often the page says it is still there, and how long that counts for.
// The second is comfortably more than the first, so an ordinary gap between
// polls never reads as the page having closed.
const PAGE_BEAT_MS = 20 * 1000;
const PAGE_ONLINE_MS = 70 * 1000;

const STUDIO_TOOL_TTL_MS = 10 * 60 * 1000;

// How long a job may sit at "running" before whoever took it is presumed
// gone. A page that takes a job and then reloads, crashes or is closed used
// to leave it running for ever: the flag saying there is work stayed up, and
// every page that saw it was refused the job and asked again on the next
// poll, for as long as the tab was open. Longer than the plugin's own wait,
// so this can only ever free a job nobody is still waiting on.
const STUDIO_TOOL_STALE_MS = 3 * 60 * 1000;
const STUDIO_TOOL_MAX_BYTES = 4 * 1024 * 1024;

function studioToolDoc(env, uid, id) {
    return studioDoc(env, uid, "studioTools/" + encodeURIComponent(id));
}

// The plugin hands over the work.
async function studioToolSubmit(env, uid, body) {
    const tool = String(body.tool || "");
    if (!tool) return json({ error: "Missing tool" }, 400);

    const input = JSON.stringify(body.input || null);
    if (input.length > STUDIO_TOOL_MAX_BYTES) {
        return json({ error: "That selection is too large to send in one piece." }, 413);
    }

    const accessToken = await getGoogleAccessToken(env);
    const id = crypto.randomUUID();
    const now = Date.now();

    const res = await fetch(`${studioDoc(env, uid, "studioTools")}?documentId=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            tool: { stringValue: tool },
            title: { stringValue: String(body.title || tool).slice(0, 80) },
            status: { stringValue: "waiting" },
            input: { stringValue: input },
            result: { stringValue: "" },
            error: { stringValue: "" },
            createdAt: { integerValue: String(now) },
            updatedAt: { integerValue: String(now) }
        } })
    });
    if (!res.ok) return json({ error: "Could not hand that over: " + await res.text() }, 500);

    // What the page reads anyway, so it finds out for free.
    await fetch(`${studioDoc(env, uid, "studio/presence")}` +
        `?updateMask.fieldPaths=toolPending&updateMask.fieldPaths=toolName`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            toolPending: { stringValue: id },
            toolName: { stringValue: tool }
        } })
    });

    return json({ jobId: id });
}

// The plugin asks how it went.
async function studioToolStatus(env, uid, body) {
    const id = String(body.jobId || "");
    if (!id) return json({ error: "Missing jobId" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const res = await fetch(studioToolDoc(env, uid, id), {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) return json({ status: "missing" });

    const f = (await res.json()).fields || {};
    const createdAt = parseInt(f.createdAt?.integerValue || "0", 10);
    let status = f.status?.stringValue || "waiting";

    // Nothing picked it up in time. Say so rather than leaving Studio to
    // wait on a page that was never open.
    if (status === "waiting" && Date.now() - createdAt > STUDIO_TOOL_TTL_MS) status = "expired";

    // A job nobody is going to finish must take its flag down with it, or
    // every open page goes on being told there is work here for ever.
    if (status === "expired") {
        await fetch(`${studioDoc(env, uid, "studio/presence")}?updateMask.fieldPaths=toolPending`, {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { toolPending: { stringValue: "" } } })
        }).catch(e => console.error("clear stale flag:", e));
    }

    return json({
        status,
        result: fsReadJson(f.result, null),
        error: f.error?.stringValue || ""
    });
}

// The page collects the work.
async function handleStudioToolWork(request, env, url) {
    const uid = await requireAuth(request, env);
    const id = url.searchParams.get("job");
    if (!id) return json({ error: "Missing job" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const res = await fetch(studioToolDoc(env, uid, id), {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) return json({ error: "No such job" }, 404);

    const f = (await res.json()).fields || {};
    const status = f.status?.stringValue || "";
    const updatedAt = parseInt(f.updatedAt?.integerValue || "0", 10);

    // A job still running long after anyone could be waiting on it belongs to
    // a page that is not there any more, so it goes back on the table rather
    // than being locked away until it expires.
    const abandoned = status === "running" && Date.now() - updatedAt > STUDIO_TOOL_STALE_MS;
    if (status !== "waiting" && !abandoned) {
        return json({ error: "Already taken", status: status || "unknown" }, 409);
    }

    await fetch(`${studioToolDoc(env, uid, id)}` +
        `?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            status: { stringValue: "running" },
            updatedAt: { integerValue: String(Date.now()) }
        } })
    });

    return json({
        id,
        tool: f.tool?.stringValue || "",
        title: f.title?.stringValue || "",
        input: fsReadJson(f.input, null)
    });
}

// The page hands the answer back.
async function handleStudioToolResult(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json();
    const id = String(body.jobId || "");
    if (!id) return json({ error: "Missing jobId" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const now = Date.now();

    // The page has found it is too old to do this one and is going to fetch
    // itself again. Put the job back the way it was rather than failing it:
    // the same page, a few seconds newer, is about to ask for it again.
    if (body.release) {
        const back = await fetch(`${studioToolDoc(env, uid, id)}` +
            `?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`, {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: {
                status: { stringValue: "waiting" },
                updatedAt: { integerValue: String(now) }
            } })
        });
        return json({ ok: back.ok, released: true });
    }

    const failed = !!body.error;

    const res = await fetch(`${studioToolDoc(env, uid, id)}` +
        `?updateMask.fieldPaths=status&updateMask.fieldPaths=result` +
        `&updateMask.fieldPaths=error&updateMask.fieldPaths=updatedAt`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            status: { stringValue: failed ? "failed" : "done" },
            result: fsJson(failed ? null : (body.result || null)),
            error: { stringValue: failed ? String(body.error).slice(0, 500) : "" },
            updatedAt: { integerValue: String(now) }
        } })
    });
    if (!res.ok) return json({ error: "Could not store that result." }, 500);

    // The flag is the page's only way of knowing there is work; leaving it set
    // would have the page pick the same job up again for ever.
    await fetch(`${studioDoc(env, uid, "studio/presence")}?updateMask.fieldPaths=toolPending`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { toolPending: { stringValue: "" } } })
    });

    return json({ ok: true });
}

// Presence and the state of recent work, for the header and the activity feed.
async function handleStudioStatus(request, env, url) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const wanted = url.searchParams.get("job");
    // The page is polled every few seconds for as long as it is open, so what
    // it asks for is what it pays for. A closed panel needs presence and
    // nothing else; a page watching one job needs that job and not the nine
    // documents a listing costs. Only the open activity list reads the rest.
    const wantList = url.searchParams.get("list") !== "0";

    const jobsUrl = wantList
        ? `${studioDoc(env, uid, "studioJobs")}?pageSize=5&orderBy=${encodeURIComponent("createdAt desc")}`
        : wanted
            ? `${studioDoc(env, uid, "studioJobs/" + encodeURIComponent(wanted))}`
            : null;

    const [presRes, jobsRes] = await Promise.all([
        fetch(studioDoc(env, uid, "studio/presence"), { headers: { "Authorization": `Bearer ${accessToken}` } }),
        jobsUrl ? fetch(jobsUrl, { headers: { "Authorization": `Bearer ${accessToken}` } }) : null
    ]);

    let presence = { online: false };
    if (presRes.ok) {
        const f = (await presRes.json()).fields || {};
        const lastSeen = parseInt(f.lastSeen?.integerValue || "0", 10);

        // Only this page calls this, so calling it is proof the page is open.
        // Studio has no other way of knowing, and knowing is the difference
        // between a button that explains why nothing happened and one that
        // says up front it cannot work yet. Written a few times a minute
        // rather than on every poll: it only has to beat the window that
        // counts it open.
        const pageSeen = parseInt(f.pageSeen?.integerValue || "0", 10);
        if (Date.now() - pageSeen > PAGE_BEAT_MS) {
            // Waited for, not left to chance. It is one small write at most
            // three times a minute, and Studio's whole idea of whether this
            // page exists rests on it landing.
            await fetch(`${studioDoc(env, uid, "studio/presence")}?updateMask.fieldPaths=pageSeen`, {
                method: "PATCH",
                headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ fields: { pageSeen: { integerValue: String(Date.now()) } } })
            }).catch(e => console.error("page beat:", e));
        }
        presence = {
            online: Date.now() - lastSeen < STUDIO_ONLINE_MS,
            lastSeen,
            placeId: f.placeId?.stringValue || "",
            placeName: f.placeName?.stringValue || "",
            studioUser: f.studioUser?.stringValue || "",
            version: f.version?.stringValue || "",
            agent: fsReadJson(f.agent, null),
            // Work the plugin has left for this page to do. It rides on the
            // document the page already reads, so finding out costs nothing.
            toolPending: f.toolPending?.stringValue || "",
            toolName: f.toolName?.stringValue || ""
        };
    }

    // One document comes back on its own; a listing comes back wrapped.
    let docs = [];
    if (jobsRes && jobsRes.ok) {
        const data = await jobsRes.json();
        docs = wantList ? (data.documents || []) : (data.name ? [data] : []);
    }

    const jobs = docs.map(doc => {
        const f = doc.fields || {};
        const id = doc.name.split("/").pop();
        const full = wanted && wanted === id;
        return {
            id,
            kind: f.kind?.stringValue || "system",
            title: f.title?.stringValue || "",
            status: f.status?.stringValue || "queued",
            done: parseInt(f.done?.integerValue || "0", 10),
            total: parseInt(f.total?.integerValue || "0", 10),
            error: f.error?.stringValue || "",
            createdAt: parseInt(f.createdAt?.integerValue || "0", 10),
            updatedAt: parseInt(f.updatedAt?.integerValue || "0", 10),
            // The whole log only for the job being watched; the rest just
            // need enough to draw a row.
            log: full ? fsReadJson(f.log, []) : fsReadJson(f.log, []).slice(-3),
            result: full ? fsReadJson(f.result, null) : undefined
        };
    });

    return json({ presence, jobs });
}

async function handleStudioCancel(request, env) {
    const uid = await requireAuth(request, env);
    const { jobId } = await request.json();
    if (!jobId) return json({ error: "Missing jobId" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const res = await fetch(
        `${studioDoc(env, uid, "studioJobs/" + encodeURIComponent(jobId))}` +
        `?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            status: { stringValue: "cancelled" },
            updatedAt: { integerValue: String(Date.now()) }
        } })
    });
    if (!res.ok) return json({ error: "Could not cancel that job." }, 500);
    return json({ ok: true });
}

// ---------- the plugin side ----------

// One call does both jobs: it says Studio is still here and which place is
// open, and it takes the next piece of work if there is one.
async function studioPoll(env, uid, body) {
    const accessToken = await getGoogleAccessToken(env);
    const now = Date.now();

    // Presence is a heartbeat, and a heartbeat every three seconds is a write
    // every three seconds — tens of thousands a day for a place left open,
    // which is most of a Firestore day's allowance spent on saying nothing
    // changed. The plugin decides when it is worth saying, and only has to
    // beat the window that counts it online. An older plugin says nothing
    // about it and keeps the old behaviour.
    let presenceDoc = null;
    // Every field it sets, named. Without a mask Firestore does not merge, it
    // replaces - so this quietly deleted everything written to this document
    // by anyone else, including the page's own mark and the flag that says
    // there is work waiting. The status flickered between open and closed
    // because the two writers were taking turns wiping each other.
    const beatMask = ["lastSeen", "placeId", "placeName", "studioUser", "version", "agent"]
        .map(f => `updateMask.fieldPaths=${f}`).join("&");

    if (body.heartbeat !== false) presenceDoc = await fetch(
        `${studioDoc(env, uid, "studio/presence")}?${beatMask}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
            lastSeen: { integerValue: String(now) },
            placeId: { stringValue: String(body.placeId || "") },
            placeName: { stringValue: String(body.placeName || "").slice(0, 120) },
            studioUser: { stringValue: String(body.studioUser || "").slice(0, 80) },
            version: { stringValue: String(body.version || "").slice(0, 20) },
            // What the agent in Studio is doing right now, whoever set it
            // going. It rides on the poll that already happens rather than
            // costing a request of its own.
            agent: fsJson(body.agent || null)
        } })
    });

    // Whether the page is open, for Studio to show. Asked for only while
    // something in Studio is showing it, and taken from the answer to the
    // write that just happened where there was one - a heartbeat returns the
    // whole document, so most of the time this costs nothing at all.
    let page = null;
    if (body.wantPage) {
        let fields = null;
        if (presenceDoc && presenceDoc.ok) {
            try { fields = (await presenceDoc.json()).fields || null; } catch (e) { fields = null; }
        }
        if (!fields) {
            try {
                const got = await fetch(studioDoc(env, uid, "studio/presence"),
                    { headers: { "Authorization": `Bearer ${accessToken}` } });
                if (got.ok) fields = (await got.json()).fields || null;
            } catch (e) { fields = null; }
        }
        const seen = parseInt(fields?.pageSeen?.integerValue || "0", 10);
        page = { online: now - seen < PAGE_ONLINE_MS, seen };
    }

    // Ask for queued jobs, not for the oldest dozen of every job ever made.
    // Listing by createdAt and filtering here looked fine until a place had
    // more than a page of finished jobs behind it: the window then held
    // nothing but history and the plugin stopped seeing new work at all.
    //
    // The filter stands alone on purpose. Ordering by createdAt as well reads
    // naturally but spans two fields, which Firestore will not serve without a
    // composite index; without one every poll throws and no job is ever handed
    // over at all. A handful of waiting jobs costs nothing to order here.
    let docs = null;
    try {
        docs = await firestoreRunQuery(env, accessToken, {
            from: [{ collectionId: "studioJobs" }],
            where: {
                fieldFilter: {
                    field: { fieldPath: "status" },
                    op: "EQUAL",
                    value: { stringValue: "queued" }
                }
            },
            limit: 20
        }, `users/${uid}`);
    } catch (e) {
        console.error("studio poll query:", e);
    }

    // Should the query be unavailable for any reason, read the newest jobs
    // instead. Newest, because anything still waiting was asked for moments
    // ago: a window of old jobs is exactly what hid the queue before.
    if (!docs) {
        try {
            const listRes = await fetch(
                `${studioDoc(env, uid, "studioJobs")}?pageSize=20&orderBy=${encodeURIComponent("createdAt desc")}`,
                { headers: { "Authorization": `Bearer ${accessToken}` } }
            );
            const listData = await listRes.json();
            docs = (listData.documents || [])
                .filter(d => (d.fields?.status?.stringValue || "") === "queued");
        } catch (e) {
            console.error("studio poll list:", e);
            return json({ job: null, page });
        }
    }

    // Oldest first, so the queue is served in the order the page asked.
    docs.sort((a, b) =>
        parseInt(a.fields?.createdAt?.integerValue || "0", 10) -
        parseInt(b.fields?.createdAt?.integerValue || "0", 10));

    for (const doc of docs) {
        const f = doc.fields || {};

        const createdAt = parseInt(f.createdAt?.integerValue || "0", 10);
        const id = doc.name.split("/").pop();

        // A job nobody collected within the window was queued while Studio was
        // shut; handing it over now would apply something the user has since
        // forgotten asking for.
        if (now - createdAt > STUDIO_JOB_TTL_MS) {
            await studioPatchJob(env, accessToken, uid, id, {
                status: { stringValue: "expired" },
                updatedAt: { integerValue: String(now) }
            }, ["status", "updatedAt"]);
            continue;
        }

        // A job aimed at one place waits for that place to be the open one.
        const wantPlace = f.placeId?.stringValue || "";
        if (wantPlace && String(body.placeId || "") !== wantPlace) continue;

        await studioPatchJob(env, accessToken, uid, id, {
            status: { stringValue: "running" },
            updatedAt: { integerValue: String(now) }
        }, ["status", "updatedAt"]);

        return json({ page, job: {
            id,
            kind: f.kind?.stringValue || "system",
            title: f.title?.stringValue || "",
            message: f.message?.stringValue || "",
            query: f.query?.stringValue || "",
            path: f.path?.stringValue || "",
            ops: fsReadJson(f.ops, [])
        } });
    }

    return json({ job: null, page });
}

async function studioPatchJob(env, accessToken, uid, jobId, fields, maskPaths) {
    const mask = maskPaths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join("&");
    return await fetch(`${studioDoc(env, uid, "studioJobs/" + encodeURIComponent(jobId))}?${mask}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields })
    });
}

// Progress, log lines and the verdict, on their way back to the page.
async function studioReport(env, uid, body) {
    const jobId = String(body.jobId || "");
    if (!jobId) return json({ error: "Missing jobId" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const ref = studioDoc(env, uid, "studioJobs/" + encodeURIComponent(jobId));
    const cur = await fetch(ref, { headers: { "Authorization": `Bearer ${accessToken}` } });
    if (!cur.ok) return json({ error: "No such job" }, 404);

    const f = (await cur.json()).fields || {};
    const log = fsReadJson(f.log, []);

    for (const line of (Array.isArray(body.log) ? body.log : []).slice(0, 50)) {
        log.push({
            t: Date.now(),
            kind: String(line && line.kind || "info").slice(0, 16),
            text: String(line && line.text || "").slice(0, 600)
        });
    }
    // A run that goes long should not grow without bound; the recent end is
    // the part anyone reads.
    const trimmed = log.slice(-STUDIO_MAX_LOG);

    const status = ["running", "done", "failed", "cancelled"].includes(body.status)
        ? body.status : (f.status?.stringValue || "running");

    const fields = {
        status: { stringValue: status },
        log: fsJson(trimmed),
        done: { integerValue: String(Math.max(0, parseInt(body.done, 10) || 0)) },
        updatedAt: { integerValue: String(Date.now()) }
    };
    const paths = ["status", "log", "done", "updatedAt"];
    if (body.total != null) {
        fields.total = { integerValue: String(Math.max(0, parseInt(body.total, 10) || 0)) };
        paths.push("total");
    }
    if (body.error) {
        fields.error = { stringValue: String(body.error).slice(0, 600) };
        paths.push("error");
    }
    // What a query found. Capped hard: a place with a thousand scripts must
    // not turn one answer into a document nobody can load.
    if (body.result !== undefined) {
        fields.result = { stringValue: JSON.stringify(body.result).slice(0, 600_000) };
        paths.push("result");
    }

    await studioPatchJob(env, accessToken, uid, jobId, fields, paths);
    // The plugin stops work the moment the page says stop.
    return json({ ok: true, cancelled: status === "cancelled" || (f.status?.stringValue === "cancelled") });
}

// ============================================================================
// GAME WIDGETS (Live game stats z Roblox API)
// ============================================================================

function extractRobloxPlaceId(input) {
    const trimmed = String(input || "").trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/roblox\.com\/(?:[a-z-]+\/)?games\/(\d+)/i);
    return match ? match[1] : null;
}

function extractRobloxUserRef(input) {
    const trimmed = String(input || "").trim();
    if (/^\d+$/.test(trimmed)) return { byId: trimmed };
    const urlMatch = trimmed.match(/roblox\.com\/users\/(\d+)/i);
    if (urlMatch) return { byId: urlMatch[1] };
    const cleaned = trimmed.replace(/^@/, "");
    if (/^[A-Za-z0-9_]{3,20}$/.test(cleaned)) return { byUsername: cleaned };
    return null;
}

async function resolveUniverseId(placeId) {
    const res = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    if (!res.ok) throw new Error("Nie znaleziono gry o podanym ID/linku.");
    const data = await res.json();
    if (!data.universeId) throw new Error("Failed to recognize the game.");
    return String(data.universeId);
}

async function resolveRobloxUserId(ref) {
    if (ref.byId) return ref.byId;
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [ref.byUsername], excludeBannedUsers: false })
    });
    const data = await res.json();
    const found = data.data?.[0];
    if (!found) throw new Error("User with the given name not found.");
    return String(found.id);
}

async function fetchRobloxGameStats(universeId) {
    const [gameRes, voteRes, iconRes] = await Promise.all([
        fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
        fetch(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`),
        fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=150x150&format=Png&isCircular=false`)
    ]);

    const gameData = gameRes.ok ? await gameRes.json() : { data: [] };
    const voteData = voteRes.ok ? await voteRes.json() : { data: [] };
    const iconData = iconRes.ok ? await iconRes.json() : { data: [] };

    const game = gameData.data?.[0];
    if (!game) throw new Error("Game was not found.");
    const votes = voteData.data?.[0] || {};
    const icon = iconData.data?.[0];

    return {
        universeId: String(universeId),
        name: game.name || "Gra Roblox",
        playing: game.playing ?? 0,
        visits: game.visits ?? 0,
        favoritedCount: game.favoritedCount ?? 0,
        upVotes: votes.upVotes ?? 0,
        downVotes: votes.downVotes ?? 0,
        iconUrl: icon?.imageUrl || null,
        updatedAt: new Date().toISOString()
    };
}

async function fetchRobloxUserStats(userId) {
    const [userRes, avatarRes, followersRes, followingRes, friendsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`),
        fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=true`),
        fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
        fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
        fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`)
    ]);

    if (!userRes.ok) throw new Error("Roblox user not found.");
    const user = await userRes.json();
    const avatarData = avatarRes.ok ? await avatarRes.json() : { data: [] };
    const followers = followersRes.ok ? await followersRes.json() : { count: 0 };
    const following = followingRes.ok ? await followingRes.json() : { count: 0 };
    const friends = friendsRes.ok ? await friendsRes.json() : { count: 0 };

    return {
        userId: String(userId),
        username: user.name || "?",
        displayName: user.displayName || user.name || "?",
        avatarUrl: avatarData.data?.[0]?.imageUrl || null,
        followers: followers.count ?? 0,
        following: following.count ?? 0,
        friends: friends.count ?? 0,
        updatedAt: new Date().toISOString()
    };
}

async function handleGameWidgetAdd(request, env) {
    const uid = await requireAuth(request, env);
    const { input, type } = await request.json();
    const widgetType = type === "user" ? "user" : "game";

    let statsFields, stats;

    if (widgetType === "user") {
        const ref = extractRobloxUserRef(input);
        if (!ref) return json({ error: "Roblox username or ID not recognized." }, 400);
        try {
            const userId = await resolveRobloxUserId(ref);
            stats = await fetchRobloxUserStats(userId);
        } catch (e) { return json({ error: e.message }, 400); }
        statsFields = {
            widgetType: { stringValue: "user" },
            userId: { stringValue: stats.userId },
            addedAt: { timestampValue: new Date().toISOString() }
        };
    } else {
        const placeId = extractRobloxPlaceId(input);
        if (!placeId) return json({ error: "Nie rozpoznano linku ani ID gry Roblox." }, 400);
        try {
            const universeId = await resolveUniverseId(placeId);
            stats = await fetchRobloxGameStats(universeId);
        } catch (e) { return json({ error: e.message }, 400); }
        statsFields = {
            widgetType: { stringValue: "game" },
            universeId: { stringValue: stats.universeId },
            placeId: { stringValue: String(placeId) },
            addedAt: { timestampValue: new Date().toISOString() }
        };
    }

    const accessToken = await getGoogleAccessToken(env);
    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/gameWidgets`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: statsFields })
    });
    if (!res.ok) return json({ error: "Failed to save widget: " + await res.text() }, 500);

    const doc = await res.json();
    return json({ id: doc.name.split("/").pop(), type: widgetType, ...stats });
}

async function handleGameWidgetsList(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/gameWidgets?pageSize=30`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) return json({ error: "Failed to fetch widgets: " + await res.text() }, 500);

    const data = await res.json();
    const documents = data.documents || [];

    const widgets = await Promise.all(documents.map(async doc => {
        const id = doc.name.split("/").pop();
        const wType = doc.fields?.widgetType?.stringValue || "game";
        try {
            if (wType === "user") {
                const userId = doc.fields?.userId?.stringValue || "";
                return { id, type: "user", ...(await fetchRobloxUserStats(userId)), error: null };
            } else {
                const universeId = doc.fields?.universeId?.stringValue || "";
                return { id, type: "game", ...(await fetchRobloxGameStats(universeId)), error: null };
            }
        } catch (e) {
            return { id, type: wType, error: e.message };
        }
    }));

    return json({ widgets });
}

async function handleGameWidgetDelete(request, env, widgetId) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/gameWidgets/${widgetId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) return json({ error: "Failed to delete widget" }, 500);
    return json({ ok: true });
}

async function handleGameWidgetStatsRefresh(request, env, url) {
    await requireAuth(request, env);
    const type = url.searchParams.get("type") === "user" ? "user" : "game";
    try {
        if (type === "user") {
            const userId = url.searchParams.get("userId");
            if (!userId) return json({ error: "Brak userId" }, 400);
            return json({ type: "user", ...(await fetchRobloxUserStats(userId)) });
        } else {
            const universeId = url.searchParams.get("universeId");
            if (!universeId) return json({ error: "Brak universeId" }, 400);
            return json({ type: "game", ...(await fetchRobloxGameStats(universeId)) });
        }
    } catch (e) { return json({ error: e.message }, 400); }
}
// ============================================================================
// COMMUNITY STORE
// ============================================================================

// Helper: Firestore structured query (runQuery)
async function firestoreRunQuery(env, accessToken, query, parentPath) {
    const res = await fetch(
        // A subcollection is queried from its parent document, not from the
        // database root, so callers that live under users/{uid} say so.
        `${firestoreBaseUrl(env)}${parentPath ? "/" + parentPath : ""}:runQuery`,
        {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ structuredQuery: query })
        }
    );
    if (!res.ok) throw new Error("Firestore query failed: " + await res.text());
    const results = await res.json();
    // runQuery returns [{document: {...}}, ...] or [{readTime: "..."}] if empty
    return (results || []).filter(r => r.document).map(r => r.document);
}

// Helper: extract Firestore doc fields to plain object
function extractStoreAssetFields(doc) {
    const f = doc.fields || {};
    const id = doc.name.split("/").pop();
    return {
        id,
        creatorId: f.creatorId?.stringValue || "",
        creatorName: f.creatorName?.stringValue || "",
        title: f.title?.stringValue || "",
        description: f.description?.stringValue || "",
        previewUrl: f.previewUrl?.stringValue || "",
        modelUrl: f.modelUrl?.stringValue || "",
        generationCostTokens: parseInt(f.generationCostTokens?.integerValue || "0", 10),
        priceTokens: parseInt(f.priceTokens?.integerValue || "0", 10),
        category: f.category?.stringValue || "other",
        tags: f.tags?.stringValue || "",
        salesCount: parseInt(f.salesCount?.integerValue || "0", 10),
        likesCount: parseInt(f.likesCount?.integerValue || "0", 10),
        shareSell: !!f.shareSell?.booleanValue,
        aiGenerated: f.aiGenerated?.booleanValue !== false,
        status: f.status?.stringValue || "pending",
        createdAt: f.createdAt?.timestampValue || null,
        updatedAt: f.updatedAt?.timestampValue || null
    };
}

// POST /store/publish — publish a generated model to Community Store
async function handleStorePublish(request, env) {
    const uid = await requireAuth(request, env);
    const claims = await getAuthClaims(request, env);
    const { taskId, title, description, category, modelUrl, thumbnailUrl } = await request.json();

    if (!taskId) return json({ error: "Missing taskId" }, 400);
    if (!modelUrl) return json({ error: "Missing modelUrl" }, 400);
    if (!title || !String(title).trim()) return json({ error: "Missing title" }, 400);

    const cat = STORE_CATEGORIES.includes(category) ? category : "other";
    const accessToken = await getGoogleAccessToken(env);

    // Verify tripoTask belongs to this user
    const taskRes = await fetch(`${firestoreBaseUrl(env)}/tripoTasks/${encodeURIComponent(taskId)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!taskRes.ok) return json({ error: "Task not found or not eligible for publishing" }, 404);
    const taskDoc = await taskRes.json();
    const taskFields = taskDoc.fields || {};

    if (taskFields.uid?.stringValue !== uid) return json({ error: "Unauthorized" }, 403);
    if (!taskFields.shareSell?.booleanValue) return json({ error: "This generation was not marked for Share & Sell" }, 400);
    if (taskFields.status?.stringValue === "published") return json({ error: "Already published" }, 409);

    const actualCost = parseInt(taskFields.cost?.integerValue || "0", 10);
    const creatorName = claims.name || claims.email?.split("@")[0] || "Creator";
    const now = new Date().toISOString();

    // Create storeAssets document
    const assetRes = await fetch(`${firestoreBaseUrl(env)}/storeAssets`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                creatorId: { stringValue: uid },
                creatorName: { stringValue: String(creatorName).slice(0, 60) },
                title: { stringValue: String(title).slice(0, 120) },
                description: { stringValue: String(description || "").slice(0, 1000) },
                previewUrl: { stringValue: String(thumbnailUrl || "").slice(0, 2000) },
                modelUrl: { stringValue: String(modelUrl).slice(0, 2000) },
                generationCostTokens: { integerValue: String(actualCost) },
                priceTokens: { integerValue: String(actualCost) },
                category: { stringValue: cat },
                tags: { stringValue: "" },
                salesCount: { integerValue: "0" },
                likesCount: { integerValue: "0" },
                shareSell: { booleanValue: true },
                aiGenerated: { booleanValue: true },
                status: { stringValue: "published" },
                createdAt: { timestampValue: now },
                updatedAt: { timestampValue: now }
            }
        })
    });

    if (!assetRes.ok) return json({ error: "Failed to publish asset: " + await assetRes.text() }, 500);
    const assetDoc = await assetRes.json();
    const assetId = assetDoc.name.split("/").pop();

    // Mark tripoTask as published
    await fetch(
        `${firestoreBaseUrl(env)}/tripoTasks/${encodeURIComponent(taskId)}?updateMask.fieldPaths=status&updateMask.fieldPaths=assetId`,
        {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                fields: {
                    status: { stringValue: "published" },
                    assetId: { stringValue: assetId }
                }
            })
        }
    );

    // Creator also owns their own asset
    await fetch(`${firestoreBaseUrl(env)}/storeOwnership`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                assetId: { stringValue: assetId },
                userId: { stringValue: uid },
                type: { stringValue: "creator" },
                createdAt: { timestampValue: now }
            }
        })
    });

    return json({ id: assetId, priceTokens: actualCost });
}

// GET /store/assets — list published assets with filters, sorting, pagination
async function handleStoreAssetsList(request, env, url) {
    // Auth optional for browsing
    let uid = null;
    try { uid = await requireAuth(request, env); } catch (e) { /* browsing without auth */ }

    const accessToken = await getGoogleAccessToken(env);
    const category = url.searchParams.get("category");
    const search = url.searchParams.get("search") || "";
    const sort = url.searchParams.get("sort") || "newest";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = Math.min(parseInt(url.searchParams.get("pageSize") || String(STORE_PAGE_SIZE), 10), 50);

    const query = {
        from: [{ collectionId: "storeAssets" }],
        where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "published" } } },
        limit: 1000 // Get up to 1000 published items and sort/filter in JS to avoid Firestore composite index requirements
    };

    try {
        const docs = await firestoreRunQuery(env, accessToken, query);
        let assets = docs.map(extractStoreAssetFields);

        // Client-side category & search filter
        if (category && STORE_CATEGORIES.includes(category)) {
            assets = assets.filter(a => a.category === category);
        }

        if (search) {
            const q = search.toLowerCase();
            assets = assets.filter(a =>
                a.title.toLowerCase().includes(q) ||
                a.description.toLowerCase().includes(q) ||
                a.creatorName.toLowerCase().includes(q) ||
                a.category.toLowerCase().includes(q)
            );
        }

        // Client-side sorting
        assets.sort((a, b) => {
            if (sort === "best_sellers") return b.salesCount - a.salesCount;
            if (sort === "most_liked") return b.likesCount - a.likesCount;
            if (sort === "price_low") return a.priceTokens - b.priceTokens;
            if (sort === "price_high") return b.priceTokens - a.priceTokens;
            // Default newest
            return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });

        const totalFiltered = assets.length;
        const startIndex = (page - 1) * pageSize;
        assets = assets.slice(startIndex, startIndex + pageSize);

        // Check ownership for authenticated user
        let ownedIds = new Set();
        if (uid && assets.length > 0) {
            try {
                const ownerDocs = await firestoreRunQuery(env, accessToken, {
                    from: [{ collectionId: "storeOwnership" }],
                    where: { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: uid } } },
                    select: { fields: [{ fieldPath: "assetId" }] },
                    limit: 200
                });
                for (const od of ownerDocs) {
                    const aid = od.fields?.assetId?.stringValue;
                    if (aid) ownedIds.add(aid);
                }
            } catch (e) { /* ignore */ }
        }

        assets = assets.map(a => ({ ...a, owned: ownedIds.has(a.id) }));

        return json({ assets, page, pageSize, hasMore: (startIndex + pageSize) < totalFiltered });
    } catch (e) {
        return json({ error: "Failed to load store: " + e.message }, 500);
    }
}

// GET /store/assets/{id} — asset detail
async function handleStoreAssetDetail(request, env, assetId) {
    let uid = null;
    try { uid = await requireAuth(request, env); } catch (e) { }

    const accessToken = await getGoogleAccessToken(env);

    const res = await fetch(`${firestoreBaseUrl(env)}/storeAssets/${encodeURIComponent(assetId)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) return json({ error: "Asset not found" }, 404);
    const doc = await res.json();
    const asset = extractStoreAssetFields(doc);

    if (asset.status !== "published") return json({ error: "Asset not available" }, 404);

    // Check ownership
    let owned = false;
    let liked = false;
    if (uid) {
        try {
            const ownerDocs = await firestoreRunQuery(env, accessToken, {
                from: [{ collectionId: "storeOwnership" }],
                where: { fieldFilter: { field: { fieldPath: "assetId" }, op: "EQUAL", value: { stringValue: assetId } } },
                limit: 1000
            });
            owned = ownerDocs.some(d => d.fields?.userId?.stringValue === uid);
        } catch (e) { }

        try {
            const likeDocs = await firestoreRunQuery(env, accessToken, {
                from: [{ collectionId: "storeLikes" }],
                where: { fieldFilter: { field: { fieldPath: "assetId" }, op: "EQUAL", value: { stringValue: assetId } } },
                limit: 1000
            });
            liked = likeDocs.some(d => d.fields?.userId?.stringValue === uid);
        } catch (e) { }
    }

    return json({ ...asset, owned, liked });
}

// POST /store/assets/{id}/buy — atomic token transfer with 80/20 split
async function handleStoreAssetBuy(request, env, assetId) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    // Load asset from Firestore (server-side, never trust frontend price)
    const assetRes = await fetch(`${firestoreBaseUrl(env)}/storeAssets/${encodeURIComponent(assetId)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!assetRes.ok) return json({ error: "Asset not found" }, 404);
    const assetDoc = await assetRes.json();
    const f = assetDoc.fields || {};

    const status = f.status?.stringValue;
    if (status !== "published") return json({ error: "Asset is not available for purchase" }, 400);

    const priceTokens = parseInt(f.priceTokens?.integerValue || "0", 10);
    const creatorId = f.creatorId?.stringValue;
    if (!creatorId) return json({ error: "Invalid asset" }, 400);
    if (creatorId === uid) return json({ error: "You cannot buy your own asset" }, 400);
    if (priceTokens <= 0) return json({ error: "Invalid price" }, 400);

    // Check if already owned
    try {
        const ownerDocs = await firestoreRunQuery(env, accessToken, {
            from: [{ collectionId: "storeOwnership" }],
            where: { fieldFilter: { field: { fieldPath: "assetId" }, op: "EQUAL", value: { stringValue: assetId } } },
            limit: 1000
        });
        if (ownerDocs.some(d => d.fields?.userId?.stringValue === uid)) {
            return json({ error: "You already own this asset" }, 409);
        }
    } catch (e) { }

    // Calculate revenue split
    const creatorTokens = Math.floor(priceTokens * CREATOR_REVENUE_PERCENT / 100);
    const platformTokens = priceTokens - creatorTokens;

    // Atomic transaction: charge buyer, credit creator, credit platform
    const txRes = await fetch(`${firestoreBaseUrl(env)}:beginTransaction`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({})
    });
    const { transaction } = await txRes.json();

    const buyerDocPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const balRes = await fetch(`${firestoreBaseUrl(env)}:batchGet`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            documents: [buyerDocPath],
            transaction
        })
    }).then(r => r.json());

    const found = Array.isArray(balRes) ? balRes.find(r => r.found) : null;
    const buyerBalance = found ? parseInt(found.found.fields?.tokens?.integerValue || "0", 10) : 0;

    if (buyerBalance < priceTokens) {
        // Rollback transaction
        await fetch(`${firestoreBaseUrl(env)}:rollback`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ transaction })
        });
        return json({ error: "Insufficient tokens" }, 402);
    }

    const writes = [
        // Subtract tokens from buyer
        {
            transform: {
                document: buyerDocPath,
                fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(-priceTokens) } }]
            }
        },
        // Add creator's share
        {
            transform: {
                document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${creatorId}`,
                fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(creatorTokens) } }]
            }
        }
    ];

    // Credit platform system account (for audit trail)
    if (platformTokens > 0) {
        writes.push({
            transform: {
                document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${PLATFORM_SYSTEM_UID}`,
                fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(platformTokens) } }]
            }
        });
    }

    const commitRes = await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ writes, transaction })
    });

    if (!commitRes.ok) {
        return json({ error: "Purchase failed. Please try again." }, 500);
    }

    const now = new Date().toISOString();

    // Create ownership record
    await fetch(`${firestoreBaseUrl(env)}/storeOwnership`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                assetId: { stringValue: assetId },
                userId: { stringValue: uid },
                type: { stringValue: "purchase" },
                pricePaid: { integerValue: String(priceTokens) },
                createdAt: { timestampValue: now }
            }
        })
    });

    // Create transaction record
    await fetch(`${firestoreBaseUrl(env)}/storeTransactions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                assetId: { stringValue: assetId },
                buyerId: { stringValue: uid },
                creatorId: { stringValue: creatorId },
                priceTokens: { integerValue: String(priceTokens) },
                creatorTokens: { integerValue: String(creatorTokens) },
                platformTokens: { integerValue: String(platformTokens) },
                status: { stringValue: "completed" },
                createdAt: { timestampValue: now }
            }
        })
    });

    // Use transform for atomic salesCount increment
    // Use transform for atomic salesCount increment
    await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{
                transform: {
                    document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/storeAssets/${assetId}`,
                    fieldTransforms: [{ fieldPath: "salesCount", increment: { integerValue: "1" } }]
                }
            }]
        })
    });

    return json({
        ok: true,
        priceTokens,
        creatorTokens,
        platformTokens,
        newBalance: buyerBalance - priceTokens
    });
}

// POST /store/assets/{id}/like — toggle like
async function handleStoreAssetLike(request, env, assetId) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    // Check if already liked
    const likeDocs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeLikes" }],
        where: { fieldFilter: { field: { fieldPath: "assetId" }, op: "EQUAL", value: { stringValue: assetId } } },
        limit: 1000
    });

    const existingLike = likeDocs.find(d => d.fields?.userId?.stringValue === uid);

    const assetDocPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/storeAssets/${assetId}`;

    if (existingLike) {
        // Unlike: delete the like doc and decrement count
        const likeDocName = existingLike.name;
        await fetch(`https://firestore.googleapis.com/v1/${likeDocName}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${accessToken}` }
        });
        await fetch(`${firestoreBaseUrl(env)}:commit`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                writes: [{ transform: { document: assetDocPath, fieldTransforms: [{ fieldPath: "likesCount", increment: { integerValue: "-1" } }] } }]
            })
        });
        return json({ liked: false });
    }

    // Like: create like doc and increment count
    await fetch(`${firestoreBaseUrl(env)}/storeLikes`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                assetId: { stringValue: assetId },
                userId: { stringValue: uid },
                createdAt: { timestampValue: new Date().toISOString() }
            }
        })
    });
    await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{ transform: { document: assetDocPath, fieldTransforms: [{ fieldPath: "likesCount", increment: { integerValue: "1" } }] } }]
        })
    });

    return json({ liked: true });
}

// GET /store/my-library — purchased assets
async function handleStoreMyLibrary(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const ownerDocs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeOwnership" }],
        where: { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: uid } } },
        limit: 1000
    });

    const assets = [];
    for (const od of ownerDocs) {
        const assetId = od.fields?.assetId?.stringValue;
        const purchaseType = od.fields?.type?.stringValue || "purchase";
        const purchaseDate = od.fields?.createdAt?.timestampValue || null;
        const pricePaid = parseInt(od.fields?.pricePaid?.integerValue || "0", 10);

        if (!assetId) continue;
        try {
            const aRes = await fetch(`${firestoreBaseUrl(env)}/storeAssets/${encodeURIComponent(assetId)}`, {
                headers: { "Authorization": `Bearer ${accessToken}` }
            });
            if (!aRes.ok) continue;
            const aDoc = await aRes.json();
            const a = extractStoreAssetFields(aDoc);
            assets.push({ ...a, purchaseType, purchaseDate, pricePaid, owned: true });
        } catch (e) { continue; }
    }
    // Sort by purchase date locally
    assets.sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));

    return json({ assets });
}

// GET /store/my-assets — creator's published assets
async function handleStoreMyAssets(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const docs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeAssets" }],
        where: { fieldFilter: { field: { fieldPath: "creatorId" }, op: "EQUAL", value: { stringValue: uid } } },
        limit: 1000
    });

    let assets = docs.map(extractStoreAssetFields);
    assets.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return json({ assets });
}

// GET /store/dashboard — creator dashboard stats
async function handleStoreDashboard(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    // Get creator's assets
    const assetDocs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeAssets" }],
        where: { fieldFilter: { field: { fieldPath: "creatorId" }, op: "EQUAL", value: { stringValue: uid } } },
        limit: 200
    });

    const assets = assetDocs.map(extractStoreAssetFields);
    const publishedCount = assets.filter(a => a.status === "published").length;
    const pendingCount = assets.filter(a => a.status === "pending").length;

    // Get transactions where user is creator
    const txDocs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeTransactions" }],
        where: { fieldFilter: { field: { fieldPath: "creatorId" }, op: "EQUAL", value: { stringValue: uid } } },
        limit: 500
    });

    let totalEarned = 0;
    let totalSales = 0;
    const perAssetEarnings = {};

    for (const td of txDocs) {
        const tf = td.fields || {};
        const ct = parseInt(tf.creatorTokens?.integerValue || "0", 10);
        const aid = tf.assetId?.stringValue || "";
        totalEarned += ct;
        totalSales += 1;
        perAssetEarnings[aid] = (perAssetEarnings[aid] || 0) + ct;
    }

    const assetsWithEarnings = assets.map(a => ({
        ...a,
        tokensEarned: perAssetEarnings[a.id] || 0
    }));

    return json({
        totalEarned,
        totalSales,
        publishedCount,
        pendingCount,
        assets: assetsWithEarnings
    });
}

// GET /store/creator/{uid} — public creator profile
async function handleStoreCreatorProfile(request, env, creatorUid) {
    // Auth optional
    try { await requireAuth(request, env); } catch (e) { }

    const accessToken = await getGoogleAccessToken(env);

    // Get creator's published assets
    const docs = await firestoreRunQuery(env, accessToken, {
        from: [{ collectionId: "storeAssets" }],
        where: { fieldFilter: { field: { fieldPath: "creatorId" }, op: "EQUAL", value: { stringValue: creatorUid } } },
        limit: 1000
    });

    let assets = docs.map(extractStoreAssetFields).filter(a => a.status === "published");
    assets.sort((a, b) => b.salesCount - a.salesCount);
    assets = assets.slice(0, 50);

    const creatorName = assets.length > 0 ? assets[0].creatorName : "Creator";
    const totalSales = assets.reduce((s, a) => s + a.salesCount, 0);

    return json({
        uid: creatorUid,
        name: creatorName,
        publishedCount: assets.length,
        totalSales,
        assets
    });
}

// ============================================================================
// AUTH
// ============================================================================

async function requireAuth(request, env) {
    const claims = await getAuthClaims(request, env);
    return claims.sub;
}

async function getAuthClaims(request, env) {
    const authHeader = request.headers.get("Authorization") || "";
    let token = "";

    const match = authHeader.match(/^Bearer (.+)$/);
    if (match) {
        token = match[1];
    } else {
        const url = new URL(request.url);
        token = url.searchParams.get("_t");
    }

    if (!token) throw new Error("You must be logged in.");

    try {
        return await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
    } catch (e) {
        throw new Error("Invalid or expired login session.");
    }
}

function base64UrlToUint8Array(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

function base64UrlDecodeJSON(b64url) {
    const bytes = base64UrlToUint8Array(b64url);
    return JSON.parse(new TextDecoder().decode(bytes));
}

let cachedFirebaseKeys = null;
let cachedFirebaseKeysAt = 0;

async function getFirebaseJWK(kid) {
    const now = Date.now();
    if (!cachedFirebaseKeys || now - cachedFirebaseKeysAt > 5 * 60 * 1000) {
        const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
        cachedFirebaseKeys = await res.json();
        cachedFirebaseKeysAt = now;
    }
    return cachedFirebaseKeys.keys.find(k => k.kid === kid);
}

async function verifyFirebaseIdToken(idToken, projectId) {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");
    const [headerB64, payloadB64, sigB64] = parts;

    const header = base64UrlDecodeJSON(headerB64);
    const payload = base64UrlDecodeJSON(payloadB64);

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("Token expired");
    if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new Error("Bad iat");
    if (payload.aud !== projectId) throw new Error("Bad audience");
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Bad issuer");
    if (!payload.sub) throw new Error("Missing sub");

    const jwk = await getFirebaseJWK(header.kid);
    if (!jwk) throw new Error("Unknown signing key");

    const cryptoKey = await crypto.subtle.importKey(
        "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );

    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToUint8Array(sigB64);

    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
    if (!valid) throw new Error("Invalid signature");

    return payload;
}

// ============================================================================
// FIRESTORE
// ============================================================================

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

async function getGoogleAccessToken(env) {
    const now = Math.floor(Date.now() / 1000);
    if (cachedAccessToken && cachedAccessTokenExp - 30 > now) return cachedAccessToken;

    const header = { alg: "RS256", typ: "JWT" };
    const claimSet = {
        iss: env.FIREBASE_CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600
    };

    const encHeader = base64UrlEncode(JSON.stringify(header));
    const encClaims = base64UrlEncode(JSON.stringify(claimSet));
    const unsigned = `${encHeader}.${encClaims}`;

    const privateKey = await importPkcs8PrivateKey(env.FIREBASE_PRIVATE_KEY);
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));

    const jwt = `${unsigned}.${arrayBufferToBase64Url(signature)}`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt
        })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error("Failed to get Google token: " + JSON.stringify(tokenData));

    cachedAccessToken = tokenData.access_token;
    cachedAccessTokenExp = now + tokenData.expires_in;
    return cachedAccessToken;
}

function firestoreBaseUrl(env) {
    return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

async function ensureUserDoc(env, uid, accessTokenIn) {
    const accessToken = accessTokenIn || await getGoogleAccessToken(env);

    const createRes = await fetch(
        `${firestoreBaseUrl(env)}/users/${uid}?currentDocument.exists=false`,
        {
            method: "PATCH",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                fields: {
                    tokens: { integerValue: String(FREE_TOKENS_ON_SIGNUP) },
                    createdAt: { timestampValue: new Date().toISOString() }
                }
            })
        }
    );

    if (createRes.status === 200) return FREE_TOKENS_ON_SIGNUP;

    const getRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const doc = await getRes.json();
    return parseInt(doc.fields?.tokens?.integerValue || "0", 10);
}

async function canGenerateCode(env, accessToken, uid) {
    const balRes = await fetch(`${firestoreBaseUrl(env)}:batchGet`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            documents: [`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`]
        })
    }).then(r => r.json());

    const found = Array.isArray(balRes) ? balRes.find(r => r.found) : null;
    if (!found) return false;

    const balance = parseInt(found.found.fields?.tokens?.integerValue || "0", 10);
    return balance > 0;
}

async function chargeForCodeGenerationByCost(env, accessToken, uid, costUsd, minMilli = CODE_GEN_MIN_MILLI_TOKENS) {
    let milli = Math.ceil((costUsd / TOKEN_VALUE_USD) * 1000);
    if (milli < minMilli) milli = minMilli;

    const txRes = await fetch(`${firestoreBaseUrl(env)}:beginTransaction`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({})
    });
    const { transaction } = await txRes.json();

    const balRes = await fetch(`${firestoreBaseUrl(env)}:batchGet`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            documents: [`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`],
            transaction
        })
    }).then(r => r.json());

    const found = Array.isArray(balRes) ? balRes.find(r => r.found) : null;
    if (!found) return false;

    const oldDebtMilli = parseInt(found.found.fields?.codeDebtMilli?.integerValue || "0", 10);
    const newDebtMilli = oldDebtMilli + milli;
    const tokensToCharge = Math.floor(newDebtMilli / 1000);
    const debtDelta = milli - (tokensToCharge * 1000); // ile netto dopisać do długu

    const fieldTransforms = [
        { fieldPath: "codeDebtMilli", increment: { integerValue: String(debtDelta) } }
    ];
    if (tokensToCharge > 0) {
        fieldTransforms.push({ fieldPath: "tokens", increment: { integerValue: String(-tokensToCharge) } });
    }

    const commitRes = await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{
                transform: {
                    document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
                    fieldTransforms
                }
            }],
            transaction
        })
    });

    return commitRes.ok;
}

async function chargeTokens(env, accessToken, uid, amount) {
    const txRes = await fetch(`${firestoreBaseUrl(env)}:beginTransaction`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({})
    });
    const { transaction } = await txRes.json();

    const balRes = await fetch(`${firestoreBaseUrl(env)}:batchGet`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            documents: [`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`],
            transaction
        })
    }).then(r => r.json());

    const found = Array.isArray(balRes) ? balRes.find(r => r.found) : null;
    const balance = found ? parseInt(found.found.fields?.tokens?.integerValue || "0", 10) : 0;

    if (balance < amount) return false;

    const commitRes = await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{
                transform: {
                    document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
                    fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(-amount) } }]
                }
            }],
            transaction
        })
    });

    return commitRes.ok;
}

async function refundTokens(env, accessToken, uid, amount) {
    await addTokens(env, accessToken, uid, amount);
}

async function addTokens(env, accessToken, uid, amount) {
    await fetch(`${firestoreBaseUrl(env)}:commit`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            writes: [{
                transform: {
                    document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
                    fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(amount) } }]
                }
            }]
        })
    });
}


// ============================================================================
// PROMO CODES
// ============================================================================
//
// promoCodes/{CODE}                      tokens, maxUses (0 = no limit), uses,
//                                        active, expiresAt?, note?, createdAt
// promoCodes/{CODE}/redemptions/{uid}    who used it, when, for how much
//
// Every account can use a given code once. Using it is one transaction:
// the code and the account's redemption are read inside it, and the commit
// bumps the count, records the redemption (only if it does not exist yet)
// and adds the tokens together, so two clicks, two tabs or two people on
// the last use of a code can never both get through.
//
// Who may create codes is a list of e-mail addresses in the ADMIN_EMAILS
// variable (comma separated), checked against the verified Google account.

const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const PROMO_MAX_TOKENS = 100000;
const PROMO_FAIL_LIMIT = 10;              // wrong codes per account...
const PROMO_FAIL_WINDOW_MS = 60 * 60 * 1000; // ...per hour, then a pause

function normalizePromoCode(raw) {
    return String(raw || "").toUpperCase().replace(/\s+/g, "");
}

function isAdminClaims(claims, env) {
    const list = String(env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
    const email = String(claims && claims.email || "").toLowerCase();
    return !!(email && claims.email_verified !== false && list.includes(email));
}

function promoDocName(env, code) {
    return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/promoCodes/${code}`;
}

function promoFromFields(code, f) {
    f = f || {};
    return {
        code,
        tokens: parseInt(f.tokens?.integerValue || "0", 10),
        maxUses: parseInt(f.maxUses?.integerValue || "0", 10),
        uses: parseInt(f.uses?.integerValue || "0", 10),
        active: f.active?.booleanValue !== false,
        expiresAt: f.expiresAt?.timestampValue || null,
        note: f.note?.stringValue || "",
        createdAt: f.createdAt?.timestampValue || null
    };
}

// Why a code cannot be used right now, in words for the person holding it.
function promoRefusal(promo, alreadyUsed, now) {
    if (!promo) return "That code does not exist.";
    if (!promo.active) return "That code is no longer active.";
    if (promo.expiresAt && Date.parse(promo.expiresAt) <= now) return "That code has expired.";
    if (alreadyUsed) return "You have already used this code.";
    if (promo.maxUses > 0 && promo.uses >= promo.maxUses) return "That code has been used up.";
    if (!(promo.tokens > 0)) return "That code has nothing on it.";
    return null;
}

async function handlePromoRedeem(request, env) {
    const uid = await requireAuth(request, env);
    const body = await request.json().catch(() => ({}));
    const code = normalizePromoCode(body.code);
    if (!PROMO_CODE_RE.test(code)) return json({ error: "That is not a valid code." }, 400);

    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const auth = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
    const base = firestoreBaseUrl(env);
    const userDoc = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const promoDoc = promoDocName(env, code);
    const redemptionDoc = `${promoDoc}/redemptions/${uid}`;

    // Contention on the last use of a popular code is the only reason a
    // commit fails here; the loser just reads again and gets a straight answer.
    for (let attempt = 0; attempt < 3; attempt++) {
        const { transaction } = await fetch(`${base}:beginTransaction`, {
            method: "POST", headers: auth, body: JSON.stringify({})
        }).then(r => r.json());

        const got = await fetch(`${base}:batchGet`, {
            method: "POST", headers: auth,
            body: JSON.stringify({ documents: [promoDoc, redemptionDoc, userDoc], transaction })
        }).then(r => r.json());

        const byName = {};
        for (const row of Array.isArray(got) ? got : []) if (row.found) byName[row.found.name] = row.found;
        const user = byName[userDoc]?.fields || {};
        const now = Date.now();

        // A pause after a run of wrong guesses, so codes cannot be walked.
        const fails = parseInt(user.promoFails?.integerValue || "0", 10);
        const failAt = Date.parse(user.promoFailAt?.timestampValue || 0) || 0;
        if (fails >= PROMO_FAIL_LIMIT && now - failAt < PROMO_FAIL_WINDOW_MS) {
            await fetch(`${base}:rollback`, { method: "POST", headers: auth, body: JSON.stringify({ transaction }) });
            return json({ error: "Too many wrong codes. Try again in an hour." }, 429);
        }

        const promo = byName[promoDoc] ? promoFromFields(code, byName[promoDoc].fields) : null;
        const refusal = promoRefusal(promo, !!byName[redemptionDoc], now);
        if (refusal) {
            await fetch(`${base}:rollback`, { method: "POST", headers: auth, body: JSON.stringify({ transaction }) });
            if (!promo) {
                // Only codes that do not exist count as guesses.
                const reset = now - failAt >= PROMO_FAIL_WINDOW_MS;
                await fetch(`${base}:commit`, {
                    method: "POST", headers: auth,
                    body: JSON.stringify({ writes: [{
                        update: { name: userDoc, fields: {
                            promoFails: { integerValue: String(reset ? 1 : fails + 1) },
                            promoFailAt: { timestampValue: new Date(reset ? now : failAt || now).toISOString() }
                        } },
                        updateMask: { fieldPaths: ["promoFails", "promoFailAt"] }
                    }] })
                });
            }
            return json({ error: refusal }, promo ? 409 : 404);
        }

        const commit = await fetch(`${base}:commit`, {
            method: "POST", headers: auth,
            body: JSON.stringify({
                transaction,
                writes: [
                    { transform: { document: promoDoc, fieldTransforms: [{ fieldPath: "uses", increment: { integerValue: "1" } }] } },
                    {
                        update: { name: redemptionDoc, fields: {
                            uid: { stringValue: uid },
                            tokens: { integerValue: String(promo.tokens) },
                            redeemedAt: { timestampValue: new Date(now).toISOString() }
                        } },
                        currentDocument: { exists: false }
                    },
                    { transform: { document: userDoc, fieldTransforms: [{ fieldPath: "tokens", increment: { integerValue: String(promo.tokens) } }] } }
                ]
            })
        });

        if (commit.ok) {
            const balance = parseInt(user.tokens?.integerValue || "0", 10) + promo.tokens;
            return json({ ok: true, code, tokens: promo.tokens, balance });
        }
        // ABORTED means someone else changed the code between read and write.
        if (commit.status !== 409 && commit.status !== 400) {
            return json({ error: "Could not use the code right now. Try again." }, 502);
        }
    }
    return json({ error: "That code is busy right now. Try again in a moment." }, 503);
}

function randomPromoCode() {
    // No 0/O or 1/I, so a code read off a screen types back correctly.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let out = "";
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return out.slice(0, 4) + "-" + out.slice(4);
}

async function handlePromoAdmin(request, env) {
    const claims = await getAuthClaims(request, env);
    if (!isAdminClaims(claims, env)) return json({ error: "Only admins can manage codes." }, 403);

    const accessToken = await getGoogleAccessToken(env);
    const auth = { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" };
    const base = firestoreBaseUrl(env);

    if (request.method === "GET") {
        const res = await fetch(`${base}/promoCodes?pageSize=300`, { headers: auth });
        if (!res.ok) return json({ error: "Could not read codes: " + await res.text() }, 502);
        const data = await res.json();
        const codes = (data.documents || [])
            .map(d => promoFromFields(d.name.split("/").pop(), d.fields))
            .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return json({ codes });
    }

    const body = await request.json().catch(() => ({}));

    // Switching a code off (or back on) keeps it and its history.
    if (body.action === "toggle") {
        const code = normalizePromoCode(body.code);
        if (!PROMO_CODE_RE.test(code)) return json({ error: "Invalid code." }, 400);
        const res = await fetch(`${base}/promoCodes/${code}?updateMask.fieldPaths=active&currentDocument.exists=true`, {
            method: "PATCH", headers: auth,
            body: JSON.stringify({ fields: { active: { booleanValue: !!body.active } } })
        });
        if (!res.ok) return json({ error: "Could not change the code." }, res.status === 404 ? 404 : 502);
        return json({ ok: true, code, active: !!body.active });
    }

    const tokens = parseInt(body.tokens, 10);
    if (!(tokens > 0 && tokens <= PROMO_MAX_TOKENS)) return json({ error: `Tokens must be between 1 and ${PROMO_MAX_TOKENS}.` }, 400);
    const maxUses = Math.max(0, parseInt(body.maxUses, 10) || 0);
    let expiresAt = null;
    if (body.expiresAt) {
        const t = Date.parse(body.expiresAt);
        if (!Number.isFinite(t)) return json({ error: "The expiry date is not a date." }, 400);
        expiresAt = new Date(t).toISOString();
    }
    const wanted = normalizePromoCode(body.code);
    if (wanted && !PROMO_CODE_RE.test(wanted)) {
        return json({ error: "Codes are 3 to 32 letters, digits, - or _, starting with a letter or digit." }, 400);
    }

    const fields = {
        tokens: { integerValue: String(tokens) },
        maxUses: { integerValue: String(maxUses) },
        uses: { integerValue: "0" },
        active: { booleanValue: true },
        note: { stringValue: String(body.note || "").slice(0, 200) },
        createdAt: { timestampValue: new Date().toISOString() },
        createdBy: { stringValue: String(claims.email || claims.sub) }
    };
    if (expiresAt) fields.expiresAt = { timestampValue: expiresAt };

    // A generated code that happens to exist is simply drawn again.
    for (let attempt = 0; attempt < (wanted ? 1 : 4); attempt++) {
        const code = wanted || randomPromoCode();
        const res = await fetch(`${base}/promoCodes/${code}?currentDocument.exists=false`, {
            method: "PATCH", headers: auth, body: JSON.stringify({ fields })
        });
        if (res.ok) return json({ ok: true, promo: promoFromFields(code, fields) });
        if (res.status !== 400 && res.status !== 409) return json({ error: "Could not save the code: " + await res.text() }, 502);
        if (wanted) return json({ error: "That code already exists." }, 409);
    }
    return json({ error: "Could not find a free code. Try again." }, 503);
}

// ============================================================================
// STRIPE
// ============================================================================

async function verifyStripeSignature(payload, sigHeader, secret) {
    const parts = Object.fromEntries(sigHeader.split(",").map(kv => { const [k, v] = kv.split("="); return [k, v]; }));
    if (!parts.t || !parts.v1) return false;

    const signedPayload = `${parts.t}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

    return timingSafeEqual(expected, parts.v1);
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ============================================================================
// CRYPTO / ENCODING HELPERS
// ============================================================================

function base64UrlEncode(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
    let str = "";
    bytes.forEach(b => str += String.fromCharCode(b));
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function arrayBufferToBase64Url(buf) {
    return base64UrlEncode(buf);
}

async function importPkcs8PrivateKey(pem) {
    const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
    const pemBody = normalized
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(/\s/g, "");
    const der = base64UrlToUint8Array(pemBody.replace(/\+/g, "-").replace(/\//g, "_"));
    return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// ============================================================================
// JSON / CORS HELPERS
// ============================================================================

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
    });
}

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Expose-Headers": "X-Image-Url, X-Image-Style"
    };
}

// Konfiguracja sekretu workera:
// wrangler secret put TRIPO_API_KEY

// ============================================================================
// ROBLOX OAuth 2.0 (linkowanie konta Roblox do konta RoPeak)
// ============================================================================

/*
    A mesh the page has just built, uploaded to the user's own Roblox account.

    Studio's own AssetService:CreateAssetAsync would be the short way round,
    but it is a beta API behind a gate no plugin can open, and for most
    accounts it is shut. This is the road the generated decals have always
    taken and it has no gate on it: Open Cloud, signed with the OAuth token
    the user granted when they linked their Roblox account, which already
    carries asset:write.

    A .glb goes up as a Model - Roblox imports it as a Model holding one
    MeshPart per material, exactly as its own 3D importer would - and comes
    back as an asset id the plugin can insert.
*/
const ROBLOX_ASSET_MAX_BYTES = 20 * 1024 * 1024;   // Open Cloud's own limit
const ROBLOX_ASSET_TRIES = 30;                     // ~45s of waiting on the operation

/*
    Roblox refusing an upload is nearly always one of three things, and they
    need different answers from the user. Guessing between them in a message
    would be worse than useless, so this asks: the token itself says whether
    it is still alive and what it may do, and the resources endpoint says
    whose account it may act for.
*/
/*
    Is this permission in that scope string?

    Roblox writes several operations on one resource together: a token holding
    asset:read and asset:write comes back as "asset:read,write". Searching that
    for the words "asset:write" finds nothing, which is how a token with
    exactly the right permission got told it did not have it.
*/
function robloxHasScope(scope, want) {
    const at = want.indexOf(":");
    const resource = want.slice(0, at), op = want.slice(at + 1);
    return String(scope || "").split(/\s+/).some(part => {
        const cut = part.indexOf(":");
        if (cut < 0) return false;
        if (part.slice(0, cut) !== resource) return false;
        return part.slice(cut + 1).split(",").includes(op);
    });
}

async function robloxWhyRefused(env, token, bodyText) {
    const form = (extra) => new URLSearchParams(Object.assign({
        token, client_id: env.ROBLOX_CLIENT_ID, client_secret: env.ROBLOX_CLIENT_SECRET
    }, extra || {}));
    const ask = async (path) => {
        try {
            const r = await fetch(`https://apis.roblox.com/oauth/v1/${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: form()
            });
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    };

    const seen = await ask("token/introspect");
    if (seen && seen.active === false) {
        return "Your Roblox sign-in has run out. Open ro-peak.com, disconnect your Roblox " +
            "account and connect it again.";
    }
    if (seen && typeof seen.scope === "string" && !robloxHasScope(seen.scope, "asset:write")) {
        return "The link to your Roblox account does not include permission to upload assets " +
            "(it has: " + seen.scope + "). It was made before RoPeak asked for that. Disconnect " +
            "your Roblox account on ro-peak.com and connect it again.";
    }

    const res = await ask("token/resources");
    const infos = res && res.resource_infos;
    const hasCreator = Array.isArray(infos) && infos.some(i =>
        i && i.resources && i.resources.creator &&
        Array.isArray(i.resources.creator.ids) && i.resources.creator.ids.length);
    if (infos && !hasCreator) {
        return "Roblox let RoPeak sign you in, but did not give it an account to create " +
            "things for - that is picked on Roblox's own consent screen, not here. On " +
            "ro-peak.com disconnect your Roblox account and connect it again; the screen will " +
            "come up, and your account has to be ticked under the assets permission before " +
            "Continue. Nothing else needs changing.";
    }

    // Nothing about the link explains it, so hand over everything that was
    // asked rather than a guess. Whoever reads this next should not have to
    // go and ask the same three questions again.
    return "Roblox would not take the model: " + String(bodyText || "").slice(0, 200) +
        " — the link itself looks right (permissions: " + ((seen && seen.scope) || "unknown") +
        "; may create for: " + (hasCreator ? "yes" : (infos ? "no" : "unknown")) +
        "). Connecting your Roblox account again on ro-peak.com is worth trying.";
}

async function handleRobloxUploadModel(request, env, url) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const name = String((url && url.searchParams.get("name")) || "RoPeak mesh").slice(0, 50);

    const userRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const robloxUserId = userRes.ok
        ? (await userRes.json()).fields?.robloxUserId?.stringValue
        : null;
    if (!robloxUserId) {
        return json({ error: "No Roblox account is linked to this RoPeak account. " +
            "Link it on ro-peak.com and try again." }, 400);
    }

    let robloxToken = await getValidRobloxToken(env, accessToken, uid, robloxUserId);
    if (!robloxToken) {
        return json({ error: "The link to your Roblox account has expired. " +
            "Connect it again on ro-peak.com." }, 401);
    }

    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: "Nothing was sent." }, 400);
    if (bytes.byteLength > ROBLOX_ASSET_MAX_BYTES) {
        return json({ error: `That model is ${(bytes.byteLength / 1048576).toFixed(1)} MB and ` +
            `Roblox takes 20 MB at most. Optimise a smaller part of the build.` }, 413);
    }

    // A body cannot be sent twice, so it is built each time it is sent.
    const send = async (token) => {
        const form = new FormData();
        form.append("request", JSON.stringify({
            assetType: "Model",
            displayName: name,
            description: "Optimised by RoPeak",
            creationContext: { creator: { userId: robloxUserId } }
        }));
        form.append("fileContent",
            new Blob([bytes], { type: "model/gltf-binary" }), "model.glb");
        return await fetch("https://apis.roblox.com/assets/v1/assets", {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: form
        });
    };

    let res = await send(robloxToken);

    // Fifteen minutes is the whole life of one of these tokens, so a refusal
    // is far more likely to be a stale token than a real "no". Ask for a new
    // one and try once more before telling anyone anything went wrong.
    if (res.status === 401 || res.status === 403) {
        const fresh = await getValidRobloxToken(env, accessToken, uid, robloxUserId, true);
        if (fresh && fresh !== robloxToken) {
            robloxToken = fresh;
            res = await send(robloxToken);
        }
    }

    if (!res.ok) {
        return json({ error: await robloxWhyRefused(env, robloxToken, await res.text()) }, 502);
    }

    // The upload answers with an operation, not an asset: Roblox converts and
    // moderates the mesh first. Asking until it is done is the whole protocol.
    let data = await res.json();
    if (data.done) {
        const id = data.response?.assetId;
        return id ? json({ assetId: String(id) })
                  : json({ error: "Roblox finished without giving an asset id." }, 502);
    }
    if (!data.path) return json({ error: "Roblox gave nothing to wait on." }, 502);

    for (let i = 0; i < ROBLOX_ASSET_TRIES; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const opRes = await fetch(`https://apis.roblox.com/assets/v1/${data.path}`, {
            headers: { "Authorization": `Bearer ${robloxToken}` }
        });
        if (!opRes.ok) {
            return json({ error: "Lost track of the upload: " +
                (await opRes.text()).slice(0, 200) }, 502);
        }
        const op = await opRes.json();
        if (op.done) {
            const id = op.response?.assetId;
            if (id) return json({ assetId: String(id) });
            return json({ error: "Roblox refused the model: " +
                JSON.stringify(op.error || op.response || {}).slice(0, 300) }, 502);
        }
    }

    return json({ error: "Roblox is still working on the upload. It may yet appear in your " +
        "inventory - check there before sending it again." }, 504);
}

async function getValidRobloxToken(env, accessToken, uid, robloxUserId, force) {
    const linkRes = await fetch(`${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(robloxUserId)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!linkRes.ok) return null;
    
    const doc = await linkRes.json();
    const fields = doc.fields;
    if (!fields || !fields.robloxAccessToken) return null;
    
    let robloxAccessToken = fields.robloxAccessToken.stringValue;
    const expiresAtStr = fields.robloxTokenExpiresAt?.timestampValue;
    const refreshToken = fields.robloxRefreshToken?.stringValue;
    
    // Roblox access tokens last about fifteen minutes. A record with no
    // expiry written down is therefore an expired one, not a fresh one - that
    // reading is what let a long-dead token be handed out as good and come
    // back from Roblox as "User not authenticated". `force` is for a caller
    // that has just been refused with a token this thought was fine.
    if (refreshToken) {
        const expiresAt = expiresAtStr ? new Date(expiresAtStr).getTime() - 60000 : 0;
        if (force || !expiresAtStr || Date.now() > expiresAt) {
            // Token wygasł, próbujemy go odświeżyć
            const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                    client_id: env.ROBLOX_CLIENT_ID,
                    client_secret: env.ROBLOX_CLIENT_SECRET
                })
            });
            
            if (tokenRes.ok) {
                const tokenData = await tokenRes.json();
                robloxAccessToken = tokenData.access_token;
                const newExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();
                
                await fetch(`${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(robloxUserId)}`, {
                    method: "PATCH",
                    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        fields: {
                            uid: fields.uid,
                            robloxUsername: fields.robloxUsername,
                            robloxAccessToken: { stringValue: tokenData.access_token },
                            robloxRefreshToken: { stringValue: tokenData.refresh_token },
                            robloxTokenExpiresAt: { timestampValue: newExpiresAt },
                            linkedAt: fields.linkedAt
                        }
                    })
                });
            } else {
                console.error("Error refreshing Roblox token:", await tokenRes.text());
                return null;
            }
        }
    }
    
    return robloxAccessToken;
}

async function handleRobloxOAuthStart(request, env) {
    const uid = await requireAuth(request, env);
    const nonce = crypto.randomUUID();
    const state = base64UrlEncode(JSON.stringify({ uid, nonce }));

    const accessToken = await getGoogleAccessToken(env);
    await fetch(`${firestoreBaseUrl(env)}/oauthStates?documentId=${encodeURIComponent(nonce)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                uid: { stringValue: uid },
                createdAt: { timestampValue: new Date().toISOString() }
            }
        })
    });

    const params = new URLSearchParams({
        client_id: env.ROBLOX_CLIENT_ID,
        redirect_uri: env.OAUTH_REDIRECT_URI,
        scope: "openid profile asset:write asset:read",
        response_type: "code",
        // No prompt of our own. Roblox runs its own account-selection step
        // for an app that asks to create assets, and naming a prompt here
        // replaces that step rather than adding to it - asking for "consent"
        // got the flow refused outright with "Account selection prompt is
        // required for this request". What makes connecting again mean
        // something is the revoke in handleRobloxUnlink, not a prompt: with
        // no authorization left to hand back, Roblox has to ask everything
        // from the beginning.
        state
    });

    return json({ redirectUrl: `https://apis.roblox.com/oauth/v1/authorize?${params.toString()}` });
}

async function handleRobloxOAuthCallback(request, env, url) {
    url = url || new URL(request.url);
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state");
    if (!code || !stateRaw) return new Response("Missing code/state", { status: 400 });

    let state;
    try { state = base64UrlDecodeJSON(stateRaw); } catch (e) { return new Response("Bad state", { status: 400 }); }
    const { uid, nonce } = state;

    const accessToken = await getGoogleAccessToken(env);

    const nonceRes = await fetch(`${firestoreBaseUrl(env)}/oauthStates/${encodeURIComponent(nonce)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!nonceRes.ok) return new Response("Expired or invalid session", { status: 400 });

    const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: env.ROBLOX_CLIENT_ID,
            client_secret: env.ROBLOX_CLIENT_SECRET,
            redirect_uri: env.OAUTH_REDIRECT_URI
        })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return new Response("Roblox token exchange failed: " + JSON.stringify(tokenData), { status: 400 });

    const userRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
        headers: { "Authorization": `Bearer ${tokenData.access_token}` }
    });
    const userInfo = await userRes.json();
    const robloxUserId = String(userInfo.sub);
    const robloxUsername = userInfo.preferred_username || userInfo.nickname || "";

    const tokenExpiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

    const linkRes = await fetch(`${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(robloxUserId)}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                uid: { stringValue: uid },
                robloxUsername: { stringValue: robloxUsername },
                robloxAccessToken: { stringValue: tokenData.access_token },
                robloxRefreshToken: { stringValue: tokenData.refresh_token },
                robloxTokenExpiresAt: { timestampValue: tokenExpiresAt },
                linkedAt: { timestampValue: new Date().toISOString() }
            }
        })
    });
    if (!linkRes.ok) {
        const errText = await linkRes.text();
        return new Response("Failed to link account in DB: " + errText, { status: 500 });
    }

    const userUpdateRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}?updateMask.fieldPaths=robloxUserId&updateMask.fieldPaths=robloxUsername`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                robloxUserId: { stringValue: robloxUserId },
                robloxUsername: { stringValue: robloxUsername }
            }
        })
    });
    if (!userUpdateRes.ok) {
        const errText = await userUpdateRes.text();
        return new Response("Failed to update user in DB: " + errText, { status: 500 });
    }

    await fetch(`${firestoreBaseUrl(env)}/oauthStates/${encodeURIComponent(nonce)}`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${accessToken}` }
    });

    return Response.redirect(`${env.PUBLIC_APP_URL}/?roblox_linked=1`, 302);
}

async function handleRobloxAvatarProxy(request, env, url) {
    await requireAuth(request, env);
    const userId = url.searchParams.get("userId");
    if (!userId) return json({ error: "Brak userId" }, 400);
    try {
        // The card shows follower and friend counts beside the avatar. All three
        // come from public Roblox endpoints, so they go out together rather
        // than costing the card a second round trip, and a count that fails is
        // not worth failing the avatar over.
        //
        // A failed count is null, never 0: fetchRobloxUserStats coalesces to 0
        // and that is exactly how a refused request ends up on screen looking
        // like a measurement.
        const [avatarRes, followersRes, friendsRes] = await Promise.all([
            fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=true`),
            fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
            fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`)
        ]);

        const readCount = async (res) => {
            if (!res.ok) return { value: null, status: res.status };
            try {
                const body = await res.json();
                return { value: typeof body.count === "number" ? body.count : null, status: 200 };
            } catch (err) {
                return { value: null, status: -1 };
            }
        };

        const data = avatarRes.ok ? await avatarRes.json() : { data: [] };
        const followers = await readCount(followersRes);
        const friends = await readCount(friendsRes);

        if (followers.value === null || friends.value === null) {
            console.warn(`Roblox counts unavailable for ${userId}: followers=${followers.status} friends=${friends.status}`);
        }

        return json({
            avatarUrl: data.data?.[0]?.imageUrl || null,
            followers: followers.value,
            friends: friends.value,
            // Lets the card tell "no followers" apart from "Roblox would not
            // say", and names the reason in the second case.
            countsStatus: { followers: followers.status, friends: friends.status }
        });
    } catch (e) {
        return json({ avatarUrl: null });
    }
}

// ============================================================================
// Developer stats — total visits and concurrent players across the linked
// account's experiences, plus any groups the user has opted in.
//
// Group projects are the normal case for a Roblox developer, so counting only
// personally owned places would understate most accounts. Which groups count
// is the user's choice, stored per account.
// ============================================================================

const ROBLOX_GAMES_PER_PAGE = 50;
const ROBLOX_GAMES_MAX_PAGES = 4;   // caps one account at 200 experiences
const ROBLOX_STATS_CHUNK = 50;      // the games endpoint takes a list of ids

// Every experience id for one creator. Public only: that is what the profile
// shows anyway, and the worker holds no token that would see more.
async function fetchRobloxUniverseIds(ownerType, ownerId) {
    const base = ownerType === "group"
        ? `https://games.roblox.com/v2/groups/${ownerId}/games?accessFilter=Public&limit=${ROBLOX_GAMES_PER_PAGE}&sortOrder=Desc`
        : `https://games.roblox.com/v2/users/${ownerId}/games?accessFilter=Public&limit=${ROBLOX_GAMES_PER_PAGE}&sortOrder=Desc`;

    const ids = [];
    let cursor = "";
    for (let page = 0; page < ROBLOX_GAMES_MAX_PAGES; page++) {
        const res = await fetch(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
        if (!res.ok) return { ids, status: res.status };
        const body = await res.json();
        for (const game of body.data || []) {
            if (game && game.id) ids.push(String(game.id));
        }
        cursor = body.nextPageCursor || "";
        if (!cursor) break;
    }
    return { ids, status: 200 };
}

// Totals across a set of experiences. A chunk that fails is reported rather
// than quietly dropped, because a partial sum presented as a total is a wrong
// number that looks right.
async function sumRobloxUniverseStats(universeIds) {
    let visits = 0, playing = 0, games = 0, failedChunks = 0, status = 200;

    for (let i = 0; i < universeIds.length; i += ROBLOX_STATS_CHUNK) {
        const chunk = universeIds.slice(i, i + ROBLOX_STATS_CHUNK);
        const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${chunk.join(",")}`);
        if (!res.ok) {
            failedChunks++;
            status = res.status;
            continue;
        }
        const body = await res.json();
        for (const game of body.data || []) {
            visits += game.visits ?? 0;
            playing += game.playing ?? 0;
            games++;
        }
    }
    return { visits, playing, games, complete: failedChunks === 0, status };
}

async function robloxAccountFromUser(env, uid, accessToken) {
    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const doc = res.ok ? await res.json() : {};
    return {
        robloxUserId: doc.fields?.robloxUserId?.stringValue || null,
        groupIds: (doc.fields?.robloxGroupIds?.arrayValue?.values || [])
            .map(v => v.stringValue)
            .filter(Boolean)
    };
}

async function handleRobloxDevStats(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);
    const { robloxUserId, groupIds } = await robloxAccountFromUser(env, uid, accessToken);
    if (!robloxUserId) return json({ error: "Roblox account not linked" }, 400);

    const owners = [{ type: "user", id: robloxUserId }];
    for (const id of groupIds) owners.push({ type: "group", id });

    const lists = await Promise.all(owners.map(o => fetchRobloxUniverseIds(o.type, o.id)));
    const failed = lists.find(l => l.status !== 200);
    const ids = [...new Set(lists.flatMap(l => l.ids))];

    // Nothing to sum and something refused: unknown, not zero.
    if (!ids.length) {
        return json({
            visits: failed ? null : 0,
            playing: failed ? null : 0,
            games: 0,
            groupsCounted: groupIds.length,
            status: failed ? failed.status : 200
        });
    }

    const totals = await sumRobloxUniverseStats(ids);
    return json({
        visits: totals.complete ? totals.visits : null,
        playing: totals.complete ? totals.playing : null,
        games: totals.games,
        groupsCounted: groupIds.length,
        status: totals.complete ? 200 : totals.status
    });
}

async function handleRobloxGroupsList(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);
    const { robloxUserId, groupIds } = await robloxAccountFromUser(env, uid, accessToken);
    if (!robloxUserId) return json({ error: "Roblox account not linked" }, 400);

    const res = await fetch(`https://groups.roblox.com/v1/users/${robloxUserId}/groups/roles`);
    if (!res.ok) return json({ groups: null, status: res.status });

    const body = await res.json();
    const selected = new Set(groupIds);
    const groups = (body.data || [])
        .filter(entry => entry && entry.group && entry.group.id)
        .map(entry => ({
            id: String(entry.group.id),
            name: entry.group.name || "Group",
            memberCount: entry.group.memberCount ?? 0,
            role: entry.role?.name || "",
            selected: selected.has(String(entry.group.id))
        }));

    return json({ groups, status: 200 });
}

async function handleRobloxGroupsSave(request, env) {
    const uid = await requireAuth(request, env);
    const payload = await request.json().catch(() => ({}));
    // Ids come from the browser, so they are re-checked here before they are
    // ever pasted into a Roblox URL.
    const ids = Array.isArray(payload.groupIds)
        ? [...new Set(payload.groupIds.map(String).filter(id => /^[0-9]{1,15}$/.test(id)))].slice(0, 50)
        : [];

    const accessToken = await getGoogleAccessToken(env);
    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}?updateMask.fieldPaths=robloxGroupIds`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: { robloxGroupIds: { arrayValue: { values: ids.map(id => ({ stringValue: id })) } } }
        })
    });
    if (!res.ok) return json({ error: "Failed to save groups: " + await res.text() }, 500);
    return json({ ok: true, groupIds: ids });
}

async function handleRobloxUnlink(request, env) {
    const uid = await requireAuth(request, env);
    const accessToken = await getGoogleAccessToken(env);

    const userDoc = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    }).then(r => r.json());
    const robloxUserId = userDoc.fields?.robloxUserId?.stringValue;

    if (robloxUserId) {
        // Tell Roblox first. Deleting our own record only makes this side
        // forget; the authorization goes on existing over there, and the next
        // connection is handed the same one back - including whatever it was
        // missing. Revoking it is what makes "connect again" mean it.
        try {
            const linkRes = await fetch(
                `${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(robloxUserId)}`,
                { headers: { "Authorization": `Bearer ${accessToken}` } });
            const refresh = linkRes.ok
                ? (await linkRes.json()).fields?.robloxRefreshToken?.stringValue
                : null;
            if (refresh) {
                await fetch("https://apis.roblox.com/oauth/v1/token/revoke", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        token: refresh,
                        client_id: env.ROBLOX_CLIENT_ID,
                        client_secret: env.ROBLOX_CLIENT_SECRET
                    })
                });
            }
        } catch (e) {
            console.error("roblox revoke:", e);
        }

        await fetch(`${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(robloxUserId)}`, {
            method: "DELETE", headers: { "Authorization": `Bearer ${accessToken}` }
        });
    }
    await fetch(`${firestoreBaseUrl(env)}/users/${uid}?updateMask.fieldPaths=robloxUserId&updateMask.fieldPaths=robloxUsername`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {} })
    });

    return json({ ok: true });
}

// ============================================================================
// PLUGIN (Roblox Studio)
// ============================================================================

const PLUGIN_SESSION_TTL_MS = 60 * 60 * 1000; // 1h

async function handlePluginCheck(request, env) {
    const { robloxUserId } = await request.json();
    if (!robloxUserId) return json({ error: "Missing robloxUserId" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    const linkRes = await fetch(`${firestoreBaseUrl(env)}/robloxLinks/${encodeURIComponent(String(robloxUserId))}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });

    const appUrl = env.PUBLIC_APP_URL || env.CHECKOUT_SUCCESS_URL || "https://roblox-generate-ui.vercel.app";

    if (!linkRes.ok) {
        return json({
            linked: false,
            loginUrl: `${appUrl}/?linkRoblox=1&robloxUserId=${encodeURIComponent(robloxUserId)}`
        });
    }

    const linkDoc = await linkRes.json();
    const uid = linkDoc.fields?.uid?.stringValue;
    if (!uid) return json({ linked: false, loginUrl: `${appUrl}/?linkRoblox=1` });

    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + PLUGIN_SESSION_TTL_MS;

    await fetch(`${firestoreBaseUrl(env)}/pluginSessions?documentId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                uid: { stringValue: uid },
                expiresAt: { integerValue: String(expiresAt) }
            }
        })
    });

    const userRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    let tokens = 0;
    let codeDebtMilli = 0;
    let theme = null;
    if (userRes.ok) {
        const userDoc = await userRes.json();
        tokens = parseInt(userDoc.fields?.tokens?.integerValue || "0", 10);
        codeDebtMilli = parseInt(userDoc.fields?.codeDebtMilli?.integerValue || "0", 10);
        const t = userDoc.fields?.theme?.stringValue;
        theme = APP_THEMES.includes(t) ? t : null;
    }

    return json({ linked: true, pluginToken: sessionId, expiresIn: PLUGIN_SESSION_TTL_MS / 1000, tokens, codeDebtMilli, theme });
}

// The look chosen on the web is kept with the account, so the Studio plugin
// can dress itself the same way.
const APP_THEMES = ["light", "dark", "sea", "forest", "sun"];

async function handleSetTheme(request, env) {
    const uid = await requireAuth(request, env);
    let body = {};
    try { body = await request.json(); } catch (e) { /* empty body */ }
    if (!APP_THEMES.includes(body.theme)) return json({ error: "Unknown theme." }, 400);
    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);
    const res = await fetch(`${firestoreBaseUrl(env)}/users/${uid}?updateMask.fieldPaths=theme`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { theme: { stringValue: body.theme } } })
    });
    if (!res.ok) return json({ error: "Could not save the theme." }, 500);
    return json({ ok: true, theme: body.theme });
}

async function resolveUidFromPluginToken(env, accessToken, pluginToken) {
    const res = await fetch(`${firestoreBaseUrl(env)}/pluginSessions/${encodeURIComponent(pluginToken)}`, {
        headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error("Invalid plugin session");
    const doc = await res.json();
    const expiresAt = parseInt(doc.fields?.expiresAt?.integerValue || "0", 10);
    if (Date.now() > expiresAt) throw new Error("Plugin session expired");
    return doc.fields?.uid?.stringValue;
}

async function handlePluginProxy(request, env, ctx) {
    const { pluginToken, endpoint, body } = await request.json();
    if (!pluginToken || !endpoint) return json({ error: "Missing pluginToken/endpoint" }, 400);

    const ALLOWED = [
        "/chat", "/generate-code", "/enhance", "/generate-ui-lua", "/generate",
        "/agent/step",
        // v2: the agent loop, manifest sync, and memory reset
        "/agent/v2/step", "/agent/v2/sync", "/agent/v2/forget",
        // the agent can now generate 3D models as a tool call
        "/tripo/generate",
        // the studio bridge: ask for work, report on it
        "/studio/poll", "/studio/report",
        // tools: the plugin hands over the work and waits for the page to
        // come back with an answer
        "/studio/tool", "/studio/toolstatus",
    ];
    if (!ALLOWED.includes(endpoint)) return json({ error: "Endpoint not allowed from plugin" }, 400);

    const accessToken = await getGoogleAccessToken(env);
    let uid;
    try { uid = await resolveUidFromPluginToken(env, accessToken, pluginToken); }
    catch (e) { return json({ error: e.message, needsReauth: true }, 401); }

    return await dispatchAuthedForUid(env, uid, endpoint, body || {}, ctx);
}

async function ensurePluginChat(env, accessToken, uid, body, defaultTitle, defaultMode) {
    if (body.chatId) return body.chatId;
    const now = new Date().toISOString();
    const chatRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            fields: {
                title: { stringValue: defaultTitle },
                mode: { stringValue: defaultMode },
                createdAt: { timestampValue: now },
                updatedAt: { timestampValue: now }
            }
        })
    });
    if (chatRes.ok) {
        const chatDoc = await chatRes.json();
        return chatDoc.name.split("/").pop();
    }
    return null;
}

async function dispatchAuthedForUid(env, uid, endpoint, body, ctx) {
    const accessToken = await getGoogleAccessToken(env);
    
    // v2 takes a resolved uid directly, so there is no fake Request to build.
    if (endpoint === "/agent/v2/step")   return await runAgentStepV2(env, uid, body, ctx);
    if (endpoint === "/agent/v2/sync")   return await agent2Sync(env, uid, body);
    if (endpoint === "/agent/v2/forget") return await agent2Forget(env, uid, body);

    if (endpoint === "/studio/poll")     return await studioPoll(env, uid, body);
    if (endpoint === "/studio/report")   return await studioReport(env, uid, body);
    if (endpoint === "/studio/tool")       return await studioToolSubmit(env, uid, body);
    if (endpoint === "/studio/toolstatus") return await studioToolStatus(env, uid, body);

    if (endpoint === "/tripo/generate") {
        return await runTripoForUid(env, uid, body);
    }

    if (endpoint === "/agent/step") {
        return await runAgentStep(env, uid, body, ctx);
    }

    if (endpoint === "/chat") {
        const res = await runChat(env, uid, body);
        if (res.status === 200) {
            try {
                const cloned = res.clone();
                const data = await cloned.json();
                
                const chatId = await ensurePluginChat(env, accessToken, uid, body, "Studio: " + String(body.message || "Chat").slice(0, 30), "chat");
                if (chatId) {
                    data.chatId = chatId;
                    const now = new Date().toISOString();
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            fields: {
                                type: { stringValue: "text" },
                                prompt: { stringValue: String(body.message || "").slice(0, 300) },
                                reply: { stringValue: String(data.reply || "").slice(0, 200_000) },
                                createdAt: { timestampValue: now }
                            }
                        })
                    });
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?updateMask.fieldPaths=updatedAt`, {
                        method: "PATCH",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ fields: { updatedAt: { timestampValue: now } } })
                    });
                    
                    return json(data);
                }
            } catch (e) {
                console.error("Failed to save plugin chat message:", e);
            }
        }
        return res;
    }

    if (endpoint === "/generate-code") {
        const res = await runGenerateCode(env, uid, body);
        if (res.status === 200) {
            try {
                const cloned = res.clone();
                const data = await cloned.json();
                
                const chatTitle = "Studio: " + String(body.instruction || "Generated Script").slice(0, 30);
                const chatId = await ensurePluginChat(env, accessToken, uid, body, chatTitle, "chat");
                
                if (chatId) {
                    data.chatId = chatId;
                    const now = new Date().toISOString();
                    const replyText = (data.description ? data.description + "\n\n" : "") + "```" + (data.language || "lua") + "\n" + data.code + "\n```";
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            fields: {
                                type: { stringValue: "code" },
                                prompt: { stringValue: String(body.instruction || "").slice(0, 300) },
                                reply: { stringValue: replyText.slice(0, 200_000) },
                                language: { stringValue: String(data.language || "lua") },
                                model: { stringValue: String(data.model || "luna").slice(0, 40) },
                                createdAt: { timestampValue: now }
                            }
                        })
                    });
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?updateMask.fieldPaths=updatedAt`, {
                        method: "PATCH",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ fields: { updatedAt: { timestampValue: now } } })
                    });
                    
                    return json(data);
                }
            } catch (e) {
                console.error("Failed to save plugin chat:", e);
            }
        }
        return res;
    }
    
    if (endpoint === "/generate") {
        const res = await runGenerate(env, uid, body, true);
        if (res.status === 200) {
            let data = null;
            let finalResponse = res;
            try {
                const cloned = res.clone();
                data = await cloned.json();
                
                const now = new Date().toISOString();
                const chatTitle = "Studio: Obrazek";
                
                // === ROBLOX UPLOAD START ===
                let uploadedAssetId = null;
                const userRes = await fetch(`${firestoreBaseUrl(env)}/users/${uid}`, {
                    headers: { "Authorization": `Bearer ${accessToken}` }
                });
                
                if (userRes.ok) {
                    const userDoc = await userRes.json();
                    const robloxUserId = userDoc.fields?.robloxUserId?.stringValue;
                    
                    if (robloxUserId) {
                        const robloxToken = await getValidRobloxToken(env, accessToken, uid, robloxUserId);
                        if (robloxToken) {
                            const binary = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
                            const formData = new FormData();
                            
                            formData.append("request", JSON.stringify({
                                assetType: "Decal",
                                displayName: "RoPeak Generated",
                                description: "AI Generated Image",
                                creationContext: { creator: { userId: robloxUserId } }
                            }));
                            formData.append("fileContent", new Blob([binary], { type: data.mimeType }), "image.png");
                            
                            const assetRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
                                method: "POST",
                                headers: { "Authorization": `Bearer ${robloxToken}` },
                                body: formData
                            });
                            
                            if (assetRes.ok) {
                                const assetData = await assetRes.json();
                                if (assetData.done) {
                                    uploadedAssetId = assetData.response?.assetId;
                                } else if (assetData.path) {
                                    let attempts = 0;
                                    while (attempts < 15) {
                                        await new Promise(r => setTimeout(r, 1500));
                                        const opRes = await fetch(`https://apis.roblox.com/assets/v1/${assetData.path}`, {
                                            headers: { "Authorization": `Bearer ${robloxToken}` }
                                        });
                                        if (opRes.ok) {
                                            const opData = await opRes.json();
                                            if (opData.done) {
                                                uploadedAssetId = opData.response?.assetId;
                                                break;
                                            }
                                        } else {
                                            break;
                                        }
                                        attempts++;
                                    }
                                }
                            }
                        }
                    }
                }
                
                if (uploadedAssetId) {
                    data.assetId = uploadedAssetId;
                }
                // === ROBLOX UPLOAD END ===
                
                const chatId = await ensurePluginChat(env, accessToken, uid, body, chatTitle, "text2img");
                
                if (chatId) {
                    data.chatId = chatId;
                    finalResponse = json(data);
                    
                    const MAX_THUMBNAIL_BYTES = 1000000;
                    const imgData = `data:${data.mimeType};base64,${data.base64}`.slice(0, MAX_THUMBNAIL_BYTES);
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            fields: {
                                type: { stringValue: "generation" },
                                prompt: { stringValue: String(body.prompt || "").slice(0, 300) },
                                thumbnail: { stringValue: imgData },
                                mode: { stringValue: "text2img" },
                                createdAt: { timestampValue: now }
                            }
                        })
                    });
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?updateMask.fieldPaths=updatedAt`, {
                        method: "PATCH",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ fields: { updatedAt: { timestampValue: now } } })
                    });
                }
            } catch (e) {
                console.error("Failed to save plugin image chat or upload to Roblox:", e);
            }
            return finalResponse;
        }
        return res;
    }
    
    if (endpoint === "/enhance") {
        return await runEnhance(env, uid, body);
    }
    
    if (endpoint === "/generate-ui-lua") {
        const res = await runGenerateUiLua(env, uid, body);
        if (res.status === 200) {
            try {
                const cloned = res.clone();
                const data = await cloned.json();
                
                const chatTitle = "Studio: UI -> Lua";
                const chatId = await ensurePluginChat(env, accessToken, uid, body, chatTitle, "chat");
                
                if (chatId) {
                    data.chatId = chatId;
                    const now = new Date().toISOString();
                    const replyText = (data.description ? data.description + "\n\n" : "") + "```lua\n" + data.code + "\n```";
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}/messages`, {
                        method: "POST",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({
                            fields: {
                                type: { stringValue: "code" },
                                prompt: { stringValue: String(body.prompt || "UI Screenshot to Lua").slice(0, 300) },
                                reply: { stringValue: replyText.slice(0, 200_000) },
                                language: { stringValue: "lua" },
                                model: { stringValue: "gemini" },
                                createdAt: { timestampValue: now }
                            }
                        })
                    });
                    
                    await fetch(`${firestoreBaseUrl(env)}/users/${uid}/chats/${chatId}?updateMask.fieldPaths=updatedAt`, {
                        method: "PATCH",
                        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ fields: { updatedAt: { timestampValue: now } } })
                    });
                    
                    return json(data);
                }
            } catch(e) {
                 console.error("Failed to save plugin ui-lua chat:", e);
            }
        }
        return res;
    }
    
    return json({ error: "Not implemented" }, 501);
}

// ############################################################################
// ##  RoPeak Agent v2  —  paste this whole block at the END of worker.js    ##
// ############################################################################
//
// Single-file build for editing in the Cloudflare dashboard. Because it lives
// in the same file as worker.js, it calls your existing helpers directly:
//
//     json, requireAuth, firestoreBaseUrl, getGoogleAccessToken,
//     ensureUserDoc, canGenerateCode, chargeForCodeGenerationByCost
//
// Every name it defines is prefixed AGENT2_ / agent2 / *V2 so nothing in your
// current worker.js is shadowed.
//
// Session state lives in Firestore (users/{uid}/agentSessionsV2). The Durable
// Object variant is omitted here: DO lifecycle changes can only be applied by
// `wrangler deploy`, so it is not reachable from the dashboard.
//
// See INSTALL.md for the three edits that activate this block.
// ############################################################################

// ── Model + pricing ─────────────────────────────────────────────────────────
// Verified 26 September 2026. Keep these in ONE place; every cost calculation
// reads from here.
//
// Both tiers are GPT-6 Luna through the Responses API: that is the only way
// OpenAI lets a GPT-6 model think before calling tools (Chat Completions
// takes tools only with reasoning switched off). The tiers differ in how hard
// the model thinks, not in which model it is. Misses are priced at the cache
// write rate when usage does not say how much was written; see
// LUNA_PRICE_CACHE_WRITE_PER_M.
//
// If OpenAI cannot be used for a step, the step is retried on DeepSeek Flash
// (fallback), so a provider outage slows the agent down instead of stopping it.
const AGENT2_MODELS = {
    fast: {
        id: "gpt-6-luna",
        api: "responses",
        base: "https://api.openai.com/v1",
        keyEnv: "OPENAI_API_KEY",
        priceInMiss: 0.10,
        priceInWrite: 0.125,
        priceInHit: 0.01,
        priceOut: 0.50,
        // Most steps are outline/read/patch; a short think is enough.
        effort: "low",
        fallback: "fallback",
    },
    deep: {
        id: "gpt-6-luna",
        api: "responses",
        base: "https://api.openai.com/v1",
        keyEnv: "OPENAI_API_KEY",
        priceInMiss: 0.10,
        priceInWrite: 0.125,
        priceInHit: 0.01,
        priceOut: 0.50,
        // Only after the fast tier has failed twice, which is when the extra
        // reasoning is worth paying for.
        effort: "high",
        fallback: "fallback",
    },
    // Vision only. Used for UI screenshots; never for the agent loop.
    vision: {
        id: "gpt-6-luna",
        base: "https://api.openai.com/v1",
        keyEnv: "OPENAI_API_KEY",
        priceInMiss: 0.10,
        priceInWrite: 0.125,
        priceInHit: 0.01,
        priceOut: 0.50,
    },
    // DeepSeek Flash with thinking off, used only when a Luna step fails.
    // Rates as DeepSeek actually billed them from 13 September 2026, read off
    // the account's usage export (the model bills as "deepseek-flash"). The
    // $0.28 output rate that stood here before was half the real one.
    fallback: {
        id: "deepseek-v4-flash",
        base: "https://api.deepseek.com",
        keyEnv: "DEEPSEEK_API_KEY",
        priceInMiss: 0.15,
        priceInHit: 0.003,
        priceOut: 0.60,
        thinking: "disabled",
    },
};

const AGENT2_CONFIG = {
    margin: 1.15,              // markup over raw API cost
    tokenValueUsd: 27.99 / 1300,
    minMilliTokens: 5,   // mirrors CODE_GEN_MIN_MILLI_TOKENS in worker.js
    maxStepsPerTurn: 32,
    maxParallelCalls: 6,
    foldThresholdChars: 90_000,   // ~24k tokens: fold the history once, not every step
    foldKeepTurns: 2,
    sessionTtlMs: 6 * 60 * 60 * 1000,
    memoryMaxChars: 6_000,
    escalateAfterFailures: 2,
};

// ============================================================================
// SYSTEM PROMPT
// ----------------------------------------------------------------------------
// This block is byte-identical for every user and every session. It is the
// first thing in every request, so it sits at the head of the cache prefix and
// is billed at the cache-hit rate for essentially every call after the first.
// NEVER interpolate anything into it. Per-project text goes in the separate
// memory block below it.
// ============================================================================

const AGENT2_SYSTEM_PROMPT = `You are RoPeak, an autonomous engineering agent embedded in Roblox Studio.

You are not a chatbot that writes code samples. You operate the user's place directly through tools: you read their scripts, search their hierarchy, write and patch files, create and move instances, and verify your own work. Behave like a senior engineer with commit access.

# Operating rules

1. ACT, DON'T NARRATE. If the request is clear, do it. Do not announce what you are about to do before every tool call. A short final summary is enough.

2. READ BEFORE YOU WRITE — BUT CHEAPLY. Context arrives in tiers, cheapest first:
   - The PROJECT MAP is already in your context. Do not call project_map unless you need a branch it does not cover.
   - outline(path) gives you a script's structure (functions, requires, line ranges) for a fraction of the tokens of the source.
   - read(path, from, to) gives you exact lines. Use the line numbers from outline or grep.
   - grep(query) searches across scripts and returns matching lines with context.
   - full_source(path) is a last resort. Prefer outline + read.
   Never call full_source when outline plus one read would answer the question.

3. BATCH EVERYTHING. Every tool accepts plural input. One create with ten instances, not ten creates. One patch_script with four edits, not four calls. Issue independent read calls in parallel in a single response.

4. NEVER REPEAT A READ. If a tool already returned something this session, it is still true unless you changed it. Re-reading the same path is a bug.

5. WRITES ARE PROPOSALS. Any tool that changes the place is collected into a plan and shown to the user before it runs. Write your tool calls as if they execute immediately — the system handles approval. You will receive the results after the user applies them.

6. ASK ONLY WHEN GENUINELY BLOCKED. Use ask() when a wrong guess would waste real work — for example, whether a new system should integrate with existing code or replace it. Do not ask for permission, for confirmation, or for details you can discover with a read. One question maximum, then proceed.

7. REMEMBER WHAT MATTERS. When you learn something structural and durable about this project — the module layout, a naming convention, which script owns which system, a constraint the user stated — call remember(). It persists across sessions and is injected into your context next time. Do not remember transient facts or your own summaries.

8. VERIFY. After a plan is applied, check the result. If an edit failed, read the actual current state before retrying — do not resend the same patch.

9. FINISH CLEANLY. End every turn with prose: what you changed, where, and anything the user must do by hand. Two to five sentences. No headers, no bullet lists unless you changed more than five things.

# Writing Roblox code

Target modern Luau. Use task.* over the deprecated wait/spawn/delay. Use :GetService(). Type-annotate module boundaries. Guard remote handlers with server-side validation — never trust a client argument. Prefer ModuleScripts with a single clear responsibility over long Scripts. Match the surrounding file's existing style, indentation and naming; a patch that looks foreign to the file is a bad patch.

Keep any single generated script under roughly 300 lines. One 700-line script is a single very slow tool call, and every later patch to it is likelier to miss its anchor. Split a large system into one ModuleScript per responsibility plus a thin script that wires them together — that is also faster to generate, because the work spreads across steps instead of one enormous response.

When you patch, the anchor text must be unique in the file. If you are unsure, read more lines and include more context in the anchor. A failed patch costs more than a longer anchor.

# Tone

Direct and technical. English. No filler, no apologies, no "Certainly!". Do not restate the user's request back to them.`;

// ============================================================================
// TOOL SCHEMA
// ----------------------------------------------------------------------------
// Ships in the cached prefix, so verbosity here is nearly free after the first
// call — but it still counts toward the first-call cost, so descriptions are
// written to be information-dense rather than chatty.
// ============================================================================

const AGENT2_READ_TOOLS = new Set([
    "project_map", "find", "grep", "outline", "read", "full_source",
    "inspect", "selection", "console",
]);

const AGENT2_WRITE_TOOLS = new Set([
    "write_script", "patch_script", "create", "set_props",
    "move", "rename", "delete", "duplicate",
]);

const AGENT2_DESTRUCTIVE_TOOLS = new Set(["delete"]);

const AGENT2_META_TOOLS = new Set(["remember", "ask", "generate_image", "generate_model_3d"]);

const pathArg = { type: "string", description: "Dotted path from a service, e.g. ServerScriptService.Systems.Inventory" };

const AGENT2_TOOLS = [
    // ── Reading ────────────────────────────────────────────────────────────
    {
        name: "project_map",
        description: "Hierarchy of a branch. Only needed for branches the project map in your context does not already cover, or when you need more depth.",
        parameters: {
            type: "object",
            properties: {
                root: { type: "string", description: "Service or path to expand. Omit for all services." },
                depth: { type: "integer", description: "Levels to descend, 1-6. Default 3." },
                includeParts: { type: "boolean", description: "Include BaseParts. Default false — geometry is usually noise." },
            },
        },
    },
    {
        name: "find",
        description: "Locate instances by name or partial name across the whole place. Returns paths and class names.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string" },
                kind: { type: "string", description: "Optional class filter, e.g. Script, ModuleScript, RemoteEvent, Model." },
                limit: { type: "integer", description: "Default 20." },
            },
            required: ["query"],
        },
    },
    {
        name: "grep",
        description: "Search script source across the place. Returns path, line number and the matching line with context. This is how you find where something is defined or used.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Literal text, case-insensitive." },
                paths: { type: "array", items: { type: "string" }, description: "Restrict to these scripts. Omit to search everything." },
                context: { type: "integer", description: "Context lines each side. Default 2." },
                limit: { type: "integer", description: "Max matches. Default 25." },
            },
            required: ["query"],
        },
    },
    {
        name: "outline",
        description: "Structural skeleton of one or more scripts: requires, top-level declarations, every function with its signature and line range, and event connections. Roughly 10x cheaper than the source. Start here.",
        parameters: {
            type: "object",
            properties: { paths: { type: "array", items: { type: "string" } } },
            required: ["paths"],
        },
    },
    {
        name: "read",
        description: "Exact line range of a script. Use the line numbers from outline or grep. Requesting more than 200 lines at once is almost always wasteful.",
        parameters: {
            type: "object",
            properties: {
                path: pathArg,
                from: { type: "integer", description: "1-based, inclusive." },
                to: { type: "integer", description: "1-based, inclusive." },
            },
            required: ["path", "from", "to"],
        },
    },
    {
        name: "full_source",
        description: "Entire source of a script. Expensive. Only when you must rewrite the file wholesale or the file is genuinely short.",
        parameters: {
            type: "object",
            properties: { path: pathArg },
            required: ["path"],
        },
    },
    {
        name: "inspect",
        description: "Properties, children and class of any instance. For non-script objects.",
        parameters: {
            type: "object",
            properties: {
                paths: { type: "array", items: { type: "string" } },
                deep: { type: "boolean", description: "Include grandchildren. Default false." },
            },
            required: ["paths"],
        },
    },
    {
        name: "selection",
        description: "What the user currently has selected in Studio. Call this when they say 'this', 'these', 'the selected ones'.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "console",
        description: "Recent Output entries. Use when the user reports a bug or asks you to fix an error.",
        parameters: {
            type: "object",
            properties: {
                severity: { type: "string", description: "error | warning | all. Default error." },
                limit: { type: "integer", description: "Default 15." },
            },
        },
    },

    // ── Writing (collected into a plan) ────────────────────────────────────
    {
        name: "write_script",
        description: "Create a new script, or replace an existing one entirely. Parent folders are created as needed. For changing part of an existing script use patch_script instead — it is far cheaper and safer.",
        parameters: {
            type: "object",
            properties: {
                parent: { type: "string", description: "Parent path, e.g. ServerScriptService.Systems" },
                name: { type: "string" },
                className: { type: "string", description: "Script | LocalScript | ModuleScript" },
                source: { type: "string" },
                overwrite: { type: "boolean", description: "Allow replacing an existing script of the same name. Default false." },
            },
            required: ["parent", "name", "className", "source"],
        },
    },
    {
        name: "patch_script",
        description: "Apply one or more find-and-replace edits to an existing script in a single operation. Each anchor must appear exactly once in the file.",
        parameters: {
            type: "object",
            properties: {
                path: pathArg,
                edits: {
                    type: "array",
                    description: "Applied in order, top to bottom.",
                    items: {
                        type: "object",
                        properties: {
                            mode: { type: "string", description: "replace | insert_after | insert_before | append | prepend" },
                            anchor: { type: "string", description: "Exact existing text to match. Required except for append/prepend." },
                            text: { type: "string", description: "Replacement or inserted text." },
                        },
                        required: ["mode", "text"],
                    },
                },
            },
            required: ["path", "edits"],
        },
    },
    {
        name: "create",
        description: "Create any number of non-script instances in one operation. Always prefer one call with many instances.",
        parameters: {
            type: "object",
            properties: {
                instances: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            className: { type: "string" },
                            parent: { type: "string" },
                            name: { type: "string" },
                            properties: {
                                type: "object",
                                description: "Values accept plain forms: numbers, booleans, strings, [x,y,z] for Vector3, [r,g,b] 0-255 for Color3, [xs,xo,ys,yo] for UDim2, 'Neon' or 'Material.Neon' for enums, and a dotted path for Instance references.",
                            },
                        },
                        required: ["className", "parent"],
                    },
                },
            },
            required: ["instances"],
        },
    },
    {
        name: "set_props",
        description: "Set several properties on several instances in one operation.",
        parameters: {
            type: "object",
            properties: {
                targets: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            path: pathArg,
                            properties: { type: "object" },
                        },
                        required: ["path", "properties"],
                    },
                },
            },
            required: ["targets"],
        },
    },
    {
        name: "move",
        description: "Reparent instances. Use for 'take everything from X and put it in Y'.",
        parameters: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { path: pathArg, into: { type: "string" } },
                        required: ["path", "into"],
                    },
                },
            },
            required: ["items"],
        },
    },
    {
        name: "rename",
        description: "Rename instances.",
        parameters: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { path: pathArg, to: { type: "string" } },
                        required: ["path", "to"],
                    },
                },
            },
            required: ["items"],
        },
    },
    {
        name: "duplicate",
        description: "Clone an instance one or more times into a destination.",
        parameters: {
            type: "object",
            properties: {
                path: pathArg,
                into: { type: "string", description: "Destination parent. Defaults to the original's parent." },
                count: { type: "integer", description: "Default 1." },
                namePattern: { type: "string", description: "Optional, use {i} for the index, e.g. 'Spawn_{i}'." },
            },
            required: ["path"],
        },
    },
    {
        name: "delete",
        description: "Delete instances. Always confirmed by the user regardless of their auto-apply setting.",
        parameters: {
            type: "object",
            properties: { paths: { type: "array", items: { type: "string" } } },
            required: ["paths"],
        },
    },

    // ── Meta ───────────────────────────────────────────────────────────────
    {
        name: "remember",
        description: "Persist a durable fact about this project. Survives across sessions and is injected into your context next time. Use for architecture, conventions, ownership, stated constraints. Not for summaries of what you just did.",
        parameters: {
            type: "object",
            properties: {
                key: { type: "string", description: "Short stable slug, e.g. 'inventory-system' or 'naming-convention'. Reusing a key overwrites it." },
                value: { type: "string", description: "One or two sentences. Be specific and factual." },
            },
            required: ["key", "value"],
        },
    },
    {
        name: "ask",
        description: "Ask the user one blocking question. Only when guessing wrong would waste real work.",
        parameters: {
            type: "object",
            properties: {
                question: { type: "string" },
                options: { type: "array", items: { type: "string" }, description: "2-4 short choices, if the answer is a choice." },
            },
            required: ["question"],
        },
    },
    {
        name: "generate_image",
        description: "Generate a 2D image asset (game icon, gamepass icon, badge, thumbnail banner) and upload it to the user's Roblox assets. Costs the user tokens.",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "Detailed English description of the artwork." },
                kind: { type: "string", description: "icon | thumbnail" },
            },
            required: ["prompt", "kind"],
        },
    },
    {
        name: "generate_model_3d",
        description: "Generate a 3D mesh asset from a text description. Costs the user significant tokens — confirm intent first if ambiguous.",
        parameters: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "English description of a single object: shape, material, style. Not a scene." },
                quality: { type: "string", description: "draft | standard | high. Default standard." },
            },
            required: ["prompt"],
        },
    },
];

const AGENT2_OPENAI_TOOLS = AGENT2_TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// ============================================================================
// SESSION STORE
// ----------------------------------------------------------------------------
// Two backends behind one interface. Durable Objects give strongly-consistent,
// single-digit-ms reads inside a turn; Firestore is the zero-config fallback so
// this ships without touching wrangler.toml.
// ============================================================================


class FirestoreSessionStore {
    constructor(env, accessToken, uid) {
        this.env = env; this.token = accessToken; this.uid = uid;
    }
    _url(id) {
        // Its own collection. v1 stores {fields:{history}} in agentSessions and
        // v2 stores {fields:{state}} — same place, different shapes, and a
        // reader that lands on the wrong one silently restarts from nothing.
        return `${firestoreBaseUrl(this.env)}/users/${this.uid}/agentSessionsV2/${id}`;
    }
    async load(id) {
        try {
            const res = await fetch(this._url(id), { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) return null;
            const doc = await res.json();
            const raw = doc.fields?.state?.stringValue;
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    async save(id, state) {
        const url = `${this._url(id)}?updateMask.fieldPaths=state&updateMask.fieldPaths=updatedAt`;
        await fetch(url, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                fields: {
                    state: { stringValue: JSON.stringify(state) },
                    updatedAt: { timestampValue: new Date().toISOString() },
                },
            }),
        });
    }
}


function makeSessionStore(env, accessToken, uid) {
    return new FirestoreSessionStore(env, accessToken, uid);
}

// ============================================================================
// PROJECT MEMORY
// ----------------------------------------------------------------------------
// One document per (uid, placeId). Holds:
//   manifestHash  — so the plugin only re-uploads the project map when it moved
//   manifest      — the compressed map itself
//   notes         — key -> value facts the agent wrote via remember()
// Rendered into a single stable, sorted block so its bytes do not churn between
// sessions. Churn here would break the cache prefix for every following token.
// ============================================================================

function memoryDocUrl(env, uid, placeId) {
    const key = `p${String(placeId || "unknown").replace(/[^0-9a-zA-Z_-]/g, "")}`;
    return `${firestoreBaseUrl(env)}/users/${uid}/projectMemory/${key}`;
}

async function loadProjectMemory(env, accessToken, uid, placeId) {
    try {
        const res = await fetch(memoryDocUrl(env, uid, placeId), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return { manifestHash: null, manifest: null, notes: {} };
        const doc = await res.json();
        return {
            manifestHash: doc.fields?.manifestHash?.stringValue || null,
            manifest: doc.fields?.manifest?.stringValue
                ? JSON.parse(doc.fields.manifest.stringValue) : null,
            notes: doc.fields?.notes?.stringValue
                ? JSON.parse(doc.fields.notes.stringValue) : {},
        };
    } catch {
        return { manifestHash: null, manifest: null, notes: {} };
    }
}

async function saveProjectMemory(env, accessToken, uid, placeId, mem) {
    const url = memoryDocUrl(env, uid, placeId);
    const body = {
        fields: {
            manifestHash: { stringValue: mem.manifestHash || "" },
            manifest: { stringValue: JSON.stringify(mem.manifest || null) },
            notes: { stringValue: JSON.stringify(mem.notes || {}) },
            updatedAt: { timestampValue: new Date().toISOString() },
        },
    };
    await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// Deterministic rendering. Sorted keys, fixed separators, no timestamps —
// identical input must produce byte-identical output or caching breaks.
function renderMemoryBlock(mem) {
    const parts = [];

    if (mem.manifest) {
        const m = mem.manifest;
        parts.push("# PROJECT MAP");
        if (m.place) parts.push(`Place: ${m.place}`);
        if (m.tree) parts.push(m.tree);
        if (Array.isArray(m.scripts) && m.scripts.length) {
            parts.push("");
            parts.push(`# SCRIPTS (${m.scripts.length})`);
            parts.push("path | class | lines");
            const rows = m.scripts
                .slice()
                .sort((a, b) => String(a.p).localeCompare(String(b.p)))
                .map((s) => `${s.p} | ${s.c} | ${s.n}`);
            parts.push(rows.join("\n"));
        }
        if (Array.isArray(m.notable) && m.notable.length) {
            parts.push("");
            parts.push("# NOTABLE INSTANCES");
            parts.push(m.notable.slice().sort().join("\n"));
        }
    }

    const keys = Object.keys(mem.notes || {}).sort();
    if (keys.length) {
        parts.push("");
        parts.push("# WHAT YOU KNOW ABOUT THIS PROJECT");
        parts.push("These are facts you recorded in earlier sessions. Trust them, but verify before relying on one to make a destructive change.");
        for (const k of keys) parts.push(`- ${k}: ${mem.notes[k]}`);
    }

    if (!parts.length) {
        return "# PROJECT MAP\nNot yet indexed. Call project_map once to orient yourself, then remember() the structure so you do not have to next time.";
    }

    let out = parts.join("\n");
    if (out.length > AGENT2_CONFIG.memoryMaxChars) {
        out = out.slice(0, AGENT2_CONFIG.memoryMaxChars) + "\n… map truncated. Use find/grep for anything not listed.";
    }
    return out;
}

// ============================================================================
// HISTORY
// ----------------------------------------------------------------------------
// Append-only. The one exception is `fold`, which rewrites the old part of the
// history in a single deliberate operation when it gets too big. Between folds
// the byte prefix is stable, which is what makes cache hits possible.
// ============================================================================

function estimateChars(history) {
    let n = 0;
    for (const m of history) {
        n += (m.content ? String(m.content).length : 0);
        if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
    }
    return n;
}

function digestToolResult(name, content) {
    let obj;
    try { obj = JSON.parse(content); } catch { return String(content).slice(0, 200); }

    if (obj && obj.error) return `error: ${String(obj.error).slice(0, 160)}`;
    if (Array.isArray(obj?.matches)) return `${obj.matches.length} match(es) in ${obj.path || "?"}`;
    if (Array.isArray(obj?.results)) return `${obj.results.length} result(s)`;
    if (Array.isArray(obj?.outlines)) {
        return obj.outlines.map((o) => `${o.path}: ${(o.symbols || []).length} symbols`).join("; ").slice(0, 300);
    }
    if (obj?.source || obj?.lines) return `read ${obj.path || "?"} (${obj.from ?? "?"}-${obj.to ?? "?"})`;
    if (obj?.applied) return `applied: ${JSON.stringify(obj.applied).slice(0, 200)}`;
    if (obj?.ok === true) return "ok";
    return JSON.stringify(obj).slice(0, 200);
}

// Collapse everything except the last N assistant turns into short digests.
// Called at most once or twice per long turn, never per step.
// keepTurns 0 is a HARD fold: nothing structural survives, only a prose
// digest. Used to repair a history the provider refuses to replay.
function foldHistory(history, keepTurns) {
    if (keepTurns === undefined) keepTurns = AGENT2_CONFIG.foldKeepTurns;

    let boundary = history.length;
    if (keepTurns > 0) {
        let turns = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "assistant") {
                turns++;
                if (turns > keepTurns) { boundary = i; break; }
            }
        }
        if (boundary <= 1) return history;
    }

    const head = history.slice(0, boundary);
    const tail = history.slice(boundary);

    const digest = [];
    for (const m of head) {
        if (m.role === "user") digest.push(`USER: ${String(m.content).slice(0, 400)}`);
        else if (m.role === "assistant") {
            // Reasoning traces are deliberately not carried into the digest:
            // they are scratch work for one turn, and they are the single
            // largest thing in the history.
            if (m.content) digest.push(`YOU: ${String(m.content).slice(0, 300)}`);
            for (const tc of m.tool_calls || []) {
                digest.push(`  called ${tc.function.name}(${String(tc.function.arguments || "").slice(0, 160)})`);
            }
        } else if (m.role === "tool") {
            digest.push(`  -> ${digestToolResult(m.name, m.content)}`);
        }
    }

    // Deliberately no synthetic assistant turn. In thinking mode with tools an
    // assistant message carries required baggage (reasoning_content, paired
    // tool results); inventing one manufactures the very error this function
    // exists to clean up.
    return [
        {
            role: "user",
            content:
                "[Earlier in this session — condensed. Full detail is gone; do not assume anything not listed here.]\n" +
                digest.join("\n").slice(0, 12_000),
        },
        ...tail,
    ];
}

// Builds the message array actually sent to the model.
//
// Structural guarantee: every tool_call gets exactly one tool message, emitted
// immediately after its parent assistant message, and nothing else can appear
// in a tool slot. This is not defensive tidying — a tool message whose parent
// has no matching tool_calls is a hard 400 from the provider, and the previous
// approach (delete the parent's tool_calls, leave already-emitted tool messages
// behind) produced exactly that whenever a plan came back alongside reads.
function toWireMessages(history) {
    const resultsById = new Map();
    for (const msg of history) {
        if (msg.role === "tool" && msg.tool_call_id) {
            resultsById.set(
                msg.tool_call_id,
                typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
            );
        }
    }

    const out = [];
    for (const msg of history) {
        // Tool messages are emitted with their parent below, never standalone.
        if (msg.role === "tool") continue;

        if (msg.role !== "assistant") {
            out.push({ role: msg.role, content: String(msg.content ?? "") });
            continue;
        }

        const m = { role: "assistant", content: msg.content ?? "" };
        if (msg.tool_calls?.length) m.tool_calls = msg.tool_calls;
        // Required by DeepSeek whenever tools are in play (see above).
        if (msg.reasoning_content) m.reasoning_content = msg.reasoning_content;
        if (!m.tool_calls && !m.content) m.content = "...";
        out.push(m);

        for (const tc of msg.tool_calls || []) {
            out.push({
                role: "tool",
                tool_call_id: tc.id,
                content: resultsById.get(tc.id) ?? JSON.stringify({
                    ok: false,
                    error: "No result recorded for this call - the turn was interrupted. "
                        + "Do not assume it ran; check the current state before retrying.",
                }),
            });
        }
    }
    return out;
}

// ============================================================================
// WRITE-ARG VALIDATION
// ----------------------------------------------------------------------------
// Models occasionally emit a write call with its required array missing or
// empty. Putting that into a plan shows the user a card for an operation that
// cannot possibly succeed, and they have to click Apply just to watch it fail.
// Catch it here and hand the model a corrective error in the same turn instead.
// ============================================================================

const AGENT2_WRITE_VALIDATORS = {
    write_script: (a) =>
        !a.parent ? "parent is required (a dotted path, e.g. ServerScriptService.Systems)"
        : !a.name ? "name is required"
        : !a.className ? "className is required: Script, LocalScript or ModuleScript"
        : typeof a.source !== "string" ? "source must be a string"
        : null,
    patch_script: (a) =>
        !a.path ? "path is required"
        : !Array.isArray(a.edits) || a.edits.length === 0
            ? "edits must be a non-empty array of { mode, anchor, text }"
        : null,
    create: (a) =>
        !Array.isArray(a.instances) || a.instances.length === 0
            ? "instances must be a non-empty array of { className, parent, name?, properties? }"
            : null,
    set_props: (a) =>
        !Array.isArray(a.targets) || a.targets.length === 0
            ? "targets must be a non-empty array of { path, properties }"
            : null,
    move: (a) =>
        !Array.isArray(a.items) || a.items.length === 0
            ? "items must be a non-empty array of { path, into }" : null,
    rename: (a) =>
        !Array.isArray(a.items) || a.items.length === 0
            ? "items must be a non-empty array of { path, to }" : null,
    delete: (a) =>
        !Array.isArray(a.paths) || a.paths.length === 0
            ? "paths must be a non-empty array of dotted paths" : null,
    duplicate: (a) => (!a.path ? "path is required" : null),
};

// ============================================================================
// MODEL CALL
// ============================================================================

async function agent2CallModel(env, tier, messages, opts = {}) {
    const cfg = AGENT2_MODELS[tier] || AGENT2_MODELS.fast;
    try {
        return await agent2CallOnce(env, tier, cfg, messages, opts);
    } catch (e) {
        const fb = cfg.fallback && AGENT2_MODELS[cfg.fallback];
        // A 400 about the history's shape is the caller's to repair (it
        // folds the history and retries); anything else goes to the fallback.
        const historyShape = e.status === 400
            && /reasoning_content|tool_call|must be a response|No tool output found/i.test(e.body || e.message || "");
        if (!fb || historyShape || !env[fb.keyEnv]) throw e;
        console.error("agent2: " + cfg.id + " failed (" + (e.status || "error") + "), using " + fb.id + ": " +
            String(e.body || e.message || "").slice(0, 300));
        return await agent2CallOnce(env, cfg.fallback, fb, messages, opts);
    }
}

async function agent2CallOnce(env, tier, cfg, messages, opts) {
    const key = env[cfg.keyEnv];
    if (!key) throw new Error(`Missing ${cfg.keyEnv}`);

    const modelId = env[`${tier.toUpperCase()}_MODEL_ID`] || cfg.id;
    const isGpt = /^gpt-/i.test(modelId);

    let url, body;
    if (cfg.api === "responses") {
        url = `${cfg.base}/responses`;
        body = agent2ResponsesBody(modelId, messages, opts, env.AGENT_EFFORT || cfg.effort);
    } else {
        url = `${cfg.base}/chat/completions`;
        // GPT models reject any temperature but the default, and take the
        // output cap as max_completion_tokens.
        body = {
            model: modelId,
            messages,
            ...(isGpt ? {} : { temperature: opts.temperature ?? 0.2 }),
            ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice || "auto" } : {}),
            ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
            ...(opts.maxTokens ? (isGpt ? { max_completion_tokens: opts.maxTokens } : { max_tokens: opts.maxTokens }) : {}),
        };
        if (isGpt && opts.tools) body.reasoning_effort = "none";
        // reasoning_content is DeepSeek's thinking-mode baggage. OpenAI does
        // not know the field, and DeepSeek with thinking off does not want it.
        if (isGpt || cfg.thinking === "disabled") {
            body.messages = messages.map((m) => {
                if (m.reasoning_content === undefined) return m;
                const { reasoning_content, ...rest } = m;
                return rest;
            });
        }
        if (cfg.thinking === "disabled") {
            body.thinking = { type: "disabled" };
        } else if (cfg.effort && !isGpt) {
            body.thinking = { type: "enabled", reasoning_effort: env.AGENT_EFFORT || cfg.effort };
        }
    }

    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        last = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
        });
        if (last.ok) break;
        if (last.status !== 429 && last.status !== 500 && last.status !== 503) break;
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }

    if (!last.ok) {
        const text = await last.text();
        const err = new Error(`Model ${modelId} returned ${last.status}: ${text.slice(0, 400)}`);
        err.status = last.status;
        err.body = text;
        throw err;
    }

    let data = await last.json();
    if (cfg.api === "responses") data = agent2ChatShapeFromResponses(data);
    return { data, cost: agent2ComputeCost(cfg, data.usage), usage: data.usage || {} };
}

// The agent keeps its history as Chat Completions messages (that is what is
// stored per session). The Responses API wants items instead: messages,
// function_call and function_call_output. These two functions translate one
// way on the way out and the other way on the way back, so nothing else in
// the agent has to know which API answered.
function agent2ResponsesBody(model, messages, opts, effort) {
    const input = [];
    for (const m of messages) {
        if (m.role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: m.tool_call_id,
                output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
            });
            continue;
        }
        if (m.role === "assistant") {
            const text = typeof m.content === "string" ? m.content : "";
            if (text && text !== "...") input.push({ role: "assistant", content: text });
            for (const tc of m.tool_calls || []) {
                input.push({
                    type: "function_call",
                    call_id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments || "{}",
                });
            }
            continue;
        }
        if (Array.isArray(m.content)) {
            input.push({
                role: m.role,
                content: m.content.map((p) => p.type === "image_url"
                    ? { type: "input_image", image_url: p.image_url?.url || p.image_url }
                    : { type: "input_text", text: String(p.text ?? "") }),
            });
        } else {
            input.push({ role: m.role, content: String(m.content ?? "") });
        }
    }

    const body = { model, input, store: false, reasoning: { effort } };
    if (opts.tools) {
        body.tools = opts.tools.map((t) => ({
            type: "function",
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            // The schemas here are written loosely (optional fields, no
            // additionalProperties: false); strict mode would reject them.
            strict: false,
        }));
        body.tool_choice = opts.toolChoice || "auto";
    }
    if (opts.jsonMode) body.text = { format: { type: "json_object" } };
    if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
    return body;
}

function agent2ChatShapeFromResponses(data) {
    let text = "";
    const toolCalls = [];
    for (const item of data.output || []) {
        if (item.type === "message") {
            for (const c of item.content || []) {
                if (c.type === "output_text") text += c.text || "";
                else if (c.type === "refusal") text += c.refusal || "";
            }
        } else if (item.type === "function_call") {
            toolCalls.push({
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: item.arguments || "{}" },
            });
        }
    }
    const u = data.usage || {};
    const message = { role: "assistant", content: text || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
        id: data.id,
        choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
        usage: {
            prompt_tokens: u.input_tokens || 0,
            completion_tokens: u.output_tokens || 0,
            prompt_tokens_details: {
                cached_tokens: u.input_tokens_details?.cached_tokens || 0,
                ...(u.input_tokens_details?.cache_write_tokens !== undefined
                    ? { cache_write_tokens: u.input_tokens_details.cache_write_tokens } : {}),
            },
            completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0 },
        },
    };
}

// Real cost from real cache accounting. DeepSeek reports a hit/miss split and
// OpenAI reports cached_tokens; if a provider omits both, everything is billed
// at the miss rate, which never undercharges.
function agent2ComputeCost(cfg, usage) {
    if (!usage) return 0;
    const out = usage.completion_tokens || 0;
    const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const total = usage.prompt_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, total - hit);
    // OpenAI bills cache writes at 1.25x input. With the count missing, every
    // miss is taken to be a write, which never undercharges.
    const reported = usage.prompt_tokens_details?.cache_write_tokens;
    const written = cfg.priceInWrite
        ? (reported === undefined ? miss : Math.min(miss, reported || 0))
        : 0;

    const raw =
        ((miss - written) / 1e6) * cfg.priceInMiss +
        (written / 1e6) * (cfg.priceInWrite || 0) +
        (hit / 1e6) * cfg.priceInHit +
        (out / 1e6) * cfg.priceOut;

    return raw * AGENT2_CONFIG.margin;
}

// ============================================================================
// MAIN STEP HANDLER
// ============================================================================

/**
 * One step of an agent turn. Called by handleAgentStepV2 (direct HTTP) and
 * by dispatchAuthedForUid (through the plugin proxy).
 */
async function runAgentStepV2(env, uid, body, ctx) {
    const accessToken = await getGoogleAccessToken(env);
    await ensureUserDoc(env, uid, accessToken);

    if (!(await canGenerateCode(env, accessToken, uid))) {
        return json({ error: "Out of tokens.", code: "NO_TOKENS" }, 402);
    }

    const placeId = body.placeId || "unknown";
    const store = makeSessionStore(env, accessToken, uid);

    // ── Project memory ─────────────────────────────────────────────────────
    const memory = await loadProjectMemory(env, accessToken, uid, placeId);
    let memoryDirty = false;

    // The plugin sends the manifest only when its hash changed. That means the
    // memory block — and therefore the cache prefix — normally stays identical
    // across every step and every session.
    if (body.manifest && body.manifestHash && body.manifestHash !== memory.manifestHash) {
        memory.manifest = body.manifest;
        memory.manifestHash = body.manifestHash;
        memoryDirty = true;
    }

    // ── Session ────────────────────────────────────────────────────────────
    let sessionId = body.sessionId;
    // SESSION_SCHEMA describes the shape of the stored history. Bump it when a
    // change makes older histories unreplayable; they then get folded into
    // prose on first contact instead of being resent and rejected.
    //
    // v2 added reasoning_content. A session started before that fix holds
    // assistant messages with tool_calls and no reasoning, which DeepSeek
    // refuses outright — and would keep refusing for the session's whole
    // six-hour life, which is exactly what happened in testing.
    const SESSION_SCHEMA = 2;

    let session = sessionId ? await store.load(sessionId) : null;
    if (!session) {
        sessionId = crypto.randomUUID();
        session = {
            v: SESSION_SCHEMA,
            history: [], steps: 0, failures: 0, tier: "fast", createdAt: Date.now(),
        };
    } else if (session.v !== SESSION_SCHEMA) {
        session.history = foldHistory(session.history || [], 0);
        session.pendingPlan = null;
        session.v = SESSION_SCHEMA;
    }

    // ── Append this step's input ───────────────────────────────────────────
    if (body.message) {
        session.history.push({ role: "user", content: body.message });
        session.steps = 0;
        session.failures = 0;
        session.metaLoops = 0;
        session.tier = "fast";
    }

    for (const r of body.toolResults || []) {
        const content = typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? {});
        session.history.push({
            role: "tool",
            tool_call_id: r.id,
            name: r.name,
            content,
        });
        if (r.result && r.result.error) session.failures++;
        else session.failures = 0;
    }

    // Plan results arrive keyed by the tool_call id each operation came from,
    // so every write gets a response to its OWN call. Keying this by a separate
    // plan id orphaned the message and 400'd the request after it.
    if (body.planOutcome) {
        const byId = body.planOutcome.results || {};
        for (const op of session.pendingPlan || []) {
            const r = byId[op.id] ?? {
                ok: false,
                error: "The plugin reported no result for this operation.",
            };
            session.history.push({
                role: "tool",
                tool_call_id: op.id,
                name: op.name,
                content: JSON.stringify(r),
            });
            // A user declining a plan is not the model failing. Counting it as
            // one would escalate the session to the slower, costlier deep tier
            // because somebody clicked Skip.
            if (r.rejected) session.failures = 0;
            else if (r.error || r.ok === false) session.failures++;
            else session.failures = 0;
        }
        session.pendingPlan = null;
    }

    session.steps++;
    if (session.steps > AGENT2_CONFIG.maxStepsPerTurn) {
        await store.save(sessionId, session);
        return json({
            type: "final",
            sessionId,
            reply: "I hit the step limit for one turn. Tell me which part to continue with and I'll pick it up from there.",
        });
    }

    // ── Fold if oversized ──────────────────────────────────────────────────
    if (estimateChars(session.history) > AGENT2_CONFIG.foldThresholdChars) {
        session.history = foldHistory(session.history);
    }

    // ── Escalate on repeated failure ───────────────────────────────────────
    if (session.failures >= AGENT2_CONFIG.escalateAfterFailures && session.tier === "fast") {
        session.tier = "deep";
    }

    // ── Build the request. Order is load-bearing: the two stable system
    //    blocks come first so they form the cached prefix. ─────────────────
    const messages = [
        { role: "system", content: AGENT2_SYSTEM_PROMPT },
        { role: "system", content: renderMemoryBlock(memory) },
        ...toWireMessages(session.history),
    ];

    const callOpts = { tools: AGENT2_OPENAI_TOOLS, temperature: 0.2 };

    let result;
    try {
        result = await agent2CallModel(env, session.tier, messages, callOpts);
    } catch (e) {
        // A 400 naming reasoning_content or tool pairing means the stored
        // history is shaped in a way this provider will not replay. Resending
        // it unchanged fails forever, so collapse it to prose and try once
        // more: the turn loses structural detail but finishes.
        const historyRejected = e.status === 400
            && /reasoning_content|tool_call|must be a response/i.test(e.body || e.message || "");

        if (!historyRejected) {
            return json({ error: friendlyModelError(e), code: "MODEL" }, e.status || 502);
        }

        session.history = foldHistory(session.history, 0);
        session.pendingPlan = null;
        try {
            result = await agent2CallModel(env, session.tier, [
                { role: "system", content: AGENT2_SYSTEM_PROMPT },
                { role: "system", content: renderMemoryBlock(memory) },
                ...toWireMessages(session.history),
            ], callOpts);
        } catch (e2) {
            await store.save(sessionId, session);
            return json({ error: friendlyModelError(e2), code: "MODEL" }, e2.status || 502);
        }
    }

    const choice = result.data.choices?.[0]?.message;
    if (!choice) return json({ error: "Empty response from model." }, 502);

    // Bill in the background — never make the user wait on Firestore.
    const charge = chargeForCodeGenerationByCost(env, accessToken, uid, result.cost)
        .catch((e) => console.error("charge failed", e));
    if (ctx) ctx.waitUntil(charge);

    // Keep only the fields the API accepts back; providers attach extras
    // (annotations, logprobs) that 400 on the next round trip.
    //
    // reasoning_content is the exception and it is NOT optional: in a
    // tool-calling conversation DeepSeek requires every previous turn's
    // reasoning to be echoed, and rejects the request outright if it is
    // missing. Dropping it is what produced
    // "The `reasoning_content` in the thinking mode must be passed back".
    const assistantMsg = { role: "assistant", content: choice.content || "" };
    if (choice.tool_calls?.length) assistantMsg.tool_calls = choice.tool_calls;
    if (choice.reasoning_content) assistantMsg.reasoning_content = choice.reasoning_content;
    session.history.push(assistantMsg);

    // ── No tools -> the turn is done ───────────────────────────────────────
    if (!choice.tool_calls?.length) {
        await store.save(sessionId, session);
        if (memoryDirty) {
            const p = saveProjectMemory(env, accessToken, uid, placeId, memory);
            if (ctx) ctx.waitUntil(p); else await p;
        }
        return json({
            type: "final",
            sessionId,
            reply: choice.content || "Done.",
            thinking: thinkingSummary(choice),
            step: session.steps,
            usage: usageSummary(result),
        });
    }

    // ── Partition the calls ────────────────────────────────────────────────
    const reads = [];
    const writes = [];
    const metas = [];
    // Results we can answer server-side: remember(), and rejected bad writes.
    const metaResults = [];

    for (const tc of choice.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }
        const call = { id: tc.id, name: tc.function.name, args };

        if (AGENT2_WRITE_TOOLS.has(call.name)) {
            const problem = AGENT2_WRITE_VALIDATORS[call.name]?.(call.args);
            if (problem) {
                metaResults.push({
                    id: call.id,
                    name: call.name,
                    result: { ok: false, error: `${call.name}: ${problem}` },
                });
            } else {
                writes.push(call);
            }
        }
        else if (AGENT2_META_TOOLS.has(call.name)) metas.push(call);
        else if (AGENT2_READ_TOOLS.has(call.name)) reads.push(call);
        else reads.push(call); // unknown -> let the plugin report it back as an error
    }

    // ── Handle meta tools here on the server ───────────────────────────────
    for (const m of metas) {
        if (m.name === "remember") {
            const key = String(m.args.key || "").slice(0, 60).trim();
            const value = String(m.args.value || "").slice(0, 400).trim();
            if (key && value) {
                memory.notes = memory.notes || {};
                memory.notes[key] = value;
                // Keep the block bounded: drop the oldest keys past 40.
                const keys = Object.keys(memory.notes);
                if (keys.length > 40) delete memory.notes[keys[0]];
                memoryDirty = true;
            }
            metaResults.push({ id: m.id, name: m.name, result: { ok: true, remembered: key } });
        } else if (m.name === "ask") {
            await store.save(sessionId, session);
            if (memoryDirty) {
                const p = saveProjectMemory(env, accessToken, uid, placeId, memory);
                if (ctx) ctx.waitUntil(p); else await p;
            }
            return json({
                type: "question",
                sessionId,
                toolCallId: m.id,
                thinking: thinkingSummary(choice),
                step: session.steps,
                say: choice.content || "",
                question: String(m.args.question || ""),
                options: Array.isArray(m.args.options) ? m.args.options.slice(0, 4) : [],
            });
        } else {
            // generate_image / generate_model_3d — the plugin owns these,
            // because it needs to charge tokens and insert the asset.
            reads.push(m);
        }
    }

    // remember() results go straight back into history; no round trip needed.
    for (const mr of metaResults) {
        session.history.push({
            role: "tool", tool_call_id: mr.id, name: mr.name,
            content: JSON.stringify(mr.result),
        });
    }

    // The plan's tool_call ids must survive the round trip, or the results come
    // back unattributable.
    session.pendingPlan = writes.map((w) => ({ id: w.id, name: w.name }));

    await store.save(sessionId, session);
    if (memoryDirty) {
        const p = saveProjectMemory(env, accessToken, uid, placeId, memory);
        if (ctx) ctx.waitUntil(p); else await p;
    }

    // Nothing left for the plugin to run? Loop again here instead of paying a
    // full Studio<->Worker round trip for a no-op.
    //
    // Bounded separately from `steps`: a model that only ever calls remember()
    // would otherwise spin all the way to the step limit, and every spin is a
    // real model call, a real charge, and a subrequest against the Worker's
    // own limit.
    if (!reads.length && !writes.length && metaResults.length) {
        session.metaLoops = (session.metaLoops || 0) + 1;
        if (session.metaLoops > 3) {
            session.metaLoops = 0;
            await store.save(sessionId, session);
            return json({
                type: "final",
                sessionId,
                reply: choice.content
                    || "Noted. Tell me what you'd like me to do with that.",
                usage: usageSummary(result),
            });
        }
        await store.save(sessionId, session);
        return await runAgentStepV2(env, uid, { sessionId, placeId }, ctx);
    }

    session.metaLoops = 0;

    // ── A plan is pending -> the plugin renders it for approval ────────────
    if (writes.length) {
        return json({
            type: "plan",
            sessionId,
            say: choice.content || "",
            thinking: thinkingSummary(choice),
            step: session.steps,
            reads: reads.slice(0, AGENT2_CONFIG.maxParallelCalls),
            plan: {
                id: crypto.randomUUID(),
                title: planTitle(writes),
                requiresConfirm: writes.some((w) => AGENT2_DESTRUCTIVE_TOOLS.has(w.name)),
                ops: writes,
            },
            usage: usageSummary(result),
        });
    }

    // ── Pure reads -> execute and come straight back ───────────────────────
    return json({
        type: "tools",
        sessionId,
        say: choice.content || "",
        thinking: thinkingSummary(choice),
        step: session.steps,
        calls: reads.slice(0, AGENT2_CONFIG.maxParallelCalls),
        usage: usageSummary(result),
    });
}

// Milli-tokens this step will actually cost the user.
//
// Must agree with chargeForCodeGenerationByCost. When this file is pasted into
// worker.js those constants are right here in scope, so we use the real ones
// and there is nothing to keep in sync; the AGENT_CONFIG values are only a
// fallback for the standalone module build.
function agent2MilliCharge(costUsd) {
    const perToken = typeof TOKEN_VALUE_USD !== "undefined"
        ? TOKEN_VALUE_USD : AGENT2_CONFIG.tokenValueUsd;
    const floor = typeof CODE_GEN_MIN_MILLI_TOKENS !== "undefined"
        ? CODE_GEN_MIN_MILLI_TOKENS : AGENT2_CONFIG.minMilliTokens;
    return Math.max(floor, Math.ceil((costUsd / perToken) * 1000));
}

// The panel was showing users raw provider JSON. Say what happened instead.
function friendlyModelError(e) {
    const body = String(e.body || e.message || "");
    if (/reasoning_content/i.test(body)) {
        return "The conversation history reached a state the model rejected. "
            + "I've reset it — send your message again.";
    }
    if (e.status === 429) return "The model is rate limited right now. Try again in a moment.";
    if (e.status === 401 || e.status === 403) return "The model API key was rejected. Check OPENAI_API_KEY (and DEEPSEEK_API_KEY, the fallback).";
    if (e.status >= 500) return "The model provider is having trouble. Try again shortly.";
    if (/context length|too long|max.*token/i.test(body)) {
        return "This turn outgrew the model's context window. Start a new conversation or narrow the request.";
    }
    return "The model rejected this request: " + body.slice(0, 200);
}

// A one-line, human-readable trace of what the model was working through on
// this step.
//
// The plugin cannot narrate a model call while it is in flight — Roblox's
// HttpService blocks until the response is complete, so there is no stream to
// read. What it CAN do is show, the moment a step lands, what the model was
// actually reasoning about. Over a long turn that turns a silent timer into a
// visible train of thought.
function thinkingSummary(choice) {
    const raw = String(choice?.reasoning_content || "").trim();
    if (!raw) return null;

    // Reasoning traces open with the framing sentence, which is the part that
    // states intent. Later sentences are working-out.
    const flat = raw.replace(/\s+/g, " ");
    const sentences = flat.split(/(?<=[.!?])\s+/);

    let out = "";
    for (const s of sentences) {
        if (out && (out.length + s.length) > 170) break;
        out += (out ? " " : "") + s;
        if (out.length > 90) break;
    }
    out = (out || flat).slice(0, 190).trim();
    return out.length < 8 ? null : out;
}

function usageSummary(result) {
    const u = result.usage || {};
    const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
        in: u.prompt_tokens || 0,
        cached: hit,
        out: u.completion_tokens || 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
        // 8dp: a single step lands around 1e-5 USD, and the plugin sums these.
        usd: Number(result.cost.toFixed(8)),
        // Lets the plugin move the token meter live instead of waiting for the
        // next account refresh to notice a whole token disappeared.
        milli: agent2MilliCharge(result.cost),
    };
}

function planTitle(writes) {
    const counts = {};
    for (const w of writes) counts[w.name] = (counts[w.name] || 0) + itemCount(w);
    const parts = Object.entries(counts).map(([k, n]) => `${AGENT2_VERB[k] || k} ${n}`);
    return parts.join(", ");
}

const AGENT2_VERB = {
    write_script: "write script",
    patch_script: "patch",
    create: "create",
    set_props: "set properties on",
    move: "move",
    rename: "rename",
    delete: "delete",
    duplicate: "duplicate",
};

function itemCount(w) {
    const a = w.args || {};
    if (Array.isArray(a.instances)) return a.instances.length;
    if (Array.isArray(a.items)) return a.items.length;
    if (Array.isArray(a.paths)) return a.paths.length;
    if (Array.isArray(a.targets)) return a.targets.length;
    if (Array.isArray(a.edits)) return a.edits.length;
    return 1;
}

// ============================================================================
// ENTRY POINTS
// ----------------------------------------------------------------------------
// Two layers on purpose. The agent2* functions take a resolved uid, so the
// plugin proxy (dispatchAuthedForUid) can call them directly without faking a
// Request. The handle* wrappers add Firebase auth for direct HTTP callers
// (the web app).
// ==========================================================================

// Tells the plugin whether the server already holds this place's manifest, so
// the first message of a session isn't inflated by a map it already has.
async function agent2Sync(env, uid, body) {
    const accessToken = await getGoogleAccessToken(env);
    const mem = await loadProjectMemory(env, accessToken, uid, body.placeId);
    return json({
        needsManifest: !mem.manifestHash || mem.manifestHash !== body.manifestHash,
        knownNotes: Object.keys(mem.notes || {}).length,
    });
}

// Clears a project's learned memory (the "Forget everything" button).
async function agent2Forget(env, uid, body) {
    const accessToken = await getGoogleAccessToken(env);
    await saveProjectMemory(env, accessToken, uid, body.placeId,
        { manifestHash: null, manifest: null, notes: {} });
    return json({ ok: true });
}

async function handleAgentStepV2(request, env, ctx) {
    const uid = await requireAuth(request, env);
    return await runAgentStepV2(env, uid, await request.json(), ctx);
}

async function handleAgentSyncV2(request, env) {
    const uid = await requireAuth(request, env);
    return await agent2Sync(env, uid, await request.json());
}

async function handleAgentForgetV2(request, env) {
    const uid = await requireAuth(request, env);
    return await agent2Forget(env, uid, await request.json());
}


