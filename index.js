/**
 * index.js — SyllaBot (Slack Bolt + Express) on Render
 *
 * ✅ /cstask remains untouched (verbatim from your commit)
 * ✅ /hubnote v1 remains functional (trigger with: /hubnote v1)
 * ✅ /hubnote v2 is now the default (dynamic lookups: Record Type → Pipeline → Stage → Record)
 * ✅ Keeps your split endpoints, metadata helpers, logging style, error handling patterns
 * ✅ Keeps your existing Hubnote “Add files?” → DM → Attach modal flow intact
 *
 * REQUIRED ENV VARS (existing):
 * - SLACK_SIGNING_SECRET
 * - SLACK_BOT_TOKEN
 * - MONDAY_API_TOKEN
 * - ZAPIER_WEBHOOK_URL (for /cstask)
 *
 * REQUIRED ENV VARS (hubnote):
 * - ZAPIER_HUBNOTE_WEBHOOK_URL (SyllaBot -> Zapier: create note + associate)
 * - HUBSPOT_PRIVATE_APP_TOKEN (SyllaBot -> HubSpot: dynamic lookups)
 *
 * OPTIONAL ENV VARS (hubnote):
 * - ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL (SyllaBot -> Zapier: attach files)
 * - ZAPIER_HUBNOTE_SECRET (Zapier -> SyllaBot callback auth)
 *
 * SLACK SCOPES YOU’LL NEED FOR HUBNOTE:
 * - commands
 * - chat:write
 * - im:write (open DM after Yes)
 * - files:read (file picker)
 *
 * HubSpot stage properties (confirmed):
 * - Tickets: hs_pipeline_stage
 * - Deals: dealstage
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

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// HubSpot + hubnote config
const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
const ZAPIER_HUBNOTE_WEBHOOK_URL = process.env.ZAPIER_HUBNOTE_WEBHOOK_URL || "";
const ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL =
  process.env.ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL || "";
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
// BOLT APP
// ==============================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  // You can change to LogLevel.INFO later
  logLevel: LogLevel.DEBUG,
});

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

  // Cache only for empty search (when dropdown first opens)
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

  if (!s) {
    cache.boards = { at: now, options };
  }

  return options;
}

async function fetchGroups(boardId, search = "") {
  const now = Date.now();
  const s = (search || "").trim().toLowerCase();

  // Cache only for empty search (when dropdown first opens)
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

  if (!s) {
    cache.groupsByBoard.set(boardId, { at: now, options });
  }

  return options;
}

// ==============================
// HELPERS: metadata
// ==============================
function parsePrivateMetadata(md) {
  try {
    return JSON.parse(md || "{}");
  } catch {
    return {};
  }
}

function buildCleanViewPayload(view, privateMetadataString) {
  // Slack views.update expects a "view payload" schema (not Slack's returned view object)
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

// ==============================
// DYNAMIC DROPDOWNS (external_select options)
// ==============================

// Board dropdown options
app.options("board_select", async ({ options, ack, logger }) => {
  // For options, ack() IS the response; must be fast.
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
          text: {
            type: "plain_text",
            text: "ERROR loading boards (check Render logs)",
          },
          value: "ERROR_LOADING_BOARDS",
        },
      ],
    });
  }
});

// ✅ When a board is selected, store it in private_metadata (ack FIRST)
app.action("board_select", async ({ ack, body, client, logger }) => {
  await ack(); // MUST be within 3 seconds

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

// Group dropdown options (reads boardId from private_metadata)
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
            text: {
              type: "plain_text",
              text: "No groups found for this board",
            },
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
          text: {
            type: "plain_text",
            text: "ERROR loading groups (check Render logs)",
          },
          value: "ERROR_LOADING_GROUPS",
        },
      ],
    });
  }
});

// ==============================
// /cstask SLASH COMMAND -> OPEN MODAL
// ==============================
app.command("/cstask", async ({ ack, body, client, logger }) => {
  await ack(); // Must ack quickly

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "cstask_modal_submit",
        title: { type: "plain_text", text: "Create CS Task" },
        submit: { type: "plain_text", text: "Create" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({}), // we’ll store boardId here
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

          // ✅ Dynamic Board (dispatch_action required so app.action("board_select") fires reliably)
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

          // ✅ Dynamic Group (reads selected board from private_metadata)
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
// MODAL SUBMIT -> SEND TO ZAPIER
// ==============================
app.view("cstask_modal_submit", async ({ ack, body, view, client, logger }) => {
  // Validate quickly and ack appropriately
  const taskName =
    view.state.values.task_name_block.task_name_input.value?.trim() || "";
  const description =
    view.state.values.description_block?.description_input?.value?.trim() ||
    "";

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

  await ack(); // ack before doing slow network work

  // Owner email lookup (requires users:read + users:read.email + reinstall)
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

  // Send to Zapier
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

// ==============================
// /hubnote — v1 + v2 in one command
// - Default: v2 dynamic lookups
// - Run v1 explicitly: /hubnote v1
// ==============================
//
// ✅ Slack custom emojis used in ephemeral buttons:
// ✅ Yes = :meow_nod:
// ❌ No  = :bear-headshake:
//
// ✅ FILE FLOW (unchanged):
// callback -> ephemeral Yes/No -> if Yes DM -> Attach modal -> Zapier attach webhook
//
// NOTE: v2 dynamic lookups require HUBSPOT_PRIVATE_APP_TOKEN
//

// --------------------------------
// Shared session store for attachments (unchanged)
// --------------------------------
const HUBNOTE_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
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

// --------------------------------
// v1 UI builders (unchanged from your commit)
// --------------------------------
function buildHubnoteModalV1({ correlationId, originChannelId, originUserId }) {
  return {
    type: "modal",
    callback_id: "hubnote_modal_submit_v1",
    title: { type: "plain_text", text: "HubSpot Note" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({
      correlationId,
      originChannelId,
      originUserId,
      version: "v1",
    }),
    blocks: [
      {
        type: "input",
        block_id: "record_type_block",
        label: { type: "plain_text", text: "Record Type" },
        element: {
          type: "static_select",
          action_id: "record_type_select",
          placeholder: { type: "plain_text", text: "Select record type" },
          options: [
            { text: { type: "plain_text", text: "Ticket" }, value: "ticket" },
            { text: { type: "plain_text", text: "Deal" }, value: "deal" },
          ],
        },
      },
      {
        type: "input",
        block_id: "note_title_block",
        label: { type: "plain_text", text: "Note Title / Subject" },
        element: {
          type: "plain_text_input",
          action_id: "note_title_input",
          placeholder: { type: "plain_text", text: "e.g., Call recap" },
        },
      },
      {
        type: "input",
        block_id: "note_body_block",
        label: { type: "plain_text", text: "Note Body" },
        element: {
          type: "plain_text_input",
          action_id: "note_body_input",
          multiline: true,
          placeholder: { type: "plain_text", text: "Write your note..." },
        },
      },
      {
        type: "input",
        block_id: "record_identifier_block",
        label: { type: "plain_text", text: "Record Identifier" },
        hint: {
          type: "plain_text",
          text:
            "v1: Ticket ID/Number OR Deal ID/Name. Use /hubnote v1 to access this form anytime.",
        },
        element: {
          type: "plain_text_input",
          action_id: "record_identifier_input",
          placeholder: { type: "plain_text", text: "Paste identifier..." },
        },
      },
    ],
  };
}

// --------------------------------
// v2 (dynamic) HubSpot helpers + cache
// --------------------------------
const HS_CACHE_MS = 10 * 60 * 1000; // 10 min
const hsCache = {
  pipelines: new Map(), // key: "ticket"|"deal" -> { at, pipelines:[{id,label,stages:[{id,label}]}] }
};

const HS_TICKET_STAGE_PROP = "hs_pipeline_stage";
const HS_DEAL_STAGE_PROP = "dealstage";
const HS_PIPELINE_PROP = "pipeline";

function hsApiObjectType(recordType) {
  // HubSpot API endpoints use plural object names
  return recordType === "deal" ? "deals" : "tickets";
}

async function hubspotRequest(method, path, data) {
  if (!HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  }
  const res = await axios({
    method,
    url: `https://api.hubapi.com${path}`,
    data,
    headers: {
      Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 10000,
  });
  return res.data;
}

async function hsGetPipelines(recordType) {
  const now = Date.now();
  const cached = hsCache.pipelines.get(recordType);
  if (cached && cached.pipelines?.length && now - cached.at < HS_CACHE_MS) {
    return cached.pipelines;
  }

  const objectType = hsApiObjectType(recordType);
  const data = await hubspotRequest("GET", `/crm/v3/pipelines/${objectType}`);

  const pipelines = (data?.results || []).map((p) => ({
    id: String(p.id),
    label: p.label || String(p.id),
    stages: (p.stages || []).map((s) => ({
      id: String(s.id),
      label: s.label || String(s.id),
    })),
  }));

  hsCache.pipelines.set(recordType, { at: now, pipelines });
  return pipelines;
}

async function hsSearchRecords({ recordType, pipelineId, stageId, query }) {
  const objectType = hsApiObjectType(recordType);
  const stageProp = recordType === "deal" ? HS_DEAL_STAGE_PROP : HS_TICKET_STAGE_PROP;

  // Display properties
  const properties =
    recordType === "deal"
      ? ["dealname", HS_PIPELINE_PROP, HS_DEAL_STAGE_PROP]
      : ["subject", HS_PIPELINE_PROP, HS_TICKET_STAGE_PROP];

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: HS_PIPELINE_PROP, operator: "EQ", value: String(pipelineId) },
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

// --------------------------------
// v2 UI builders
// --------------------------------
function buildHubnoteModalV2({ correlationId, originChannelId, originUserId }) {
  return {
    type: "modal",
    callback_id: "hubnote_modal_submit_v2",
    title: { type: "plain_text", text: "HubSpot Note" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({
      correlationId,
      originChannelId,
      originUserId,
      version: "v2",
      recordType: "",
      pipelineId: "",
      stageId: "",
    }),
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
        block_id: "stage_block_v2",
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
        block_id: "record_block_v2",
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
        element: {
          type: "plain_text_input",
          action_id: "hubnote_v2_note_title_input",
          placeholder: { type: "plain_text", text: "e.g., Call recap" },
        },
      },
      {
        type: "input",
        block_id: "note_body_block_v2",
        label: { type: "plain_text", text: "Note Body" },
        element: {
          type: "plain_text_input",
          action_id: "hubnote_v2_note_body_input",
          multiline: true,
          placeholder: { type: "plain_text", text: "Write your note..." },
        },
      },
    ],
  };
}

// --------------------------------
// Shared ephemeral/DM/file UI builders (unchanged)
// --------------------------------
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

// --------------------------------
// /hubnote slash command
// - default opens v2
// - "/hubnote v1" opens v1
// --------------------------------
app.command("/hubnote", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const text = (body.text || "").trim().toLowerCase();
    const forceV1 = text === "v1";

    const correlationId = hubnoteMakeId("hubnote");

    if (forceV1) {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildHubnoteModalV1({
          correlationId,
          originChannelId: body.channel_id,
          originUserId: body.user_id,
        }),
      });
      return;
    }

    // Default: v2
    if (!HUBSPOT_PRIVATE_APP_TOKEN) {
      // If v2 can’t run, fall back gracefully to v1 (still functional)
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text:
          "⚠️ HUBSPOT_PRIVATE_APP_TOKEN is not configured, so dynamic lookups (v2) can’t load.\n" +
          "Opening the v1 form instead. (You can also run `/hubnote v1`.)",
      });

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildHubnoteModalV1({
          correlationId,
          originChannelId: body.channel_id,
          originUserId: body.user_id,
        }),
      });
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildHubnoteModalV2({
        correlationId,
        originChannelId: body.channel_id,
        originUserId: body.user_id,
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

// --------------------------------
// v1 submit handler (unchanged behavior; callback flow unchanged)
// --------------------------------
app.view("hubnote_modal_submit_v1", async ({ ack, body, view, client, logger }) => {
  const meta = parsePrivateMetadata(view.private_metadata);
  const correlationId = meta.correlationId || hubnoteMakeId("hubnote");
  const originChannelId = meta.originChannelId || body.user.id;
  const originUserId = meta.originUserId || body.user.id;

  const recordType =
    view.state.values.record_type_block.record_type_select.selected_option?.value || "";

  const noteTitle =
    view.state.values.note_title_block.note_title_input.value?.trim() || "";

  const noteBody =
    view.state.values.note_body_block.note_body_input.value?.trim() || "";

  const recordIdentifier =
    view.state.values.record_identifier_block.record_identifier_input.value?.trim() || "";

  const errors = {};
  if (!recordType) errors["record_type_block"] = "Please choose Ticket or Deal.";
  if (!noteTitle) errors["note_title_block"] = "Note title is required.";
  if (!noteBody) errors["note_body_block"] = "Note body is required.";
  if (!recordIdentifier) errors["record_identifier_block"] = "Record identifier is required.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

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
        version: "v1",
        correlation_id: correlationId,
        hubspot_object_type: recordType, // "ticket" | "deal"
        hubspot_record_identifier: recordIdentifier, // v1 text input
        note_title: noteTitle,
        note_body: noteBody,
        submitted_by_slack_user_id: body.user.id,
        submitted_at: new Date().toISOString(),
        origin_channel_id: originChannelId,
        origin_user_id: originUserId,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postEphemeral({
      channel: originChannelId,
      user: originUserId,
      text: "⏳ Creating note in HubSpot…",
    });
  } catch (e) {
    logger.error(e);
    await client.chat.postEphemeral({
      channel: originChannelId,
      user: originUserId,
      text: "❌ I couldn’t send the note to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// --------------------------------
// v2 action handlers to store selections into private_metadata
// (reuses your buildCleanViewPayload helper)
// --------------------------------
async function hubnoteV2UpdateMeta({ body, client, logger, patch }) {
  try {
    const view = body?.view;
    if (!view?.id) return;

    const meta = parsePrivateMetadata(view.private_metadata);
    Object.assign(meta, patch);

    const cleanView = buildCleanViewPayload(view, JSON.stringify(meta));

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: cleanView,
    });
  } catch (e) {
    logger.error(e);
  }
}

app.action("hubnote_v2_record_type_select", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const recordType = body?.actions?.[0]?.selected_option?.value || "";
    if (!recordType) return;

    // clear downstream dependencies when type changes
    await hubnoteV2UpdateMeta({
      body,
      client,
      logger,
      patch: { recordType, pipelineId: "", stageId: "" },
    });
  } catch (e) {
    logger.error(e);
  }
});

app.action("hubnote_v2_pipeline_select", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const pipelineId = body?.actions?.[0]?.selected_option?.value || "";
    if (!pipelineId) return;

    // clear stage when pipeline changes
    await hubnoteV2UpdateMeta({
      body,
      client,
      logger,
      patch: { pipelineId, stageId: "" },
    });
  } catch (e) {
    logger.error(e);
  }
});

app.action("hubnote_v2_stage_select", async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const stageId = body?.actions?.[0]?.selected_option?.value || "";
    if (!stageId) return;

    await hubnoteV2UpdateMeta({
      body,
      client,
      logger,
      patch: { stageId },
    });
  } catch (e) {
    logger.error(e);
  }
});

// --------------------------------
// v2 options loaders (external_select)
// --------------------------------
app.options("hubnote_v2_pipeline_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "";

    if (!recordType) {
      return await ack({
        options: [
          { text: { type: "plain_text", text: "Select Record Type first" }, value: "SELECT_RECORD_TYPE_FIRST" },
        ],
      });
    }

    const pipelines = await hsGetPipelines(recordType);
    const q = (options?.value || "").trim().toLowerCase();

    const out = pipelines
      .filter((p) => !q || (p.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((p) => ({
        text: { type: "plain_text", text: p.label.slice(0, 75) },
        value: String(p.id),
      }));

    await ack({
      options: out.length ? out : [{ text: { type: "plain_text", text: "No pipelines found" }, value: "NO_PIPELINES" }],
    });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading pipelines (check logs)" }, value: "ERR_PIPELINES" }],
    });
  }
});

app.options("hubnote_v2_stage_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "";
    const pipelineId = meta.pipelineId || "";

    if (!recordType) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select Record Type first" }, value: "SELECT_RECORD_TYPE_FIRST" }],
      });
    }
    if (!pipelineId) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select a Pipeline first" }, value: "SELECT_PIPELINE_FIRST" }],
      });
    }

    const pipelines = await hsGetPipelines(recordType);
    const pipeline = pipelines.find((p) => p.id === String(pipelineId));
    const stages = pipeline?.stages || [];

    const q = (options?.value || "").trim().toLowerCase();

    const out = stages
      .filter((s) => !q || (s.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((s) => ({
        text: { type: "plain_text", text: s.label.slice(0, 75) },
        value: String(s.id),
      }));

    await ack({
      options: out.length ? out : [{ text: { type: "plain_text", text: "No stages found" }, value: "NO_STAGES" }],
    });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading stages (check logs)" }, value: "ERR_STAGES" }],
    });
  }
});

app.options("hubnote_v2_record_select", async ({ ack, body, options, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "";
    const pipelineId = meta.pipelineId || "";
    const stageId = meta.stageId || "";

    if (!recordType) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select Record Type first" }, value: "SELECT_RECORD_TYPE_FIRST" }],
      });
    }
    if (!pipelineId) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select a Pipeline first" }, value: "SELECT_PIPELINE_FIRST" }],
      });
    }
    if (!stageId) {
      return await ack({
        options: [{ text: { type: "plain_text", text: "Select a Stage first" }, value: "SELECT_STAGE_FIRST" }],
      });
    }

    const q = options?.value || "";
    const records = await hsSearchRecords({ recordType, pipelineId, stageId, query: q });

    const out = records.slice(0, 100).map((r) => ({
      text: { type: "plain_text", text: r.label.slice(0, 75) },
      value: String(r.id),
    }));

    await ack({
      options: out.length ? out : [{ text: { type: "plain_text", text: "No records found" }, value: "NO_RECORDS" }],
    });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [{ text: { type: "plain_text", text: "ERROR loading records (check logs)" }, value: "ERR_RECORDS" }],
    });
  }
});

// --------------------------------
// v2 submit handler -> Zapier (resolved record id)
// --------------------------------
app.view("hubnote_modal_submit_v2", async ({ ack, body, view, client, logger }) => {
  const meta = parsePrivateMetadata(view.private_metadata);
  const correlationId = meta.correlationId || hubnoteMakeId("hubnote");
  const originChannelId = meta.originChannelId || body.user.id;
  const originUserId = meta.originUserId || body.user.id;

  const recordType = meta.recordType || "";
  const pipelineId = meta.pipelineId || "";
  const stageId = meta.stageId || "";

  const recordId =
    view.state.values.record_block_v2.hubnote_v2_record_select.selected_option?.value || "";

  const noteTitle =
    view.state.values.note_title_block_v2.hubnote_v2_note_title_input.value?.trim() || "";

  const noteBody =
    view.state.values.note_body_block_v2.hubnote_v2_note_body_input.value?.trim() || "";

  const errors = {};
  if (!recordType) errors["record_type_block_v2"] = "Select Ticket or Deal.";
  if (!pipelineId) errors["pipeline_block_v2"] = "Select a pipeline.";
  if (!stageId) errors["stage_block_v2"] = "Select a stage.";
  if (!recordId) errors["record_block_v2"] = "Select a record.";
  if (!noteTitle) errors["note_title_block_v2"] = "Note title is required.";
  if (!noteBody) errors["note_body_block_v2"] = "Note body is required.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

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
        correlation_id: correlationId,
        hubspot_object_type: recordType, // "ticket" | "deal"
        hubspot_object_id: recordId,     // ✅ resolved
        hubspot_pipeline_id: pipelineId,
        hubspot_stage_id: stageId,
        note_title: noteTitle,
        note_body: noteBody,
        submitted_by_slack_user_id: body.user.id,
        submitted_at: new Date().toISOString(),
        origin_channel_id: originChannelId,
        origin_user_id: originUserId,
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postEphemeral({
      channel: originChannelId,
      user: originUserId,
      text: "⏳ Creating note in HubSpot…",
    });
  } catch (e) {
    logger.error(e);
    await client.chat.postEphemeral({
      channel: originChannelId,
      user: originUserId,
      text: "❌ I couldn’t send the note to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// --------------------------------
// Zapier -> SyllaBot callback (note created) -> ephemeral Yes/No in origin
// (unchanged; works for both v1 and v2)
// --------------------------------
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
      return res
        .status(400)
        .json({ ok: false, error: "missing origin_channel_id/origin_user_id" });
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
      dmChannelId: "", // filled when user clicks YES
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

// --------------------------------
// Ephemeral button handlers: YES/NO (unchanged)
// --------------------------------
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
          text: "⚠️ That attachment session expired. Please run /hubnote again if needed.",
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

// --------------------------------
// DM button: open Attach Files modal (unchanged)
// --------------------------------
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

// --------------------------------
// Options loader for selecting Slack files (unchanged)
// --------------------------------
app.options("hubnote_files_select", async ({ ack, body, options, client, logger }) => {
  try {
    const sessionId =
      parsePrivateMetadata(body?.view?.private_metadata)?.sessionId || "";
    const session = hubnoteGetSession(sessionId);

    if (!session) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "Session expired — reopen /hubnote" },
            value: "SESSION_EXPIRED",
          },
        ],
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
        return {
          text: { type: "plain_text", text: label.slice(0, 75) },
          value: String(f.id),
        };
      });

    if (!filtered.length) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "No matching files found" },
            value: "NO_FILES_FOUND",
          },
        ],
      });
    }

    await ack({ options: filtered });
  } catch (e) {
    logger.error(e);
    await ack({
      options: [
        {
          text: {
            type: "plain_text",
            text: "ERROR loading files (check scopes/logs)",
          },
          value: "ERROR_LOADING_FILES",
        },
      ],
    });
  }
});

// --------------------------------
// Attach modal submit -> forward selected file IDs to Zapier (unchanged)
// --------------------------------
app.view("hubnote_attach_modal_submit", async ({ ack, body, view, client, logger }) => {
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

  if (!ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL) {
    await client.chat.postMessage({
      channel: session.dmChannelId || body.user.id,
      text:
        "⚠️ Files selected, but ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL is not set.\n" +
        "Set it in Render env vars to enable file attachment routing.",
    });
    return;
  }

  try {
    await axios.post(
      ZAPIER_HUBNOTE_ATTACH_WEBHOOK_URL,
      {
        source: "slack",
        command_name: "hubnote",
        version: "v1-attach",
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
  console.log("⚡️ SyllaBot is running (cstask + hubnote v1/v2 + attachments)");
})();
