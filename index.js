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
    actions: "/slack/interactions", // also used for options load URL
  },
});

// 🔎 HARD LOGGING: log everything that hits the underlying Express app
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

app.options("board_select", async ({ options, ack, logger }) => {
  console.log("[OPTIONS] board_select fired; search:", options?.value);

  try {
    if (!MONDAY_API_TOKEN) {
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

// ✅ When a board is selected, store it in private_metadata (correct views.update payload)
app.action("board_select", async ({ ack, body, client, logger }) => {
  await ack();

  try {
    const selectedBoardId = body?.actions?.[0]?.selected_option?.value || "";
    const view = body?.view;

    if (!view?.id || !selectedBoardId) return;

    // Parse existing metadata
    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || "{}");
    } catch {
      meta = {};
    }
    meta.boardId = selectedBoardId;

    // IMPORTANT: views.update requires a "view payload" (no id/team_id/state/hash/etc)
    const cleanView = {
      type: "modal",
      callback_id: view.callback_id,
      title: view.title,
      submit: view.submit,
      close: view.close,
      blocks: view.blocks,
      private_metadata: JSON.stringify(meta),
      clear_on_close: view.clear_on_close,
      notify_on_close: view.notify_on_close,
    };

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

  // ✅ Read boardId from private_metadata (reliable)
  const boardId = (() => {
    try {
      const meta = JSON.parse(view.private_metadata || "{}");
      return meta.boardId || "";
    } catch {
      return "";
    }
  })();

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
  if (!boardId) errors["board_block"] = "Please select a board.";
  if (!groupId) errors["group_block"] = "Please select a group.";
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
        version: "v3.1",
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
  console.log("⚡️ SyllaBot is running (board->group fixed via private_metadata)");
})();
