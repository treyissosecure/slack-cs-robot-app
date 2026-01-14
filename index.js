/**
 * index.js — SyllaBot (Render)
 *
 * ✅ /cstask (UNCHANGED logic: Monday board/group/status/priority + Zapier webhook)
 * ✅ /hubnote v2 modal (Record Type → Pipeline → Stage → Record)
 * ✅ Zapier Step 2: POST /api/hubnote/create  (HubSpot note + association)
 * ✅ Zapier Step 3: POST /zapier/hubnote/callback (ephemeral “Add files?”)
 * ✅ FIXED: Green “Yes” button now works reliably (no DM open dependency). It opens an Attach Files modal directly.
 *
 * -------------------------------------------------------
 * Required ENV VARS (Render)
 * -------------------------------------------------------
 * SLACK_SIGNING_SECRET
 * SLACK_BOT_TOKEN
 * MONDAY_API_TOKEN
 * ZAPIER_WEBHOOK_URL                    (for /cstask)
 *
 * HUBSPOT_PRIVATE_APP_TOKEN             (HubSpot private app token)
 *
 * Optional (recommended if you want auth between Zapier ↔ SyllaBot):
 * HUBNOTE_ZAPIER_SECRET                 (Zap Step 2 header x-zapier-secret must match)
 * ZAPIER_HUBNOTE_SECRET                 (Zap Step 3 header x-zapier-secret must match)
 *
 * Optional:
 * ZAPIER_HUBNOTE_TRIGGER_URL            (if /hubnote trigger Catch Hook is different than ZAPIER_WEBHOOK_URL)
 */

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

const ZAPIER_HUBNOTE_TRIGGER_URL = process.env.ZAPIER_HUBNOTE_TRIGGER_URL || "";

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

// Optional auth headers
const HUBNOTE_ZAPIER_SECRET =
  process.env.HUBNOTE_ZAPIER_SECRET || process.env.ZAPIER_HUBNOTE_SECRET || "";
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
// REQUEST RECEIVER
// ==============================
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
    actions: "/slack/interactions", // interactive + options load URL
  },
});

// Basic request logging (keep while debugging)
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
// BOLT APP
// ==============================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.DEBUG,
});

// ==============================
// HELPERS
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

// Slack view.state.values can shift if block_id changes.
// This helper finds selected_option.value by action_id regardless of block_id.
function findSelectedOptionValue(viewStateValues, actionId) {
  const blocks = viewStateValues || {};
  for (const blockId of Object.keys(blocks)) {
    const actions = blocks[blockId] || {};
    const v = actions[actionId]?.selected_option?.value;
    if (v) return v;
  }
  return "";
}

function option(text, value) {
  return { text: { type: "plain_text", text }, value: String(value) };
}

function nowIso() {
  return new Date().toISOString();
}

// ==============================
// MONDAY API HELPERS
// ==============================
const CACHE_MS = 60 * 1000;
const cache = {
  boards: { at: 0, options: [] },
  groupsByBoard: new Map(),
};

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
// DYNAMIC DROPDOWNS (Monday external_select)
// ==============================
app.options("board_select", async ({ options, ack, logger }) => {
  try {
    const search = options?.value || "";
    const boardOptions = await fetchBoards(search);

    if (!boardOptions.length) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "No boards found" },
            value: "NO_BOARDS_FOUND",
          },
        ],
      });
    }

    await ack({ options: boardOptions });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [
        {
          text: { type: "plain_text", text: "ERROR loading boards (check Render logs)" },
          value: "ERROR_LOADING_BOARDS",
        },
      ],
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
  } catch (e) {
    logger.error(e);
  }
});

app.options("group_select", async ({ body, options, ack, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const boardId = meta.boardId || "";
    const search = options?.value || "";

    if (!boardId) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "Select a board first" },
            value: "SELECT_BOARD_FIRST",
          },
        ],
      });
    }

    const groupOptions = await fetchGroups(boardId, search);

    if (!groupOptions.length) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "No groups found for this board" },
            value: "NO_GROUPS_FOUND",
          },
        ],
      });
    }

    await ack({ options: groupOptions });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [
        {
          text: { type: "plain_text", text: "ERROR loading groups (check Render logs)" },
          value: "ERROR_LOADING_GROUPS",
        },
      ],
    });
  }
});

// ==============================
// /cstask (KEEP AS-IS BEHAVIOR)
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
            element: {
              type: "plain_text_input",
              action_id: "description_input",
              multiline: true,
            },
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

app.view("cstask_modal_submit", async ({ ack, body, view, client, logger }) => {
  const taskName =
    view.state.values.task_name_block.task_name_input.value?.trim() || "";
  const description =
    view.state.values.description_block?.description_input?.value?.trim() || "";

  const ownerSlackUserId =
    view.state.values.owner_block.owner_user_select.selected_user || "";

  const meta = parsePrivateMetadata(view.private_metadata);
  const boardId = meta.boardId || "";

  const groupId =
    view.state.values.group_block.group_select.selected_option?.value || "";

  const statusLabel =
    view.state.values.status_block.status_select.selected_option?.value || "";

  const priorityLabel =
    view.state.values.priority_block.priority_select.selected_option?.value || "";

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
        submitted_at: nowIso(),
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

// ==============================
// HUBSPOT HELPERS (HubNote v2)
// ==============================
async function hubspotRequest(method, path, data) {
  if (!HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  }

  const url = `https://api.hubapi.com${path}`;

  const res = await axios({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
  return res.data;
}

// Pipelines cache
const HS_CACHE_MS = 10 * 60 * 1000; // 10 min
const hsCache = {
  pipelines: new Map(), // key: "ticket"|"deal" -> { at, pipelines:[{id,label,stages:[{id,label}]}] }
  assocTypeId: new Map(), // key: "tickets"|"deals" -> { at, id }
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
  if (cached && cached.pipelines?.length && now - cached.at < HS_CACHE_MS) {
    return cached.pipelines;
  }

  const apiType = recordType === "deal" ? "deals" : "tickets";
  const data = await hubspotRequest("GET", `/crm/v3/pipelines/${apiType}`);

  const pipelines = (data?.results || []).map((p) => ({
    id: String(p.id),
    label: p.label || p.name || `Pipeline ${p.id}`,
    stages: (p.stages || []).map((s) => ({
      id: String(s.id),
      label: s.label || s.name || `Stage ${s.id}`,
    })),
  }));

  hsCache.pipelines.set(key, { at: now, pipelines });
  return pipelines;
}

async function hsSearchRecords({ recordType, pipelineId, stageId, query }) {
  const objectType = hsApiObjectType(recordType);

  const stageProp =
    recordType === "deal" ? HS_DEAL_STAGE_PROP : HS_TICKET_STAGE_PROP;

  const pipelineProp =
    recordType === "deal" ? HS_PIPELINE_PROP_DEAL : HS_PIPELINE_PROP_TICKET;

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

async function hsGetNoteAssociationTypeId(toObjectTypePlural) {
  const now = Date.now();
  const cached = hsCache.assocTypeId.get(toObjectTypePlural);
  if (cached && cached.id && now - cached.at < HS_CACHE_MS) return cached.id;

  const data = await hubspotRequest(
    "GET",
    `/crm/v4/associations/notes/${toObjectTypePlural}/labels`
  );

  const results = data?.results || [];
  const preferred = results.find((r) =>
    String(r.label || "").toLowerCase().includes("note")
  );
  const chosen = preferred || results[0];

  const id = chosen?.typeId;
  if (!id) throw new Error(`Could not determine association typeId for notes -> ${toObjectTypePlural}`);

  hsCache.assocTypeId.set(toObjectTypePlural, { at: now, id: Number(id) });
  return Number(id);
}

async function hsCreateNoteAndAssociate({
  hubspot_object_type, // "ticket"|"deal"
  hubspot_object_id,
  note_title,
  note_body,
}) {
  const toPlural = hubspot_object_type === "deal" ? "deals" : "tickets";
  const assocTypeId = await hsGetNoteAssociationTypeId(toPlural);

  const combinedBody = `**${note_title || "Note"}**\n${note_body || ""}`;

  const createBody = {
    properties: {
      hs_note_body: combinedBody,
    },
    associations: [
      {
        to: { id: String(hubspot_object_id) },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: assocTypeId,
          },
        ],
      },
    ],
  };

  const created = await hubspotRequest("POST", "/crm/v3/objects/notes", createBody);
  const noteId = created?.id;
  if (!noteId) throw new Error("HubSpot note creation failed (no id returned)");

    return {
    hubspot_note_id: String(noteId),
    hubspot_object_type,
    hubspot_object_id: String(hubspot_object_id),
  };
}

// ==============================
// /api/hubnote/create  (Zap Step 2 target)
// ==============================
//
// Zap Step 2 (Webhooks by Zapier -> Custom Request)
// POST https://<render>/api/hubnote/create
// Headers:
//   Content-Type: application/json
//   (optional) x-zapier-secret: <HUBNOTE_ZAPIER_SECRET>
//
// Body fields expected (from your Step 1 catch hook):
//  - correlation_id
//  - hubspot_object_type  ("ticket"|"deal")
//  - hubspot_object_id
//  - note_title
//  - note_body
//  - submitted_by_slack_user_id
//  - submitted_at
//  - origin_channel_id
//  - origin_user_id
//
// Returns JSON for Zap Step 3 to pass into /zapier/hubnote/callback
//
receiver.app.post("/api/hubnote/create", express.json(), async (req, res) => {
  try {
    if (HUBNOTE_ZAPIER_SECRET) {
      const incoming = req.headers["x-zapier-secret"];
      if (!incoming || incoming !== HUBNOTE_ZAPIER_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const body = req.body || {};
    console.log("[HIT] /api/hubnote/create", {
      correlation_id: body.correlation_id,
      hubspot_object_type: body.hubspot_object_type,
      hubspot_object_id: body.hubspot_object_id,
      origin_channel_id: body.origin_channel_id,
      origin_user_id: body.origin_user_id,
    });

    const correlation_id = String(body.correlation_id || hubnoteMakeId("hubnote"));
    const hubspot_object_type =
      body.hubspot_object_type === "deal" ? "deal" : "ticket";

    const hubspot_object_id = String(body.hubspot_object_id || "").trim();
    const note_title = String(body.note_title || "").trim();
    const note_body = String(body.note_body || "").trim();

    const origin_channel_id = String(body.origin_channel_id || "").trim();
    const origin_user_id = String(body.origin_user_id || "").trim();

    if (!hubspot_object_id || !origin_channel_id || !origin_user_id) {
      return res.status(400).json({
        ok: false,
        error: "missing_required_fields",
        details: "hubspot_object_id, origin_channel_id, origin_user_id required",
      });
    }

    const created = await hsCreateNoteAndAssociate({
      hubspot_object_type,
      hubspot_object_id,
      note_title,
      note_body,
    });

    // Return what Zap Step 3 needs to call /zapier/hubnote/callback
    return res.status(200).json({
      ok: true,
      status: "success",
      correlation_id,
      hubspot_note_id: created.hubspot_note_id,
      hubspot_object_type,
      hubspot_object_id,
      origin_channel_id,
      origin_user_id,
    });
  } catch (e) {
    console.error("[/api/hubnote/create] error:", e?.response?.data || e?.message || e);
    return res.status(500).json({
      ok: false,
      status: "error",
      message: "hubnote_create_failed",
      details: e?.response?.data || e?.message || String(e),
    });
  }
});

// ==============================
// HUBNOTE SESSION STORE + UI
// ==============================
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

function buildHubnoteAddFilesEphemeral({ sessionId }) {
  return {
    text: "✅ Note created. Add files to the note?",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "✅ *Note created.* Add files to the note?" },
      },
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
            "Select file(s) to attach.\n\n" +
            "_Tip: upload the file(s) to Slack first, then search/select them here._",
        },
      },
      {
        type: "input",
        block_id: "files_select_block",
        label: { type: "plain_text", text: "Files to attach" },
        element: {
          type: "multi_external_select",
          action_id: "hubnote_files_select",
          placeholder: { type: "plain_text", text: "Search your Slack files" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        optional: true,
        block_id: "attach_note_block",
        label: { type: "plain_text", text: "Optional message" },
        element: {
          type: "plain_text_input",
          action_id: "attach_note_input",
          multiline: true,
          placeholder: { type: "plain_text", text: "Anything to add about these attachments?" },
        },
      },
    ],
  };
}

// ==============================
// /zapier/hubnote/callback  (Zap Step 3 target)
// ==============================
//
// Zap Step 3 (Webhooks by Zapier -> Custom Request)
// POST https://<render>/zapier/hubnote/callback
// Headers:
//   Content-Type: application/json
//   (optional) x-zapier-secret: <ZAPIER_HUBNOTE_SECRET>
//
// Body should be the JSON returned from Step 2:
//  - status: "success"
//  - correlation_id
//  - hubspot_note_id
//  - hubspot_object_type
//  - hubspot_object_id
//  - origin_channel_id
//  - origin_user_id
//
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
      correlationId: correlation_id || "",
      hubspotNoteId: String(hubspot_note_id),
      hubspotObjectType: hubspot_object_type === "deal" ? "deal" : "ticket",
      hubspotObjectId: hubspot_object_id ? String(hubspot_object_id) : "",
      originChannelId: origin_channel_id,
      originUserId: origin_user_id,
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

// ==============================
// Ephemeral button handlers (YES/NO)
// ==============================
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

// ✅ FIX: YES now opens the Attach modal directly (no DM dependency)
app.action("hubnote_add_files_yes", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const sessionId = body?.actions?.[0]?.value || "";
    const session = hubnoteGetSession(sessionId);

    const channelId = body?.channel?.id;
    const userId = body?.user?.id;

    if (!session) {
      if (channelId && userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "⚠️ That attachment session expired. Please run /hubnote again if needed.",
        });
      }
      return;
    }

    // This is critical: views.open needs a trigger_id from the interaction payload
    if (!body?.trigger_id) {
      if (channelId && userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "⚠️ Slack didn’t provide a trigger_id for this click. Try clicking again.",
        });
      }
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildHubnoteAttachModal({ sessionId }),
    });
  } catch (e) {
    logger.error(e);
  }
});

// ==============================
// Options loader: Slack file search (requires files:read scope)
// ==============================
app.options("hubnote_files_select", async ({ ack, body, options, client, logger }) => {
  try {
    const sessionId = parsePrivateMetadata(body?.view?.private_metadata)?.sessionId || "";
    const session = hubnoteGetSession(sessionId);

    if (!session) {
      return await ack({
        options: [option("Session expired — run /hubnote again", "SESSION_EXPIRED")],
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
        const label = (f.title || f.name || `File ${f.id}`).slice(0, 75);
        return option(label, f.id);
      });

    if (!filtered.length) {
      return await ack({
        options: [option("No matching files found", "NO_FILES_FOUND")],
      });
    }

    await ack({ options: filtered });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [option("ERROR loading files (check scopes/logs)", "ERROR_LOADING_FILES")],
    });
  }
});

// ==============================
// Attach modal submit
// ==============================
//
// NOTE: This only returns the Slack file IDs. Uploading bytes to HubSpot
// is typically done in Zapier using Slack File download + HubSpot file upload + associate.
// If your Zap currently expects to handle the file part later, keep this as-is.
//
app.view("hubnote_attach_modal_submit", async ({ ack, body, view, client, logger }) => {
  try {
    const meta = parsePrivateMetadata(view.private_metadata);
    const sessionId = meta.sessionId || "";
    const session = hubnoteGetSession(sessionId);

    if (!session) {
      await ack();
      return;
    }

    const selected =
      view.state.values.files_select_block.hubnote_files_select.selected_options || [];

    const slackFileIds = selected.map((o) => o.value).filter(Boolean);

    if (!slackFileIds.length) {
      await ack({
        response_action: "errors",
        errors: { files_select_block: "Select at least one file." },
      });
      return;
    }

    await ack();

    const attachNote =
      view.state.values.attach_note_block?.attach_note_input?.value?.trim() || "";

    // For now we just confirm success to the user.
    // If you want Zap handling: add a Zapier webhook call here (optional).
    await client.chat.postMessage({
      channel: session.originUserId,
      text:
        `✅ Got it. Selected ${slackFileIds.length} file(s).\n` +
        `• Slack File IDs: ${slackFileIds.join(", ")}\n` +
        (attachNote ? `• Note: ${attachNote}` : ""),
    });

    // Keep session alive in case user adds more; or delete it:
    // hubnoteDeleteSession(sessionId);
  } catch (e) {
    logger.error(e);
    try {
      await ack();
    } catch (_) {}
  }
});

// ==============================
// START SERVER
// ==============================
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ SyllaBot is running (cstask + hubnote v2)");
})();
