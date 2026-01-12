const { App, ExpressReceiver, LogLevel } = require("@slack/bolt");
const axios = require("axios");

// ==============================
// CONFIG
// ==============================
const ZAPIER_WEBHOOK_URL =
  process.env.ZAPIER_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/25767132/ug29zll/";

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

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
  console.log("[REQ]", req.method, req.originalUrl, "CT:", req.headers["content-type"]);
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
          text: { type: "plain_text", text: "ERROR loading boards (check Render logs)" },
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

    // Optional: when board changes, you might want to clear the selected group.
    // Slack will show whatever the user previously selected otherwise.
    // We can clear it by rebuilding blocks and setting initial_option to null, but Slack doesn't
    // support "unset selected_option" directly on external_select. So we just rely on re-opening group.

    // Also: clear cached groups for this board? Not needed; cache is per-board and short.
    // But you CAN clear any "previous board" groups if you want.

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
// START SERVER
// ==============================
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ SyllaBot is running (stable dropdowns + board→group fix)");
})();
