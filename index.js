const { App, ExpressReceiver } = require("@slack/bolt");
const axios = require("axios");

// ===== CONFIG =====
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

// ===== Receiver with split endpoints =====
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
    actions: "/slack/interactions",
  },
});

// ===== Bolt App =====
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

function toStaticOptions(labels) {
  return labels.map((label) => ({
    text: { type: "plain_text", text: label },
    value: label,
  }));
}

// ===== Monday API helpers =====
async function mondayGraphQL(query, variables = {}) {
  if (!MONDAY_API_TOKEN) throw new Error("Missing MONDAY_API_TOKEN");
  const res = await axios.post(
    "https://api.monday.com/v2",
    { query, variables },
    { headers: { Authorization: MONDAY_API_TOKEN, "Content-Type": "application/json" }, timeout: 10000 }
  );
  if (res.data?.errors?.length) {
    throw new Error(`Monday API error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data;
}

async function fetchBoards(search = "") {
  // Fetch boards (limit 100). If you have tons of boards, we can improve this later.
  const data = await mondayGraphQL(`
    query ($limit:Int!) {
      boards(limit: $limit) { id name }
    }
  `, { limit: 100 });

  const boards = data?.boards || [];
  const s = (search || "").toLowerCase();
  return boards
    .filter(b => !s || b.name.toLowerCase().includes(s))
    .slice(0, 100)
    .map(b => ({
      text: { type: "plain_text", text: b.name },
      value: String(b.id),
    }));
}

async function fetchGroups(boardId, search = "") {
  if (!boardId) return [];
  const data = await mondayGraphQL(`
    query ($ids:[ID!]!) {
      boards(ids: $ids) {
        id
        groups { id title }
      }
    }
  `, { ids: [boardId] });

  const groups = data?.boards?.[0]?.groups || [];
  const s = (search || "").toLowerCase();
  return groups
    .filter(g => !s || g.title.toLowerCase().includes(s))
    .slice(0, 100)
    .map(g => ({
      text: { type: "plain_text", text: g.title },
      value: String(g.id),
    }));
}

// ===== Dynamic options handlers =====
// Slack calls these when user opens/types in an external_select.  [oai_citation:1‡Slack Developer Docs](https://docs.slack.dev/reference/interaction-payloads/block_suggestion-payload/?utm_source=chatgpt.com)

app.options("board_select", async ({ options, ack, logger }) => {
  try {
    const search = options?.value || "";
    const boardOptions = await fetchBoards(search);
    await ack({ options: boardOptions });
  } catch (e) {
    logger.error(e);
    await ack({ options: [] });
  }
});

app.options("group_select", async ({ body, options, ack, logger }) => {
  try {
    const search = options?.value || "";

    // Try to read the selected board from the modal state
    const boardId =
      body?.view?.state?.values?.board_block?.board_select?.selected_option?.value || "";

    const groupOptions = await fetchGroups(boardId, search);
    await ack({ options: groupOptions });
  } catch (e) {
    logger.error(e);
    await ack({ options: [] });
  }
});

// ===== Slash command: /cstask =====
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
            element: {
              type: "plain_text_input",
              action_id: "task_name_input",
              placeholder: { type: "plain_text", text: "e.g., Follow up with Acme" },
            },
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
              placeholder: { type: "plain_text", text: "Context, links, next steps..." },
            },
          },
          {
            type: "input",
            block_id: "owner_block",
            label: { type: "plain_text", text: "Task Owner" },
            element: {
              type: "users_select",
              action_id: "owner_user_select",
              placeholder: { type: "plain_text", text: "Select a Slack user" },
            },
          },

          // ✅ Dynamic Board
          {
            type: "input",
            block_id: "board_block",
            label: { type: "plain_text", text: "Monday Board" },
            element: {
              type: "external_select",
              action_id: "board_select",
              placeholder: { type: "plain_text", text: "Search/select a board" },
              min_query_length: 0
            },
          },

          // ✅ Dynamic Group (depends on board selection)
          {
            type: "input",
            block_id: "group_block",
            label: { type: "plain_text", text: "Monday Group" },
            element: {
              type: "external_select",
              action_id: "group_select",
              placeholder: { type: "plain_text", text: "Search/select a group" },
              min_query_length: 0
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
    } catch (err) {
      logger.error(err);
    }
  }
});

// ===== Modal submit handler =====
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
  if (!boardId) errors["board_block"] = "Please select a board.";
  if (!groupId) errors["group_block"] = "Please select a group.";
  if (!statusLabel) errors["status_block"] = "Please select a status.";
  if (!priorityLabel) errors["priority_block"] = "Please select a priority.";

  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  // Look up owner's email (requires users:read.email + reinstall)
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
        "Make sure SyllaBot has the `users:read.email` scope and that you reinstalled the app.",
    });
    return;
  }

  // Send to Zapier (now includes board_id + group_id)
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
      text:
        "❌ I couldn’t send that task to Zapier. Check your Zapier Catch Hook is on and try again.",
    });
  }
});

// ===== Start server =====
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ SyllaBot is running (cstask v3: dynamic board/group)");
})();
