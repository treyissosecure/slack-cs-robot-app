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
// SLACK RECEIVER (split endpoints)
// ==============================
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
    actions: "/slack/interactions",
  },
});

// Log every incoming request to Slack endpoints (very useful for debugging)
receiver.router.use((req, res, next) => {
  console.log(
    "[HTTP]",
    req.method,
    req.originalUrl,
    "CT:",
    req.headers["content-type"]
  );
  next();
});

// Simple health check so you can hit https://<render>/ and see OK
receiver.router.get("/", (req, res) => res.status(200).send("OK"));

// ==============================
// BOLT APP
// ==============================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.DEBUG,
});

// ==============================
// MONDAY API HELPERS
// ==============================
async function mondayGraphQL(query, variables = {}) {
  if (!MONDAY_API_TOKEN) {
    throw new Error("Missing MONDAY_API_TOKEN");
  }

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
  // NOTE: boards(limit:100) returns up to 100 boards. If you have more, we can paginate later.
  const data = await mondayGraphQL(
    `
    query ($limit:Int!) {
      boards(limit: $limit) { id name }
    }
  `,
    { limit: 100 }
  );

  const boards = data?.boards || [];
  const s = (search || "").toLowerCase();

  return boards
    .filter((b) => !s || (b.name || "").toLowerCase().includes(s))
    .slice(0, 100)
    .map((b) => ({
      text: { type: "plain_text", text: b.name },
      value: String(b.id),
    }));
}

async function fetchGroups(boardId, search = "") {
  if (!boardId) return [];

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
  const s = (search || "").toLowerCase();

  return groups
    .filter((g) => !s || (g.title || "").toLowerCase().includes(s))
    .slice(0, 100)
    .map((g) => ({
      text: { type: "plain_text", text: g.title },
      value: String(g.id),
    }));
}

// ==============================
// DYNAMIC DROPDOWNS (Slack external_select options)
// ==============================

// Board dropdown options
app.options("board_select", async ({ options, ack, logger }) => {
  console.log("[OPTIONS] board_select fired; search:", options?.value);

  try {
    if (!MONDAY_API_TOKEN) {
      console.error("[OPTIONS] MONDAY_API_TOKEN missing");
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "ERROR: MONDAY_API_TOKEN missing in Render" },
            value: "ERROR_NO_MONDAY_TOKEN",
          },
        ],
      });
    }

    const boardOptions = await fetchBoards(options?.value || "");

    if (!boardOptions.length) {
      console.warn("[OPTIONS] No boards returned from Monday");
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "No boards found (token perms?)" },
            value: "NO_BOARDS_FOUND",
          },
        ],
      });
    }

    console.log("[OPTIONS] Returning boards:", boardOptions.length);
    await ack({ options: boardOptions });
  } catch (e) {
    logger.error(e);
    console.error("[OPTIONS] board_select error:", e?.message || e);
    await ack({
      options: [
        {
          text: { type: "plain_text", text: "ERROR loading boards (see Render logs)" },
          value: "ERROR_LOADING_BOARDS",
        },
      ],
    });
  }
});

// Group dropdown options (depends on selected board)
app.options("group_select", async ({ body, options, ack, logger }) => {
  const boardId =
    body?.view?.state?.values?.board_block?.board_select?.selected_option?.value || "";

  console.log("[OPTIONS] group_select fired; boardId:", boardId, "; search:", options?.value);

  try {
    if (!boardId || boardId.startsWith("ERROR") || boardId.startsWith("NO_")) {
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "Select a valid board first" },
            value: "SELECT_BOARD_FIRST",
          },
        ],
      });
    }

    const groupOptions = await fetchGroups(boardId, options?.value || "");

    if (!groupOptions.length) {
      console.warn("[OPTIONS] No groups returned for board:", boardId);
      return await ack({
        options: [
          {
            text: { type: "plain_text", text: "No groups found for this board" },
            value: "NO_GROUPS_FOUND",
          },
        ],
      });
    }

    console.log("[OPTIONS] Returning groups:", groupOptions.length);
    await ack({ options: groupOptions });
  } catch (e) {
    logger.error(e);
    console.error("[OPTIONS] group_select error:", e?.message || e);
    await ack({
      options: [
        {
          text: { type: "plain_text", text: "ERROR loading groups (see Render logs)" },
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
    await client.chat.postMessage({
      channel: body.user_id,
      text: "❌ I couldn’t open the task form. Please try again or contact an admin.",
    });
  }
});

// ==============================
// MODAL SUBMIT -> SEND TO ZAPIER
// ==============================
app.view("cstask_modal_submit", async ({ ack, body, view, client, logger }) => {
  const taskName =
    view.state.values.task_name_block.task_name_input.value?.trim() || "";
  const description =
    view.state.values.description_block?.description_input?.value?.trim() || "";

  const ownerSlackUserId =
    view.state.values.owner_block.owner_user_select.selected_user || "";

  const boardId =
    view.state.values.board_block.board_select.selected_option?.value || "";

  const groupId =
    view.state.values.group_block.group_select.selected_option?.value || "";

  const statusLabel =
    view.state.values.status_block.status_select.selected_option?.value || "";

  const priorityLabel =
    view.state.values.priority_block.priority_select.selected_option?.value || "";

  // Inline validation
  const errors = {};
  if (!taskName) errors["task_name_block"] = "Task name is required.";
  if (!ownerSlackUserId) errors["owner_block"] = "Please select an owner.";
  if (!boardId || boardId.startsWith("ERROR") || boardId.startsWith("NO_"))
    errors["board_block"] = "Please select a valid board.";
  if (!groupId || groupId.startsWith("ERROR") || groupId.startsWith("NO_"))
    errors["group_block"] = "Please select a valid group.";
  if (!statusLabel) errors["status_block"] = "Please select a status.";
  if (!priorityLabel) errors["priority_block"] = "Please select a priority.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  // Owner email lookup (requires Slack scopes users:read + users:read.email and reinstall)
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

  // Send to Zapier
  try {
    await axios.post(
      ZAPIER_WEBHOOK_URL,
      {
        source: "slack",
        command_name: "cstask",
        version: "v3",
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
  console.log("⚡️ SyllaBot is running (dynamic board/group enabled)");
})();
