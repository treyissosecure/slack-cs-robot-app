const { App, ExpressReceiver, LogLevel } = require("@slack/bolt");
const axios = require("axios");
const express = require("express");
const crypto = require("crypto");

// ==============================
// CONFIG
// ==============================
const ZAPIER_WEBHOOK_URL =
  process.env.ZAPIER_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/25767132/ug29zll/";

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// HubSpot private app token (needed for /hubnote v2 dynamic lookups)
const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

// Hubnote Zapier webhooks
const ZAPIER_HUBNOTE_WEBHOOK_URL = process.env.ZAPIER_HUBNOTE_WEBHOOK_URL || "";
const ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL =
  process.env.ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL || "";

// Optional callback auth header check
const ZAPIER_HUBNOTE_SECRET = process.env.ZAPIER_HUBNOTE_SECRET || "";

// Monday labels (must match exactly)
const STATUS_LABELS = [
  "Not Started",
  "Working on it",
  "Blocked",
  "Pending Review",
  "Done",
];
const PRIORITY_LABELS = ["Low", "Medium", "High"];

function toStaticOptions(labels) {
  return labels.map((label) => ({
    text: { type: "plain_text", text: label },
    value: label,
  }));
}

// ==============================
// SIMPLE IN-MEMORY CACHE (stability upgrade)
// ==============================
const CACHE_MS = 60 * 1000; // 60 seconds
const cache = {
  boards: { at: 0, options: [] }, // only used when search is empty
  groupsByBoard: new Map(), // boardId -> { at, options } (only when search is empty)
};

// ==============================
// SLACK RECEIVER (split endpoints)
// ==============================
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
    actions: "/slack/interactions", // also used as options load URL
  },
});

// Basic request logging (keep while debugging; you can remove later)
receiver.app.use((req, res, next) => {
  console.log(
    "[REQ]",
    req.method,
    req.originalUrl,
    "CT:",
    req.headers["content-type"]
  );
  next();
});

// Health check
receiver.app.get("/", (req, res) => res.status(200).send("OK"));

// ==============================
// ✅ NEW: Middleware endpoint (REAL)
// POST /api/hubnote/create
// Creates a HubSpot note and associates it to a Ticket or Deal
// ==============================

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

// Optional: protect this endpoint (recommended). If set, Zapier must send header x-zapier-secret
const ZAPIER_HUBNOTE_SECRET = process.env.ZAPIER_HUBNOTE_SECRET || "";

function hsPlural(type) {
  return type === "deal" ? "deals" : "tickets";
}

function buildHubspotNoteBody(noteTitle, noteBody) {
  const title = (noteTitle || "").trim();
  const body = (noteBody || "").trim();

  // HubSpot Notes UI doesn't reliably display a separate title,
  // so we embed the title at the top for consistent UX.
  if (title && body) return `**${title}**\n\n${body}`;
  if (title && !body) return `**${title}**`;
  return body;
}

async function hubspotRequest(method, path, body) {
  if (!HUBSPOT_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

  const url = `https://api.hubapi.com${path}`;
  const headers = {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const config = {
    method,
    url,
    headers,
    timeout: 20000,
  };

  if (body !== undefined) config.data = body;

  const res = await axios(config);
  return res.data;
}

// Cache association type ids (HubSpot returns them via labels endpoint)
const HS_ASSOC_CACHE_MS = 60 * 60 * 1000; // 1 hour
const hsAssocCache = {
  deal: { at: 0, associationTypeId: null },
  ticket: { at: 0, associationTypeId: null },
};

async function hsGetAssociationTypeIdForNote(toType /* "deal"|"ticket" */) {
  const cached = hsAssocCache[toType];
  const now = Date.now();
  if (cached?.associationTypeId && now - cached.at < HS_ASSOC_CACHE_MS) {
    return cached.associationTypeId;
  }

  const toPlural = hsPlural(toType);

  // HubSpot: GET /crm/v4/objects/notes/{toPlural}/labels
  const data = await hubspotRequest("GET", `/crm/v4/objects/notes/${toPlural}/labels`);
  const results = data?.results || [];

  // Pick first available label/typeId
  const pick = results[0];
  const associationTypeId = pick?.typeId || pick?.associationTypeId || null;

  if (!associationTypeId) {
    throw new Error(
      `Could not determine association typeId for notes -> ${toPlural}. Response: ${JSON.stringify(results)}`
    );
  }

  hsAssocCache[toType] = { at: now, associationTypeId };
  return associationTypeId;
}

receiver.app.post("/api/hubnote/create", express.json(), async (req, res) => {
  try {
    console.log("[HIT] /api/hubnote/create", req.body);

    // Optional auth gate
    if (ZAPIER_HUBNOTE_SECRET) {
      const incoming = req.headers["x-zapier-secret"];
      if (!incoming || incoming !== ZAPIER_HUBNOTE_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const {
      correlation_id,
      hubspot_object_type, // "ticket" | "deal"
      hubspot_object_id,   // record id
      note_title,
      note_body,
      submitted_by_slack_user_id,
      submitted_at,
      origin_channel_id,
      origin_user_id,
    } = req.body || {};

    // Required fields
    const missing = [];
    if (!hubspot_object_type) missing.push("hubspot_object_type");
    if (!hubspot_object_id) missing.push("hubspot_object_id");
    if (!origin_channel_id) missing.push("origin_channel_id");
    if (!origin_user_id) missing.push("origin_user_id");
    if (!note_title) missing.push("note_title");
    if (!note_body) missing.push("note_body");

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `missing ${missing.join(", ")}`,
      });
    }

    const recordType = String(hubspot_object_type).toLowerCase() === "deal" ? "deal" : "ticket";
    const recordId = String(hubspot_object_id);

    const hsBody = buildHubspotNoteBody(note_title, note_body);

    // 1) Create note
    const created = await hubspotRequest("POST", "/crm/v3/objects/notes", {
      properties: {
        hs_note_body: hsBody,
        hs_timestamp: String(Date.now()),
      },
    });

    const noteId = created?.id ? String(created.id) : "";
    if (!noteId) {
      throw new Error(`HubSpot note create returned no id. Response: ${JSON.stringify(created)}`);
    }

    // 2) Associate note -> ticket/deal
    const toPlural = hsPlural(recordType);
    const associationTypeId = await hsGetAssociationTypeIdForNote(recordType);

    // PUT /crm/v4/objects/notes/{noteId}/associations/{toPlural}/{recordId}/{associationTypeId}
    await hubspotRequest(
      "PUT",
      `/crm/v4/objects/notes/${noteId}/associations/${toPlural}/${recordId}/${associationTypeId}`
    );

    // Return data for Zap Step 3 callback
    return res.status(200).json({
      ok: true,
      status: "success",
      correlation_id: correlation_id || "",
      hubspot_note_id: noteId,
      hubspot_object_type: recordType,
      hubspot_object_id: recordId,
      origin_channel_id,
      origin_user_id,
      submitted_by_slack_user_id: submitted_by_slack_user_id || "",
      submitted_at: submitted_at || "",
    });
  } catch (e) {
    // Axios errors often hide the real message in e.response.data
    const hubspotErr = e?.response?.data;
    console.error("[api/hubnote/create] error:", e?.message || e);
    if (hubspotErr) console.error("[api/hubnote/create] hubspot response:", hubspotErr);

    return res.status(500).json({
      ok: false,
      status: "error",
      error: e?.message || "server_error",
      hubspot: hubspotErr || undefined,
    });
  }
});
// ==============================
// BOLT APP
// ==============================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.DEBUG,
});

// ==============================
// HELPERS: metadata + view payload
// ==============================
function parsePrivateMetadata(md) {
  try {
    return JSON.parse(md || "{}");
  } catch {
    return {};
  }
}

function buildCleanViewPayload(view, privateMetadataString) {
  return {
    type: "modal",
    callback_id: view.callback_id,
    title: view.title,
    submit: view.submit,
    close: view.close,
    blocks: view.blocks,
    private_metadata: privateMetadataString ?? view.private_metadata ?? "",
    clear_on_close: view.clear_on_close,
    notify_on_close: view.notify_on_close,
  };
}

// Slack view.state.values structure changes if block_id changes (nonce resets)
// This helper finds the selected_option value by action_id regardless of block_id.
function findSelectedOptionValue(viewStateValues, actionId) {
  const blocks = viewStateValues || {};
  for (const blockId of Object.keys(blocks)) {
    const actions = blocks[blockId] || {};
    const v = actions[actionId]?.selected_option?.value;
    if (v) return v;
  }
  return "";
}

// ==============================
// MONDAY API HELPERS
// ==============================
async function mondayGraphQL(query, variables = {}) {
  if (!MONDAY_API_TOKEN) throw new Error("Missing MONDAY_API_TOKEN");

  const res = await axios.post(
    "https://api.monday.com/v2",
    { query, variables },
    {
      headers: {
        Authorization: MONDAY_API_TOKEN,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  if (res.data?.errors?.length) {
    throw new Error(`Monday API error: ${JSON.stringify(res.data.errors)}`);
  }

  return res.data.data;
}

async function fetchBoards(search = "") {
  const now = Date.now();
  const s = (search || "").trim().toLowerCase();

  if (!s && cache.boards.options.length && now - cache.boards.at < CACHE_MS) {
    return cache.boards.options;
  }

  const data = await mondayGraphQL(
    `
    query ($limit:Int!) {
      boards(limit: $limit) { id name }
    }
  `,
    { limit: 100 }
  );

  const boards = data?.boards || [];

  const options = boards
    .filter((b) => !s || (b.name || "").toLowerCase().includes(s))
    .slice(0, 100)
    .map((b) => ({
      text: { type: "plain_text", text: b.name },
      value: String(b.id),
    }));

  if (!s) cache.boards = { at: now, options };
  return options;
}

async function fetchGroups(boardId, search = "") {
  const now = Date.now();
  const s = (search || "").trim().toLowerCase();

  if (!s) {
    const cached = cache.groupsByBoard.get(boardId);
    if (cached && cached.options?.length && now - cached.at < CACHE_MS) {
      return cached.options;
    }
  }

  const data = await mondayGraphQL(
    `
    query ($ids:[ID!]!) {
      boards(ids: $ids) {
        id
        groups { id title }
      }
    }
  `,
    { ids: [boardId] }
  );

  const groups = data?.boards?.[0]?.groups || [];

  const options = groups
    .filter((g) => !s || (g.title || "").toLowerCase().includes(s))
    .slice(0, 100)
    .map((g) => ({
      text: { type: "plain_text", text: g.title },
      value: String(g.id),
    }));

  if (!s) cache.groupsByBoard.set(boardId, { at: now, options });
  return options;
}

// ==============================
// /cstask dynamic dropdowns
// ==============================
app.options("board_select", async ({ options, ack, logger }) => {
  try {
    const search = options?.value || "";
    const boardOptions = await fetchBoards(search);

    if (!boardOptions.length) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "No boards found" }, value: "NO_BOARDS_FOUND" }],
      });
    }

    await ack({ options: boardOptions });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading boards (check Render logs)" }, value: "ERROR_LOADING_BOARDS" }],
    });
  }
});

app.action("board_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const selectedBoardId = body?.actions?.[0]?.selected_option?.value || "";
    const view = body?.view;
    if (!selectedBoardId || !view?.id) return;

    const meta = parsePrivateMetadata(view.private_metadata);
    meta.boardId = selectedBoardId;

    const cleanView = buildCleanViewPayload(view, JSON.stringify(meta));

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: cleanView,
    });

    console.log("[ACTION] board_select stored boardId:", selectedBoardId);
  } catch (e) {
    logger.error(e);
    console.error("[ACTION] board_select error:", e?.message || e);
  }
});

app.options("group_select", async ({ body, options, ack, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const boardId = meta.boardId || "";
    const search = options?.value || "";

    if (!boardId) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select a board first" }, value: "SELECT_BOARD_FIRST" }],
      });
    }

    const groupOptions = await fetchGroups(boardId, search);

    if (!groupOptions.length) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "No groups found for this board" }, value: "NO_GROUPS_FOUND" }],
      });
    }

    await ack({ options: groupOptions });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading groups (check Render logs)" }, value: "ERROR_LOADING_GROUPS" }],
    });
  }
});

// ==============================
// /cstask SLASH COMMAND -> OPEN MODAL
// ==============================
app.command("/cstask", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "cstask_modal_submit",
        title: { type: "plain_text", text: "Create CS Task" },
        submit: { type: "plain_text", text: "Create" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({}),
        blocks: [
          {
            type: "input",
            block_id: "task_name_block",
            label: { type: "plain_text", text: "Task Name" },
            element: { type: "plain_text_input", action_id: "task_name_input" },
          },
          {
            type: "input",
            block_id: "description_block",
            optional: true,
            label: { type: "plain_text", text: "Description" },
            element: { type: "plain_text_input", action_id: "description_input", multiline: true },
          },
          {
            type: "input",
            block_id: "owner_block",
            label: { type: "plain_text", text: "Task Owner" },
            element: { type: "users_select", action_id: "owner_user_select" },
          },
          {
            type: "input",
            block_id: "board_block",
            dispatch_action: true,
            label: { type: "plain_text", text: "Monday Board" },
            element: {
              type: "external_select",
              action_id: "board_select",
              placeholder: { type: "plain_text", text: "Search/select a board" },
              min_query_length: 0,
            },
          },
          {
            type: "input",
            block_id: "group_block",
            label: { type: "plain_text", text: "Monday Group" },
            element: {
              type: "external_select",
              action_id: "group_select",
              placeholder: { type: "plain_text", text: "Search/select a group" },
              min_query_length: 0,
            },
          },
          {
            type: "input",
            block_id: "status_block",
            label: { type: "plain_text", text: "Status" },
            element: {
              type: "static_select",
              action_id: "status_select",
              placeholder: { type: "plain_text", text: "Select a status" },
              options: toStaticOptions(STATUS_LABELS),
            },
          },
          {
            type: "input",
            block_id: "priority_block",
            label: { type: "plain_text", text: "Priority" },
            element: {
              type: "static_select",
              action_id: "priority_select",
              placeholder: { type: "plain_text", text: "Select a priority" },
              options: toStaticOptions(PRIORITY_LABELS),
            },
          },
        ],
      },
    });
  } catch (e) {
    logger.error(e);
    try {
      await client.chat.postMessage({
        channel: body.user_id,
        text: "❌ I couldn’t open the task form. Please try again or contact an admin.",
      });
    } catch (_) {}
  }
});

// ==============================
// /cstask MODAL SUBMIT -> SEND TO ZAPIER
// ==============================
app.view("cstask_modal_submit", async ({ ack, body, view, client, logger }) => {
  const taskName = view.state.values.task_name_block.task_name_input.value?.trim() || "";
  const description = view.state.values.description_block?.description_input?.value?.trim() || "";

  const ownerSlackUserId = view.state.values.owner_block.owner_user_select.selected_user || "";

  const meta = parsePrivateMetadata(view.private_metadata);
  const boardId = meta.boardId || "";

  const groupId = view.state.values.group_block.group_select.selected_option?.value || "";
  const statusLabel = view.state.values.status_block.status_select.selected_option?.value || "";
  const priorityLabel = view.state.values.priority_block.priority_select.selected_option?.value || "";

  const errors = {};
  if (!taskName) errors["task_name_block"] = "Task name is required.";
  if (!ownerSlackUserId) errors["owner_block"] = "Please select an owner.";
  if (!boardId) errors["board_block"] = "Please select a board.";
  if (!groupId) errors["group_block"] = "Please select a group.";
  if (!statusLabel) errors["status_block"] = "Please select a status.";
  if (!priorityLabel) errors["priority_block"] = "Please select a priority.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  let taskOwnerEmail = null;
  try {
    const userInfo = await client.users.info({ user: ownerSlackUserId });
    taskOwnerEmail = userInfo?.user?.profile?.email || null;
  } catch (e) {
    logger.error(e);
  }

  if (!taskOwnerEmail) {
    await client.chat.postMessage({
      channel: body.user.id,
      text:
        "⚠️ I couldn’t retrieve the selected owner’s email from Slack.\n" +
        "Make sure SyllaBot has `users:read.email` and you reinstalled the app.",
    });
    return;
  }

  if (!ZAPIER_WEBHOOK_URL) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "❌ ZAPIER_WEBHOOK_URL is missing. Add it in Render env vars and redeploy.",
    });
    return;
  }

  try {
    await axios.post(
      ZAPIER_WEBHOOK_URL,
      {
        source: "slack",
        command_name: "cstask",
        version: "v3.2",
        task_name: taskName,
        description,
        task_owner_slack_user_id: ownerSlackUserId,
        task_owner_email: taskOwnerEmail,
        monday_board_id: boardId,
        monday_group_id: groupId,
        status_label: statusLabel,
        priority_label: priorityLabel,
        submitted_by_slack_user_id: body.user.id,
        submitted_at: new Date().toISOString(),
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postMessage({
      channel: body.user.id,
      text:
        `✅ Task sent to Zapier!\n` +
        `• *Task:* ${taskName}\n` +
        `• *Board ID:* ${boardId}\n` +
        `• *Group ID:* ${groupId}\n` +
        `• *Status:* ${statusLabel}\n` +
        `• *Priority:* ${priorityLabel}\n` +
        `• *Owner:* ${taskOwnerEmail}`,
    });
  } catch (e) {
    logger.error(e);
    await client.chat.postMessage({
      channel: body.user.id,
      text: "❌ I couldn’t send that task to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// ============================================================================
// /hubnote v2 (dynamic lookups) + file attach flow
// ============================================================================

// ------------------------------
// HubSpot request helper
// ------------------------------
async function hubspotRequest(method, path, data) {
  if (!HUBSPOT_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");

const headers = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

  const res = await axios({
    method,
    url: `https://api.hubapi.com${path}`,
    headers: {
      Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    data,
    timeout: 15000,
  });

  return res.data;
}

// ------------------------------
// HubSpot caching: pipelines + stages
// ------------------------------
const HS_CACHE_MS = 10 * 60 * 1000; // 10 min
const hsCache = {
  pipelines: new Map(), // key: "ticket"|"deal" -> { at, pipelines:[{id,label,stages:[{id,label}]}] }
};

const HS_TICKET_STAGE_PROP = "hs_pipeline_stage";
const HS_DEAL_STAGE_PROP = "dealstage";
const HS_PIPELINE_PROP_DEAL = "pipeline";
const HS_PIPELINE_PROP_TICKET = "hs_pipeline";

function hsApiObjectType(recordType) {
  return recordType === "deal" ? "deals" : "tickets";
}

async function hsGetPipelines(recordType) {
  const key = recordType === "deal" ? "deal" : "ticket";
  const now = Date.now();
  const cached = hsCache.pipelines.get(key);
  if (cached && now - cached.at < HS_CACHE_MS) return cached.pipelines;

  const endpoint =
    recordType === "deal" ? "/crm/v3/pipelines/deals" : "/crm/v3/pipelines/tickets";

  const data = await hubspotRequest("GET", endpoint);

  const pipelines = (data?.results || []).map((p) => ({
    id: String(p.id),
    label: p.label || `Pipeline ${p.id}`,
    stages: (p.stages || []).map((s) => ({
      id: String(s.id),
      label: s.label || `Stage ${s.id}`,
    })),
  }));

  hsCache.pipelines.set(key, { at: now, pipelines });
  return pipelines;
}

async function hsSearchRecords({ recordType, pipelineId, stageId, query }) {
  const objectType = hsApiObjectType(recordType);

  const stageProp = recordType === "deal" ? HS_DEAL_STAGE_PROP : HS_TICKET_STAGE_PROP;
  const pipelineProp = recordType === "deal" ? HS_PIPELINE_PROP_DEAL : HS_PIPELINE_PROP_TICKET;

  const properties =
    recordType === "deal"
      ? ["dealname", pipelineProp, stageProp]
      : ["subject", pipelineProp, stageProp];

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: pipelineProp, operator: "EQ", value: String(pipelineId) },
          { propertyName: stageProp, operator: "EQ", value: String(stageId) },
        ],
      },
    ],
    properties,
    limit: 50,
  };

  const q = (query || "").trim();
  if (q) body.query = q;

  const data = await hubspotRequest(
    "POST",
    `/crm/v3/objects/${objectType}/search`,
    body
  );

  const results = data?.results || [];
  return results.map((r) => {
    const id = String(r.id);
    const props = r.properties || {};
    const label =
      recordType === "deal"
        ? props.dealname || `Deal ${id}`
        : props.subject || `Ticket ${id}`;
    return { id, label };
  });
}

// ------------------------------
// Session store for file flow
// ------------------------------
const HUBNOTE_SESSION_TTL_MS = 15 * 60 * 1000;
const hubnoteSessions = new Map();

function hubnoteMakeId(prefix = "hn") {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function hubnoteSetSession(sessionId, data) {
  hubnoteSessions.set(sessionId, {
    ...data,
    sessionId,
    expiresAt: Date.now() + HUBNOTE_SESSION_TTL_MS,
  });
}

function hubnoteGetSession(sessionId) {
  const s = hubnoteSessions.get(sessionId);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    hubnoteSessions.delete(sessionId);
    return null;
  }
  return s;
}

function hubnoteDeleteSession(sessionId) {
  hubnoteSessions.delete(sessionId);
}

// ------------------------------
// v2 modal builder (nonce forces downstream reset)
// ------------------------------
function buildHubnoteModalV2({ correlationId, originChannelId, originUserId, metaOverride = {} }) {
  const meta = {
    correlationId,
    originChannelId,
    originUserId,
    version: "v2",
    recordType: "",
    pipelineId: "",
    stageId: "",
    depsNonce: "0",
    ...metaOverride,
  };

  const nonce = String(meta.depsNonce || "0");

  return {
    type: "modal",
    callback_id: "hubnote_modal_submit_v2",
    title: { type: "plain_text", text: "HubSpot Note" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: "input",
        block_id: "record_type_block_v2",
        dispatch_action: true,
        label: { type: "plain_text", text: "Record Type" },
        element: {
          type: "static_select",
          action_id: "hubnote_v2_record_type_select",
          placeholder: { type: "plain_text", text: "Ticket or Deal" },
          options: [
            { text: { type: "plain_text", text: "Ticket" }, value: "ticket" },
            { text: { type: "plain_text", text: "Deal" }, value: "deal" },
          ],
        },
      },
      {
        type: "input",
        block_id: "pipeline_block_v2",
        dispatch_action: true,
        label: { type: "plain_text", text: "Pipeline" },
        element: {
          type: "external_select",
          action_id: "hubnote_v2_pipeline_select",
          placeholder: { type: "plain_text", text: "Select a pipeline" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: `stage_block_v2_${nonce}`,
        dispatch_action: true,
        label: { type: "plain_text", text: "Pipeline Stage" },
        element: {
          type: "external_select",
          action_id: "hubnote_v2_stage_select",
          placeholder: { type: "plain_text", text: "Select a stage" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: `record_block_v2_${nonce}`,
        label: { type: "plain_text", text: "Record" },
        element: {
          type: "external_select",
          action_id: "hubnote_v2_record_select",
          placeholder: { type: "plain_text", text: "Search/select a record" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "note_title_block_v2",
        label: { type: "plain_text", text: "Note Title / Subject" },
        element: { type: "plain_text_input", action_id: "hubnote_v2_note_title_input" },
      },
      {
        type: "input",
        block_id: "note_body_block_v2",
        label: { type: "plain_text", text: "Note Body" },
        element: {
          type: "plain_text_input",
          action_id: "hubnote_v2_note_body_input",
          multiline: true,
        },
      },
    ],
  };
}

// ------------------------------
// Ephemeral + DM UI builders
// ------------------------------
function buildHubnoteAddFilesEphemeral({ sessionId }) {
  return {
    text: "✅ Note created. Add files to the note?",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "✅ *Note created.* Add files to the note?" } },
      {
        type: "actions",
        block_id: "hubnote_add_files_actions",
        elements: [
          {
            type: "button",
            action_id: "hubnote_add_files_yes",
            style: "primary",
            text: { type: "plain_text", text: ":meow_nod: Yes" },
            value: sessionId,
          },
          {
            type: "button",
            action_id: "hubnote_add_files_no",
            style: "danger",
            text: { type: "plain_text", text: ":bear-headshake: No" },
            value: sessionId,
          },
        ],
      },
    ],
  };
}

function buildHubnoteDmPrompt({ sessionId }) {
  return {
    text: "Upload files here to attach to your HubSpot note.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "Upload the file(s) *in this DM*.\n\n" +
            "When you’re ready, click *Attach files* below to select what to attach.",
        },
      },
      {
        type: "actions",
        block_id: "hubnote_dm_actions",
        elements: [
          {
            type: "button",
            action_id: "hubnote_open_attach_modal",
            style: "primary",
            text: { type: "plain_text", text: "Attach files" },
            value: sessionId,
          },
        ],
      },
    ],
  };
}

function buildHubnoteAttachModal({ sessionId }) {
  return {
    type: "modal",
    callback_id: "hubnote_attach_modal_submit",
    title: { type: "plain_text", text: "Attach Files" },
    submit: { type: "plain_text", text: "Attach" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ sessionId }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "Select file(s) you’ve uploaded to Slack.\n\n" +
            "_Tip: upload the files in the DM first, then open this selector._",
        },
      },
      {
        type: "input",
        block_id: "files_select_block",
        label: { type: "plain_text", text: "Files to attach" },
        element: {
          type: "multi_external_select",
          action_id: "hubnote_files_select",
          placeholder: { type: "plain_text", text: "Search your recent Slack files" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        optional: true,
        block_id: "attach_note_block",
        label: { type: "plain_text", text: "Optional message" },
        element: { type: "plain_text_input", action_id: "attach_note_input", multiline: true },
      },
    ],
  };
}

// ------------------------------
// /hubnote command -> open v2 modal
// ------------------------------
app.command("/hubnote", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const correlationId = hubnoteMakeId("hubnote");
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildHubnoteModalV2({
        correlationId,
        originChannelId: body.channel_id,
        originUserId: body.user_id,
        metaOverride: { recordType: "ticket", depsNonce: "0" },
      }),
    });
  } catch (e) {
    logger.error(e);
    try {
      await client.chat.postMessage({
        channel: body.user_id,
        text: "❌ I couldn’t open the HubSpot note form. Please try again.",
      });
    } catch (_) {}
  }
});

// ------------------------------
// v2 ACTION handlers (store selections + reset downstream using depsNonce)
// ------------------------------
app.action("hubnote_v2_record_type_select", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const view = body.view;
    const recordType = body?.actions?.[0]?.selected_option?.value || "";
    if (!view?.id || !recordType) return;

    const meta = parsePrivateMetadata(view.private_metadata);
    const nextMeta = {
      ...meta,
      recordType,
      pipelineId: "",
      stageId: "",
      depsNonce: String(Number(meta.depsNonce || "0") + 1),
    };

    const rebuilt = buildHubnoteModalV2({
      correlationId: nextMeta.correlationId,
      originChannelId: nextMeta.originChannelId,
      originUserId: nextMeta.originUserId,
      metaOverride: nextMeta,
    });

    await client.views.update({ view_id: view.id, hash: view.hash, view: rebuilt });
  } catch (e) {
    logger.error(e);
  }
});

app.action("hubnote_v2_pipeline_select", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const view = body.view;
    const pipelineId = body?.actions?.[0]?.selected_option?.value || "";
    if (!view?.id || !pipelineId) return;

    const meta = parsePrivateMetadata(view.private_metadata);
    const nextMeta = {
      ...meta,
      pipelineId,
      stageId: "",
      depsNonce: String(Number(meta.depsNonce || "0") + 1),
    };

    const rebuilt = buildHubnoteModalV2({
      correlationId: nextMeta.correlationId,
      originChannelId: nextMeta.originChannelId,
      originUserId: nextMeta.originUserId,
      metaOverride: nextMeta,
    });

    await client.views.update({ view_id: view.id, hash: view.hash, view: rebuilt });
  } catch (e) {
    logger.error(e);
  }
});

app.action("hubnote_v2_stage_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const view = body.view;
    const stageId = body?.actions?.[0]?.selected_option?.value || "";
    if (!view?.id || !stageId) return;

    const meta = parsePrivateMetadata(view.private_metadata);

    // ✅ Just update metadata; do NOT rebuild blocks/nonce
    meta.stageId = stageId;

    // (Optional but nice) also store labels for debugging / future initial_option work
    const stageLabel = body?.actions?.[0]?.selected_option?.text?.text || "";
    if (stageLabel) meta.stageLabel = stageLabel;

    const cleanView = buildCleanViewPayload(view, JSON.stringify(meta));

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: cleanView,
    });
  } catch (e) {
    logger.error(e);
  }
});

// ------------------------------
// v2 OPTIONS handlers
// ------------------------------
app.options("hubnote_v2_pipeline_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";
    const q = (options?.value || "").trim().toLowerCase();

    const pipelines = await hsGetPipelines(recordType);

    const opts = pipelines
      .filter((p) => !q || (p.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((p) => ({ text: { type: "plain_text", text: p.label.slice(0, 75) }, value: String(p.id) }));

    if (!opts.length) {
      return await ack({ options: [{ text: { type: "plain_text", text: "No pipelines found" }, value: "NO_PIPELINES" }] });
    }

    await ack({ options: opts });
  } catch (e) {
    logger.error(e);
    await ack({ options: [{ text: { type: "plain_text", text: "ERROR loading pipelines" }, value: "ERROR_PIPELINES" }] });
  }
});

app.options("hubnote_v2_stage_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";
    const pipelineId = meta.pipelineId || "";
    const q = (options?.value || "").trim().toLowerCase();

    if (!pipelineId) {
      return await ack({ options: [{ text: { type: "plain_text", text: "Select a pipeline first" }, value: "SELECT_PIPELINE_FIRST" }] });
    }

    const pipelines = await hsGetPipelines(recordType);
    const pipeline = pipelines.find((p) => String(p.id) === String(pipelineId));
    const stages = pipeline?.stages || [];

    const opts = stages
      .filter((s) => !q || (s.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((s) => ({ text: { type: "plain_text", text: s.label.slice(0, 75) }, value: String(s.id) }));

    if (!opts.length) {
      return await ack({ options: [{ text: { type: "plain_text", text: "No stages found" }, value: "NO_STAGES" }] });
    }

    await ack({ options: opts });
  } catch (e) {
    logger.error(e);
    await ack({ options: [{ text: { type: "plain_text", text: "ERROR loading stages" }, value: "ERROR_STAGES" }] });
  }
});

app.options("hubnote_v2_record_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";
    const pipelineId = meta.pipelineId || "";
    const stageId = meta.stageId || "";
    const q = (options?.value || "").trim();

    if (!pipelineId) {
      return await ack({ options: [{ text: { type: "plain_text", text: "Select a pipeline first" }, value: "SELECT_PIPELINE_FIRST" }] });
    }
    if (!stageId) {
      return await ack({ options: [{ text: { type: "plain_text", text: "Select a stage first" }, value: "SELECT_STAGE_FIRST" }] });
    }

    const records = await hsSearchRecords({ recordType, pipelineId, stageId, query: q });

    const opts = records
      .slice(0, 100)
      .map((r) => ({ text: { type: "plain_text", text: r.label.slice(0, 75) }, value: String(r.id) }));

    if (!opts.length) {
      return await ack({ options: [{ text: { type: "plain_text", text: "No records found" }, value: "NO_RECORDS" }] });
    }

    await ack({ options: opts });
  } catch (e) {
    logger.error(e);
    await ack({ options: [{ text: { type: "plain_text", text: "ERROR loading records" }, value: "ERROR_RECORDS" }] });
  }
});

// ------------------------------
// v2 SUBMIT -> Zapier (create note + associate)
// ------------------------------
app.view("hubnote_modal_submit_v2", async ({ ack, body, view, client, logger }) => {
  const meta = parsePrivateMetadata(view.private_metadata);

  const recordType = findSelectedOptionValue(view.state.values, "hubnote_v2_record_type_select") || meta.recordType || "";
  const pipelineId = findSelectedOptionValue(view.state.values, "hubnote_v2_pipeline_select") || meta.pipelineId || "";
  const stageId = findSelectedOptionValue(view.state.values, "hubnote_v2_stage_select") || meta.stageId || "";
  const recordId = findSelectedOptionValue(view.state.values, "hubnote_v2_record_select") || "";

  const noteTitle = view.state.values.note_title_block_v2?.hubnote_v2_note_title_input?.value?.trim() || "";
  const noteBody = view.state.values.note_body_block_v2?.hubnote_v2_note_body_input?.value?.trim() || "";

  const errors = {};
  if (!recordType) errors["record_type_block_v2"] = "Select Ticket or Deal.";
  if (!pipelineId) errors["pipeline_block_v2"] = "Select a pipeline.";
  if (!noteTitle) errors["note_title_block_v2"] = "Note title is required.";
  if (!noteBody) errors["note_body_block_v2"] = "Note body is required.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  if (!stageId || !recordId) {
    try {
      await client.chat.postEphemeral({
        channel: meta.originChannelId || body.user.id,
        user: meta.originUserId || body.user.id,
        text: "⚠️ Please select Pipeline Stage and Record before submitting.",
      });
    } catch (_) {}
    return;
  }

  if (!ZAPIER_HUBNOTE_WEBHOOK_URL) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "❌ ZAPIER_HUBNOTE_WEBHOOK_URL is missing. Add it in Render env vars and redeploy.",
    });
    return;
  }

  try {
    await axios.post(
      ZAPIER_HUBNOTE_WEBHOOK_URL,
      {
        source: "slack",
        command_name: "hubnote",
        version: "v2",
        correlation_id: meta.correlationId || hubnoteMakeId("hubnote"),
        hubspot_object_type: recordType,
        hubspot_object_id: String(recordId),
        hubspot_pipeline_id: String(pipelineId),
        hubspot_stage_id: String(stageId),
        note_title: noteTitle,
        note_body: noteBody,
        submitted_by_slack_user_id: body.user.id,
        submitted_at: new Date().toISOString(),
        origin_channel_id: meta.originChannelId || body.user.id,
        origin_user_id: meta.originUserId || body.user.id,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postEphemeral({
      channel: meta.originChannelId || body.user.id,
      user: meta.originUserId || body.user.id,
      text: "⏳ Creating note in HubSpot…",
    });
  } catch (e) {
    logger.error(e);
    await client.chat.postEphemeral({
      channel: meta.originChannelId || body.user.id,
      user: meta.originUserId || body.user.id,
      text: "❌ I couldn’t send the note to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// ------------------------------
// Zapier -> SyllaBot callback -> ephemeral Yes/No
// ------------------------------
// ==============================
// NEW: Zapier -> SyllaBot middleware endpoint
// POST /api/hubnote/create
// Creates a HubSpot note + associates it to a Ticket or Deal.
// ==============================

const HS_ASSOC_CACHE_MS = 60 * 60 * 1000; // 1 hour
const hsAssocCache = {
  deal: { at: 0, associationTypeId: null },
  ticket: { at: 0, associationTypeId: null },
};

function hsPlural(type) {
  // HubSpot object names for endpoints
  if (type === "deal") return "deals";
  return "tickets";
}

function buildHubspotNoteBody(noteTitle, noteBody) {
  const title = (noteTitle || "").trim();
  const body = (noteBody || "").trim();

  // HubSpot Notes UI doesn’t always show a “title” field consistently,
  // so we embed title at top for reliable UX.
  if (title && body) return `**${title}**\n\n${body}`;
  if (title && !body) return `**${title}**`;
  return body;
}

async function hsGetAssociationTypeIdForNote(toType /* "deal"|"ticket" */) {
  const cached = hsAssocCache[toType];
  const now = Date.now();
  if (cached?.associationTypeId && now - cached.at < HS_ASSOC_CACHE_MS) {
    return cached.associationTypeId;
  }

  const toPlural = hsPlural(toType);

  // HubSpot association labels endpoint:
  // GET /crm/v4/objects/notes/{toPlural}/labels
  const data = await hubspotRequest(
    "GET",
    `/crm/v4/objects/notes/${toPlural}/labels`
  );

  const results = data?.results || [];

  // Try to choose the default-ish association
  // (HubSpot returns multiple labels in some portals)
  const pick =
    results.find((r) => !r.label) ||
    results.find((r) => String(r.label || "").toLowerCase() === "default") ||
    results[0];

  const associationTypeId = pick?.typeId || pick?.associationTypeId || null;

  if (!associationTypeId) {
    throw new Error(
      `Could not determine association typeId for notes -> ${toPlural}. HubSpot returned: ${JSON.stringify(
        results
      )}`
    );
  }

  hsAssocCache[toType] = { at: now, associationTypeId };
  return associationTypeId;
}

receiver.app.post("/api/hubnote/create", express.json(), async (req, res) => {
  try {
    // Optional auth: if you set ZAPIER_HUBNOTE_SECRET in Render,
    // Zapier should send header x-zapier-secret with that value.
    if (ZAPIER_HUBNOTE_SECRET) {
      const incoming = req.headers["x-zapier-secret"];
      if (!incoming || incoming !== ZAPIER_HUBNOTE_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const {
      correlation_id,
      hubspot_object_type, // "ticket" | "deal"
      hubspot_object_id,   // record id
      note_title,
      note_body,
      submitted_by_slack_user_id,
      submitted_at,
      origin_channel_id,
      origin_user_id,
    } = req.body || {};

    // Validate required inputs
    const missing = [];
    if (!hubspot_object_type) missing.push("hubspot_object_type");
    if (!hubspot_object_id) missing.push("hubspot_object_id");
    if (!origin_channel_id) missing.push("origin_channel_id");
    if (!origin_user_id) missing.push("origin_user_id");

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: `missing ${missing.join(", ")}`,
      });
    }

    const recordType = String(hubspot_object_type).toLowerCase() === "deal" ? "deal" : "ticket";
    const recordId = String(hubspot_object_id);

    const hsBody = buildHubspotNoteBody(note_title, note_body);

    // Create note
    const createNotePayload = {
      properties: {
        hs_note_body: hsBody,
        hs_timestamp: String(Date.now()),
      },
    };

    const created = await hubspotRequest(
      "POST",
      "/crm/v3/objects/notes",
      createNotePayload
    );

    const noteId = created?.id ? String(created.id) : null;
    if (!noteId) {
      throw new Error(`HubSpot note create returned no id: ${JSON.stringify(created)}`);
    }

    // Associate note -> ticket/deal
    const toPlural = hsPlural(recordType);
    const associationTypeId = await hsGetAssociationTypeIdForNote(recordType);

    // PUT /crm/v4/objects/notes/{noteId}/associations/{toPlural}/{recordId}/{associationTypeId}
    await hubspotRequest(
      "PUT",
      `/crm/v4/objects/notes/${noteId}/associations/${toPlural}/${recordId}/${associationTypeId}`
    );

    // Respond for Zapier Step 3 callback mapping
    return res.status(200).json({
      ok: true,
      status: "success",
      correlation_id: correlation_id || "",
      hubspot_note_id: noteId,
      hubspot_object_type: recordType,
      hubspot_object_id: recordId,
      origin_channel_id,
      origin_user_id,
      submitted_by_slack_user_id: submitted_by_slack_user_id || "",
      submitted_at: submitted_at || "",
    });
  } catch (e) {
    console.error("[api/hubnote/create] error:", e?.message || e);

    // IMPORTANT: return JSON so Zapier can show something useful
    return res.status(500).json({
      ok: false,
      status: "error",
      error: e?.message || "server_error",
    });
  }
});

receiver.app.post("/zapier/hubnote/callback", express.json(), async (req, res) => {
  try {
    if (ZAPIER_HUBNOTE_SECRET) {
      const incoming = req.headers["x-zapier-secret"];
      if (!incoming || incoming !== ZAPIER_HUBNOTE_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const {
      status,
      correlation_id,
      hubspot_note_id,
      hubspot_object_type,
      hubspot_object_id,
      origin_channel_id,
      origin_user_id,
    } = req.body || {};

    if (!origin_channel_id || !origin_user_id) {
      return res.status(400).json({ ok: false, error: "missing origin_channel_id/origin_user_id" });
    }

    if (status !== "success" || !hubspot_note_id) {
      await app.client.chat.postEphemeral({
        channel: origin_channel_id,
        user: origin_user_id,
        text: "❌ HubSpot note creation failed. Check Zapier logs for details.",
      });
      return res.status(200).json({ ok: true, handled: "failure" });
    }

    const sessionId = hubnoteMakeId("hubnote_session");
    hubnoteSetSession(sessionId, {
      correlationId: correlation_id,
      hubspotNoteId: String(hubspot_note_id),
      hubspotObjectType: hubspot_object_type || "ticket",
      hubspotObjectId: hubspot_object_id ? String(hubspot_object_id) : "",
      originChannelId: origin_channel_id,
      originUserId: origin_user_id,
      dmChannelId: "",
    });

    await app.client.chat.postEphemeral({
      channel: origin_channel_id,
      user: origin_user_id,
      ...buildHubnoteAddFilesEphemeral({ sessionId }),
    });

    return res.status(200).json({ ok: true, sessionId });
  } catch (e) {
    console.error("[hubnote callback] error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ------------------------------
// Ephemeral button handlers
// ------------------------------
app.action("hubnote_add_files_no", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const sessionId = body?.actions?.[0]?.value || "";
    if (sessionId) hubnoteDeleteSession(sessionId);

    const channelId = body?.channel?.id;
    const userId = body?.user?.id;
    if (channelId && userId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "✅ All set — no files added.",
      });
    }
  } catch (e) {
    logger.error(e);
  }
});

app.action("hubnote_add_files_yes", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const sessionId = body?.actions?.[0]?.value || "";
    const session = hubnoteGetSession(sessionId);

    if (!session) {
      const channelId = body?.channel?.id;
      const userId = body?.user?.id;
      if (channelId && userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "⚠️ That attachment session expired. Please run /hubnote again.",
        });
      }
      return;
    }

    const dm = await client.conversations.open({ users: session.originUserId });
    const dmChannelId = dm?.channel?.id;

    if (!dmChannelId) {
      await client.chat.postEphemeral({
        channel: session.originChannelId,
        user: session.originUserId,
        text: "❌ I couldn’t open a DM for file uploads. Please try again.",
      });
      return;
    }

    hubnoteSetSession(sessionId, { ...session, dmChannelId });

    await client.chat.postMessage({
      channel: dmChannelId,
      ...buildHubnoteDmPrompt({ sessionId }),
    });

    await client.chat.postEphemeral({
      channel: session.originChannelId,
      user: session.originUserId,
      text: "✅ DM sent — upload files there, then click *Attach files*.",
    });
  } catch (e) {
    logger.error(e);
  }
});

// ------------------------------
// DM button -> open attach modal
// ------------------------------
app.action("hubnote_open_attach_modal", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const sessionId = body?.actions?.[0]?.value || "";
    const session = hubnoteGetSession(sessionId);
    if (!session) return;

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildHubnoteAttachModal({ sessionId }),
    });
  } catch (e) {
    logger.error(e);
  }
});

// ------------------------------
// File selector options (requires files:read scope)
// ------------------------------
app.options("hubnote_files_select", async ({ ack, body, options, client, logger }) => {
  try {
    const sessionId = parsePrivateMetadata(body?.view?.private_metadata)?.sessionId || "";
    const session = hubnoteGetSession(sessionId);

    if (!session) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Session expired — rerun /hubnote" }, value: "SESSION_EXPIRED" }],
      });
    }

    const query = (options?.value || "").trim().toLowerCase();

    const filesRes = await client.files.list({
      user: session.originUserId,
      count: 50,
    });

    const files = filesRes?.files || [];
    const filtered = files
      .filter((f) => {
        const name = (f?.name || "").toLowerCase();
        const title = (f?.title || "").toLowerCase();
        if (!query) return true;
        return name.includes(query) || title.includes(query);
      })
      .slice(0, 50)
      .map((f) => {
        const label = f.title || f.name || `File ${f.id}`;
        return { text: { type: "plain_text", text: label.slice(0, 75) }, value: String(f.id) };
      });

    if (!filtered.length) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "No matching files found" }, value: "NO_FILES_FOUND" }],
      });
    }

    await ack({ options: filtered });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading files (check scopes/logs)" }, value: "ERROR_LOADING_FILES" }],
    });
  }
});

// ------------------------------
// Attach modal submit -> Zapier
// ------------------------------
app.view("hubnote_attach_modal_submit", async ({ ack, body, view, client, logger }) => {
  const meta = parsePrivateMetadata(view.private_metadata);
  const sessionId = meta.sessionId || "";
  const session = hubnoteGetSession(sessionId);

  if (!session) {
    await ack();
    return;
  }

  const selected = view.state.values.files_select_block.hubnote_files_select.selected_options || [];
  const slackFileIds = selected.map((o) => o.value).filter(Boolean);

  if (!slackFileIds.length) {
    await ack({ response_action: "errors", errors: { files_select_block: "Select at least one file." } });
    return;
  }

  await ack();

  const attachNote = view.state.values.attach_note_block?.attach_note_input?.value?.trim() || "";

  if (!ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL) {
    await client.chat.postMessage({
      channel: session.dmChannelId || body.user.id,
      text: "⚠️ ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL is not set. Add it in Render to enable attachments.",
    });
    return;
  }

  try {
    await axios.post(
      ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL,
      {
        source: "slack",
        command_name: "hubnote",
        version: "v2-attach",
        hubspot_note_id: session.hubspotNoteId,
        hubspot_object_type: session.hubspotObjectType,
        hubspot_object_id: session.hubspotObjectId,
        slack_file_ids: slackFileIds,
        attach_note: attachNote,
        requested_by_slack_user_id: body.user.id,
        requested_at: new Date().toISOString(),
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postMessage({
      channel: session.dmChannelId || body.user.id,
      text: `✅ Attachment request sent! (${slackFileIds.length} file${slackFileIds.length === 1 ? "" : "s"})`,
    });
  } catch (e) {
    logger.error(e);
    await client.chat.postMessage({
      channel: session.dmChannelId || body.user.id,
      text: "❌ I couldn’t send attachments to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// ==============================
// START SERVER
// ==============================
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ SyllaBot is running (cstask + hubnote v2)");
})();
