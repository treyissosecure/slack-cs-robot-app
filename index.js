/**
 * index.js — SyllaBot (Render)
 *
 * ✅ /cstask: Monday task modal + sends to Zapier webhook
 * ✅ /hubnote v2: HubSpot note modal (Record Type → Pipeline → Stage → Record)
 * ✅ Zapier middleware endpoints:
 *    - POST /api/hubnote/create
 *    - POST /zapier/hubnote/callback
 * ✅ “Add files?” Yes button opens an Attach Files modal (and confirms upload).
 *
 * -------------------------------------------------------
 * Required ENV VARS (Render)
 * -------------------------------------------------------
 * SLACK_SIGNING_SECRET
 * SLACK_BOT_TOKEN
 * MONDAY_API_TOKEN
 * ZAPIER_WEBHOOK_URL                 (used by /cstask)
 *
 * HUBSPOT_PRIVATE_APP_TOKEN          (used by /api/hubnote/create)
 *
 * Optional:
 * ZAPIER_HUBNOTE_TRIGGER_URL         (if /hubnote should hit a different Catch Hook)
 * HUBNOTE_ZAPIER_SECRET              (if set, Zap Step 2 must send header x-zapier-secret)
 * ZAPIER_HUBNOTE_SECRET              (if set, Zap Step 3 must send header x-zapier-secret)
 */

const { App, ExpressReceiver, LogLevel } = require("@slack/bolt");
const axios = require("axios");
const express = require("express");
const crypto = require("crypto");
// HubSpot default property internal names (allow override via env)
const HS_TICKET_PIPELINE_PROP = process.env.HS_TICKET_PIPELINE_PROP || "hs_pipeline";
const HS_TICKET_STAGE_PROP    = process.env.HS_TICKET_STAGE_PROP    || "hs_pipeline_stage";

const HS_DEAL_PIPELINE_PROP   = process.env.HS_DEAL_PIPELINE_PROP   || "pipeline";
const HS_DEAL_STAGE_PROP      = process.env.HS_DEAL_STAGE_PROP      || "dealstage";

// ==============================
// CONFIG
// ==============================
const PORT = process.env.PORT || 10000;

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || "";
const ZAPIER_HUBNOTE_TRIGGER_URL = process.env.ZAPIER_HUBNOTE_TRIGGER_URL || "";

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN || "";

const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";

// Optional auth between Zapier ↔ SyllaBot
const HUBNOTE_ZAPIER_SECRET =
  process.env.HUBNOTE_ZAPIER_SECRET || process.env.ZAPIER_HUBNOTE_SECRET || "";
const ZAPIER_HUBNOTE_SECRET = process.env.ZAPIER_HUBNOTE_SECRET || "";

// ==============================
// SLACK RECEIVER
// ==============================
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
    actions: "/slack/interactions", // interactive + options load URL
  },
});

// Request logging (safe; keep while debugging)
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

// Body parser for our custom endpoints
receiver.app.use(express.json({ limit: "2mb" }));

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

// Slack view.state.values shifts if block_id changes.
// Find selected_option.value by action_id regardless of block_id.
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

function requireZapierSecret(req, res, expectedSecret) {
  if (!expectedSecret) return true; // auth disabled
  const got = req.headers["x-zapier-secret"];
  if (got !== expectedSecret) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// ==============================
// MONDAY API HELPERS (for /cstask)
// ==============================
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

const CACHE_MS = 60 * 1000;
const mondayCache = {
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

  if (!s && mondayCache.boards.options.length && now - mondayCache.boards.at < CACHE_MS) {
    return mondayCache.boards.options;
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

  if (!s) mondayCache.boards = { at: now, options };
  return options;
}

async function fetchGroups(boardId, search = "") {
  const now = Date.now();
  const s = (search || "").trim().toLowerCase();

  if (!s) {
    const cached = mondayCache.groupsByBoard.get(boardId);
    if (cached?.options?.length && now - cached.at < CACHE_MS) {
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

  if (!s) mondayCache.groupsByBoard.set(boardId, { at: now, options });
  return options;
}

// ==============================
// Monday external_select options
// ==============================
app.options("board_select", async ({ options, ack, logger }) => {
  try {
    const search = options?.value || "";
    const boardOptions = await fetchBoards(search);

    await ack({
      options:
        boardOptions.length > 0
          ? boardOptions
          : [
              {
                text: { type: "plain_text", text: "No boards found" },
                value: "NO_BOARDS_FOUND",
              },
            ],
    });
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

    await ack({
      options:
        groupOptions.length > 0
          ? groupOptions
          : [
              {
                text: {
                  type: "plain_text",
                  text: "No groups found for this board",
                },
                value: "NO_GROUPS_FOUND",
              },
            ],
    });
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
// /cstask (keep behavior)
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
        text: "❌ I couldn’t open the task form. Please try again.",
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
      text:
        "❌ ZAPIER_WEBHOOK_URL is missing. Add it in Render env vars and redeploy.",
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
      text:
        "❌ I couldn’t send that task to Zapier. Check Zapier + Render logs and try again.",
    });
  }
});

// ==============================
// HUBNOTE v2 — modal + HubSpot helpers
// ==============================
const HS_CACHE_MS = 10 * 60 * 1000; // 10 min
const hsCache = {
  pipelines: new Map(), // key: "ticket"|"deal" -> { at, pipelines }
  assocTypeId: new Map(), // key: "tickets"|"deals" -> { at, id }
};

const HS_PIPELINE_PROP_DEAL = "pipeline";
const HS_PIPELINE_PROP_TICKET = "hs_pipeline";

function hsApiObjectType(recordType) {
  return recordType === "deal" ? "deals" : "tickets";
}

async function hubspotRequest(method, path, data) {
  if (!HUBSPOT_PRIVATE_APP_TOKEN) throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  const url = `https://api.hubapi.com${path}`;
  const res = await axios({
    method,
    url,
    data,
    headers: {
      Authorization: `Bearer ${HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    timeout: 8000,
  });
  return res.data;
}

async function hsGetPipelines(recordType) {
  const key = recordType === "deal" ? "deal" : "ticket";
  const now = Date.now();
  const cached = hsCache.pipelines.get(key);
  if (cached?.pipelines?.length && now - cached.at < HS_CACHE_MS) {
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
  // HubSpot object types are plural in the v3 objects API
  const objectTypePlural = recordType === "deal" ? "deals" : "tickets";
  const trimmedQuery = (query ?? "").trim();
  const baseRequest = {
    filterGroups: [],
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties:
      recordType === "deal"
        ? ["dealname", pipelineProp, stageProp, "amount"]
        : ["subject", pipelineProp, stageProp, "hs_ticket_priority", "createdate"],
    limit: 20,
  };

  // Helper to run a search with optional stage/pipeline filters
  const runSearch = async ({ includeFilters }) => {
    const filterGroups = [];
    if (includeFilters) {
      const filters = [];
      if (pipelineId) filters.push({ propertyName: pipelineProp, operator: "EQ", value: String(pipelineId) });
      if (stageId) filters.push({ propertyName: stageProp, operator: "EQ", value: String(stageId) });
      if (filters.length) filterGroups.push({ filters });
    }
    if (trimmedQuery) {
      // Search by deal name or ticket subject
      const qProp = recordType === "deal" ? "dealname" : "subject";
      filterGroups.push({ filters: [{ propertyName: qProp, operator: "CONTAINS_TOKEN", value: trimmedQuery }] });
    }

    const payload = { ...baseRequest, filterGroups };
    logger.debug(`[HS] search ${objectTypePlural}: includeFilters=${includeFilters} pipelineId=${pipelineId} stageId=${stageId} q="${trimmedQuery}"`);
    return await hubspotRequest(`/crm/v3/objects/${objectTypePlural}/search`, { method: "POST", body: payload });
  };

  try {
    // 1) Try strict (pipeline+stage) filter
    const strictRes = await runSearch({ includeFilters: true });
    const strictResults = Array.isArray(strictRes?.results) ? strictRes.results : [];

    if (strictResults.length > 0) {
      logger.debug(`[HS] search ${objectTypePlural} strict results: ${strictResults.length} (total=${strictRes.total ?? "?"})`);
      return strictResults.map((r) => ({
        id: r.id,
        label:
          recordType === "deal"
            ? r.properties?.dealname || `Deal ${r.id}`
            : r.properties?.subject || `Ticket ${r.id}`,
      }));
    }

    // 2) Fallback: if strict returns 0, try *without* pipeline/stage filters
    // This helps when the stored values differ from what the pipelines endpoint returns, or if permissions prevent filtering.
    const looseRes = await runSearch({ includeFilters: false });
    const looseResults = Array.isArray(looseRes?.results) ? looseRes.results : [];

    logger.debug(
      `[HS] search ${objectTypePlural} fallback results: ${looseResults.length} (total=${looseRes.total ?? "?"}); strict was 0`
    );

    return looseResults.map((r) => ({
      id: r.id,
      label:
        recordType === "deal"
          ? r.properties?.dealname || `Deal ${r.id}`
          : r.properties?.subject || `Ticket ${r.id}`,
    }));
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const msg = err?.message || String(err);
    const details =
      err?.body ||
      err?.response?.data ||
      err?.response?.body ||
      undefined;

    logger.error(`[HS] search ${objectTypePlural} failed: status=${status ?? "?"} msg=${msg}`);
    if (details) logger.error(`[HS] search error details: ${safeJson(details)}`);

    return [];
  }
}

async function hsCreateNoteAndAssociate({ hubspot_object_type, hubspot_object_id, note_title, note_body }) {
  const toPlural = hubspot_object_type === "deal" ? "deals" : "tickets";
  const assocTypeId = await hsGetNoteAssociationTypeId(toPlural);

  // HubSpot note UI: hs_note_body only. We bold title at top.
  const combinedBody = `**${(note_title || "Note").trim()}**\n${(note_body || "").trim()}`;

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

function getPlainTextInputValue(viewStateValues, blockId, actionId) {
  try {
    return viewStateValues?.[blockId]?.[actionId]?.value ?? "";
  } catch {
    return "";
  }
}

function bump(meta, key) {
  meta[key] = Number(meta[key] || 0) + 1;
  return meta[key];
}

function buildHubnoteModalV2({
  correlationId,
  originChannelId,
  originUserId,
  recordType = "ticket",
  pipelineId = "",
  stageId = "",
  // nonces used to force Slack to clear dependent selects
  noncePipeline = 0,
  nonceStage = 0,
  nonceRecord = 0,
  // preserve typed text when we rebuild the view
  noteTitleInitial = "",
  noteBodyInitial = "",
} = {}) {
  const meta = {
    correlationId,
    originChannelId,
    originUserId,
    version: "v2",
    recordType,
    pipelineId,
    stageId,
    noncePipeline,
    nonceStage,
    nonceRecord,
  };

  // Changing block_id forces Slack to discard previous state for that input.
  const pipelineBlockId = `pipeline_block_v2_${noncePipeline}`;
  const stageBlockId = `stage_block_v2_${nonceStage}`;
  const recordBlockId = `record_block_v2_${nonceRecord}`;

  return {
    type: "modal",
    callback_id: "hubnote_modal_submit_v2",
    title: { type: "plain_text", text: "HubSpot Note", emoji: true },
    submit: { type: "plain_text", text: "Create", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    clear_on_close: false,
    notify_on_close: false,
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: "input",
        block_id: "record_type_block_v2",
        label: { type: "plain_text", text: "Record Type", emoji: true },
        optional: false,
        dispatch_action: true,
        element: {
          type: "static_select",
          action_id: "hubnote_v2_record_type_select",
          placeholder: { type: "plain_text", text: "Ticket or Deal", emoji: true },
          initial_option: {
            text: { type: "plain_text", text: recordType === "deal" ? "Deal" : "Ticket", emoji: true },
            value: recordType === "deal" ? "deal" : "ticket",
          },
          options: [
            { text: { type: "plain_text", text: "Ticket", emoji: true }, value: "ticket" },
            { text: { type: "plain_text", text: "Deal", emoji: true }, value: "deal" },
          ],
        },
      },
      {
        type: "input",
        block_id: pipelineBlockId,
        label: { type: "plain_text", text: "Pipeline", emoji: true },
        optional: false,
        dispatch_action: true,
        element: {
          type: "external_select",
          action_id: "hubnote_v2_pipeline_select",
          placeholder: { type: "plain_text", text: "Select a pipeline", emoji: true },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: stageBlockId,
        label: { type: "plain_text", text: "Pipeline Stage", emoji: true },
        optional: false,
        dispatch_action: true,
        element: {
          type: "external_select",
          action_id: "hubnote_v2_stage_select",
          placeholder: { type: "plain_text", text: "Select a stage", emoji: true },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: recordBlockId,
        label: { type: "plain_text", text: "Record", emoji: true },
        optional: false,
        element: {
          type: "external_select",
          action_id: "hubnote_v2_record_select",
          placeholder: { type: "plain_text", text: "Search/select a record", emoji: true },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "note_title_block_v2",
        label: { type: "plain_text", text: "Note Title / Subject", emoji: true },
        optional: false,
        element: {
          type: "plain_text_input",
          action_id: "hubnote_v2_note_title_input",
          placeholder: { type: "plain_text", text: "e.g., Call recap", emoji: true },
          initial_value: noteTitleInitial || undefined,
        },
      },
      {
        type: "input",
        block_id: "note_body_block_v2",
        label: { type: "plain_text", text: "Note Body", emoji: true },
        optional: false,
        element: {
          type: "plain_text_input",
          action_id: "hubnote_v2_note_body_input",
          placeholder: { type: "plain_text", text: "Write your note...", emoji: true },
          multiline: true,
          initial_value: noteBodyInitial || undefined,
        },
      },
    ],
  };
}

// ==============================
// HUBNOTE v2 COMMAND
app.command("/hubnote", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    // Warm pipelines cache in the background to help options ack within 3s.
    hsGetPipelines("ticket").catch(() => {});
    hsGetPipelines("deal").catch(() => {});

    const correlationId = `hubnote_${crypto.randomBytes(12).toString("hex")}`;

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
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: "❌ I couldn’t open the HubSpot note form. Please try again.",
      });
    } catch (_) {}
  }
});

// When Record Type changes, wipe pipeline + stage in metadata so downstream selects refresh.
app.action("hubnote_v2_record_type_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const view = body?.view;
    if (!view?.id) return;

    const selectedRecordType = body?.actions?.[0]?.selected_option?.value || "ticket";

    const meta = parsePrivateMetadata(view.private_metadata);
    meta.recordType = selectedRecordType;

    // Reset dependent selects
    meta.pipelineId = "";
    meta.stageId = "";
    bump(meta, "noncePipeline");
    bump(meta, "nonceStage");
    bump(meta, "nonceRecord");

    // Preserve any typed text
    const noteTitleInitial = getPlainTextInputValue(view.state?.values, "note_title_block_v2", "hubnote_v2_note_title_input");
    const noteBodyInitial = getPlainTextInputValue(view.state?.values, "note_body_block_v2", "hubnote_v2_note_body_input");

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: buildHubnoteModalV2({
        correlationId: meta.correlationId,
        originChannelId: meta.originChannelId,
        originUserId: meta.originUserId,
        recordType: meta.recordType,
        pipelineId: meta.pipelineId,
        stageId: meta.stageId,
        noncePipeline: meta.noncePipeline,
        nonceStage: meta.nonceStage,
        nonceRecord: meta.nonceRecord,
        noteTitleInitial,
        noteBodyInitial,
      }),
    });
  } catch (e) {
    logger.error(e);
  }
});

// Pipelines dropdown options
app.options("hubnote_v2_pipeline_select", async ({ body, options, ack, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";

    const cached = hsCache.pipelines.get(recordType)?.pipelines;
    if (!cached?.length) {
      // fire-and-forget fetch; show a friendly retry option
      hsGetPipelines(recordType).catch(() => {});
      return await ack({
        options: [option("Loading pipelines… try again", "__loading__")],
      });
    }

    const q = (options?.value || "").trim().toLowerCase();
    const matched = cached
      .filter((p) => !q || (p.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((p) => option(p.label, p.id));

    await ack({ options: matched.length ? matched : [option("No results", "__none__")] });
  } catch (e) {
    logger.error(e);
    await ack({ options: [option("Error loading pipelines", "__error__")] });
  }
});

// When Pipeline changes, store pipelineId, clear stageId
app.action("hubnote_v2_pipeline_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const view = body?.view;
    if (!view?.id) return;

    const selectedPipelineId = body?.actions?.[0]?.selected_option?.value || "";

    const meta = parsePrivateMetadata(view.private_metadata);
    meta.pipelineId = selectedPipelineId;

    // Reset downstream
    meta.stageId = "";
    bump(meta, "nonceStage");
    bump(meta, "nonceRecord");

    const noteTitleInitial = getPlainTextInputValue(view.state?.values, "note_title_block_v2", "hubnote_v2_note_title_input");
    const noteBodyInitial = getPlainTextInputValue(view.state?.values, "note_body_block_v2", "hubnote_v2_note_body_input");

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: buildHubnoteModalV2({
        correlationId: meta.correlationId,
        originChannelId: meta.originChannelId,
        originUserId: meta.originUserId,
        recordType: meta.recordType || "ticket",
        pipelineId: meta.pipelineId,
        stageId: meta.stageId,
        noncePipeline: meta.noncePipeline || 0,
        nonceStage: meta.nonceStage || 0,
        nonceRecord: meta.nonceRecord || 0,
        noteTitleInitial,
        noteBodyInitial,
      }),
    });
  } catch (e) {
    logger.error(e);
  }
});

// Stages dropdown options (dependent on pipelineId)
app.options("hubnote_v2_stage_select", async ({ body, options, ack, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";
    const pipelineId = meta.pipelineId || "";

    if (!pipelineId || pipelineId === "__loading__") {
      return await ack({ options: [option("Select a pipeline first", "__select_pipeline__")] });
    }

    const pipelines = hsCache.pipelines.get(recordType)?.pipelines;
    if (!pipelines?.length) {
      hsGetPipelines(recordType).catch(() => {});
      return await ack({ options: [option("Loading stages… try again", "__loading__")] });
    }

    const pipeline = pipelines.find((p) => String(p.id) === String(pipelineId));
    const stages = pipeline?.stages || [];

    const q = (options?.value || "").trim().toLowerCase();
    const matched = stages
      .filter((s) => !q || (s.label || "").toLowerCase().includes(q))
      .slice(0, 100)
      .map((s) => option(s.label, s.id));

    await ack({ options: matched.length ? matched : [option("No results", "__none__")] });
  } catch (e) {
    logger.error(e);
    await ack({ options: [option("Error loading stages", "__error__")] });
  }
});

// When Stage changes, store stageId
app.action("hubnote_v2_stage_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const view = body?.view;
    if (!view?.id) return;

    const selectedStageId = body?.actions?.[0]?.selected_option?.value || "";

    const meta = parsePrivateMetadata(view.private_metadata);
    meta.stageId = selectedStageId;

    // Reset downstream record select
    bump(meta, "nonceRecord");

    const noteTitleInitial = getPlainTextInputValue(view.state?.values, "note_title_block_v2", "hubnote_v2_note_title_input");
    const noteBodyInitial = getPlainTextInputValue(view.state?.values, "note_body_block_v2", "hubnote_v2_note_body_input");

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: buildHubnoteModalV2({
        correlationId: meta.correlationId,
        originChannelId: meta.originChannelId,
        originUserId: meta.originUserId,
        recordType: meta.recordType || "ticket",
        pipelineId: meta.pipelineId || "",
        stageId: meta.stageId || "",
        noncePipeline: meta.noncePipeline || 0,
        nonceStage: meta.nonceStage || 0,
        nonceRecord: meta.nonceRecord || 0,
        noteTitleInitial,
        noteBodyInitial,
      }),
    });
  } catch (e) {
    logger.error(e);
  }
});

// Record dropdown options (dependent on recordType + pipelineId + stageId)
app.options("hubnote_v2_record_select", async ({ body, options, ack, logger }) => {
  try {
    const meta = parsePrivateMetadata(body?.view?.private_metadata);
    const recordType = meta.recordType || "ticket";
    const pipelineId = meta.pipelineId || "";
    const stageId = meta.stageId || "";

    if (!pipelineId || pipelineId === "__loading__") {
      return await ack({ options: [option("Select a pipeline first", "__select_pipeline__")] });
    }
    if (!stageId || stageId === "__loading__") {
      return await ack({ options: [option("Select a stage first", "__select_stage__")] });
    }

    const query = options?.value || "";

    // Ensure ack under 3 seconds.
    const records = await Promise.race([
      hsSearchRecords({ recordType, pipelineId, stageId, query }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500)),
    ]);

    const mapped = (records || []).slice(0, 100).map((r) => option(r.label, r.id));
    logger.debug(`[Slack] record_select options: recordType=${recordType} pipelineId=${pipelineId} stageId=${stageId} q="${query}" -> ${mapped.length}`);
    await ack({ options: mapped });
  } catch (e) {
    if (String(e.message || "").includes("timeout")) {
      return await ack({ options: [option("Search timed out — try again", "__timeout__")] });
    }
    logger.error(e);
    await ack({ options: [option("Error searching records", "__error__")] });
  }
});

// ==============================
// Hubnote submit handler (posts to Zapier Catch Hook)
// ==============================
app.view("hubnote_modal_submit_v2", async ({ ack, body, view, client, logger }) => {
  // ACK ASAP to avoid 3-second error
  await ack();

  try {
    const meta = parsePrivateMetadata(view.private_metadata);

    const recordType = meta.recordType || findSelectedOptionValue(view.state.values, "hubnote_v2_record_type_select") || "ticket";
    const pipelineId = meta.pipelineId || findSelectedOptionValue(view.state.values, "hubnote_v2_pipeline_select") || "";
    const stageId = meta.stageId || findSelectedOptionValue(view.state.values, "hubnote_v2_stage_select") || "";

    const recordId = findSelectedOptionValue(view.state.values, "hubnote_v2_record_select");

    const noteTitle =
      view.state.values?.note_title_block_v2?.hubnote_v2_note_title_input?.value?.trim() || "";
    const noteBody =
      view.state.values?.note_body_block_v2?.hubnote_v2_note_body_input?.value?.trim() || "";

    const errors = {};
    if (!pipelineId || pipelineId.startsWith("__")) errors["pipeline_block_v2"] = "Select a pipeline.";
    if (!stageId || stageId.startsWith("__")) errors["stage_block_v2"] = "Select a stage.";
    if (!recordId || recordId.startsWith("__")) errors["record_block_v2"] = "Select a record.";
    if (!noteTitle) errors["note_title_block_v2"] = "Title is required.";
    if (!noteBody) errors["note_body_block_v2"] = "Body is required.";

    if (Object.keys(errors).length) {
      // Re-open errors by updating view
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: {
          ...buildCleanViewPayload(view, view.private_metadata),
        },
      }).catch(() => {});

      // Best-effort ephemeral error
      await client.chat.postEphemeral({
        channel: meta.originChannelId || body.user.id,
        user: body.user.id,
        text: "⚠️ Please complete all required fields in the modal.",
      }).catch(() => {});
      return;
    }

    const zapUrl = ZAPIER_HUBNOTE_TRIGGER_URL || ZAPIER_WEBHOOK_URL;
    if (!zapUrl) {
      await client.chat.postEphemeral({
        channel: meta.originChannelId || body.user.id,
        user: body.user.id,
        text: "❌ Missing ZAPIER_HUBNOTE_TRIGGER_URL (or ZAPIER_WEBHOOK_URL).",
      });
      return;
    }

    const payload = {
      source: "slack",
      command_name: "hubnote",
      version: "v2",
      correlation_id: meta.correlationId || `hubnote_${crypto.randomBytes(8).toString("hex")}`,
      hubspot_object_type: recordType,
      hubspot_object_id: String(recordId),
      pipeline_id: String(pipelineId),
      stage_id: String(stageId),
      note_title: noteTitle,
      note_body: noteBody,
      submitted_by_slack_user_id: body.user.id,
      submitted_at: nowIso(),
      origin_channel_id: meta.originChannelId || body.user.id,
      origin_user_id: meta.originUserId || body.user.id,
    };

    await axios.post(zapUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    await client.chat.postEphemeral({
      channel: payload.origin_channel_id,
      user: body.user.id,
      text: "✅ Sent to Zapier. Creating the HubSpot note now…",
    });
  } catch (e) {
    logger.error(e);
    try {
      const meta = parsePrivateMetadata(view.private_metadata);
      await client.chat.postEphemeral({
        channel: meta.originChannelId || body.user.id,
        user: body.user.id,
        text: "❌ Something went wrong sending to Zapier. Check Render logs.",
      });
    } catch (_) {}
  }
});

// ==============================
// Zapier Step 2 endpoint: create HubSpot note
// ==============================
receiver.app.post("/api/hubnote/create", async (req, res) => {
  if (!requireZapierSecret(req, res, HUBNOTE_ZAPIER_SECRET)) return;

  try {
    const {
      correlation_id,
      hubspot_object_type,
      hubspot_object_id,
      note_title,
      note_body,
      origin_channel_id,
      origin_user_id,
    } = req.body || {};

    if (!correlation_id || !hubspot_object_type || !hubspot_object_id) {
      return res.status(400).json({ ok: false, error: "missing required fields" });
    }

    const created = await hsCreateNoteAndAssociate({
      hubspot_object_type,
      hubspot_object_id,
      note_title,
      note_body,
    });

    return res.status(200).json({
      ok: true,
      correlation_id,
      hubspot_note_id: created.hubspot_note_id,
      hubspot_object_type: created.hubspot_object_type,
      hubspot_object_id: created.hubspot_object_id,
      origin_channel_id: origin_channel_id || "",
      origin_user_id: origin_user_id || "",
    });
  } catch (e) {
    console.error("[ERR] /api/hubnote/create", e?.response?.data || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ==============================
// Zapier Step 3 endpoint: callback to Slack
// ==============================
const hubnoteSessions = new Map(); // sessionId -> { noteId, channelId, userId }

receiver.app.post("/zapier/hubnote/callback", async (req, res) => {
  if (!requireZapierSecret(req, res, ZAPIER_HUBNOTE_SECRET)) return;

  try {
    const {
      correlation_id,
      hubspot_note_id,
      origin_channel_id,
      origin_user_id,
      hubspot_object_type,
      hubspot_object_id,
      status,
    } = req.body || {};

    if (!origin_channel_id || !origin_user_id) {
      return res.status(400).json({ ok: false, error: "missing origin_channel_id/origin_user_id" });
    }

    const sessionId = `hubnote_session_${crypto.randomBytes(12).toString("hex")}`;
    hubnoteSessions.set(sessionId, {
      correlation_id: correlation_id || "",
      hubspot_note_id: hubspot_note_id || "",
      hubspot_object_type: hubspot_object_type || "",
      hubspot_object_id: hubspot_object_id || "",
      channelId: origin_channel_id,
      userId: origin_user_id,
    });

    // Post ephemeral with buttons
    await app.client.chat.postEphemeral({
      channel: origin_channel_id,
      user: origin_user_id,
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
    });

    return res.status(200).json({ ok: true, status: status || "success" });
  } catch (e) {
    console.error("[ERR] /zapier/hubnote/callback", e?.response?.data || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// “No” button
app.action("hubnote_add_files_no", async ({ ack, body, client }) => {
  await ack();
  const sessionId = body?.actions?.[0]?.value;
  const sess = hubnoteSessions.get(sessionId);
  if (!sess) return;
  await client.chat.postEphemeral({
    channel: sess.channelId,
    user: sess.userId,
    text: "✅ Got it — no files added.",
  });
  hubnoteSessions.delete(sessionId);
});

// “Yes” button — open Attach Files modal
app.action("hubnote_add_files_yes", async ({ ack, body, client }) => {
  await ack();
  const sessionId = body?.actions?.[0]?.value;
  const sess = hubnoteSessions.get(sessionId);
  if (!sess) return;

  // NOTE: interactive button payload includes trigger_id; use it for views.open
  const triggerId = body?.trigger_id;
  if (!triggerId) {
    await client.chat.postEphemeral({
      channel: sess.channelId,
      user: sess.userId,
      text: "⚠️ Slack didn’t provide a trigger_id. Try again.",
    });
    return;
  }

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "hubnote_attach_files_submit",
      title: { type: "plain_text", text: "Attach files" },
      submit: { type: "plain_text", text: "Done" },
      close: { type: "plain_text", text: "Cancel" },
      private_metadata: JSON.stringify({ sessionId }),
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "Upload files here. I’ll confirm once Slack receives them.\n\n*(Optional: wiring these into HubSpot attachments can come next.)*",
          },
        },
        {
          type: "input",
          block_id: "hubnote_files_block",
          optional: true,
          label: { type: "plain_text", text: "Files" },
          element: {
            // Slack file input element for modals
            type: "file_input",
            action_id: "hubnote_files_input",
          },
        },
      ],
    },
  });
});

// Attach files modal submit
app.view("hubnote_attach_files_submit", async ({ ack, body, view, client }) => {
  await ack();
  const meta = parsePrivateMetadata(view.private_metadata);
  const sessionId = meta.sessionId;
  const sess = hubnoteSessions.get(sessionId);
  if (!sess) return;

  const files =
    view.state.values?.hubnote_files_block?.hubnote_files_input?.files || [];

  await client.chat.postEphemeral({
    channel: sess.channelId,
    user: sess.userId,
    text:
      files.length > 0
        ? `✅ Received ${files.length} file(s) in Slack. (HubSpot attach wiring is next.)`
        : "✅ No files uploaded.",
  });

  hubnoteSessions.delete(sessionId);
});

// ==============================
// Start
// ==============================
(async () => {
  try {
    await app.start(PORT);
    console.log("⚡️ SyllaBot is running (cstask + hubnote v2)");
  } catch (e) {
    console.error("Failed to start", e);
    process.exit(1);
  }
})();
