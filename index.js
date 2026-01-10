const { App, ExpressReceiver } = require("@slack/bolt");
const axios = require("axios");

// ===== CONFIG =====
const ZAPIER_WEBHOOK_URL =
  process.env.ZAPIER_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/25767132/ug29zll/";

// ===== Receiver with split endpoints (Bolt-supported) =====
// Use endpoints so Slack can hit different URLs for commands vs interactions.
// This avoids "Could not determine the type..." warnings.  [oai_citation:3‡HackerNoon](https://hackernoon.com/writing-a-slack-bot-that-responds-to-action-commands-v73b3tba?utm_source=chatgpt.com)
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

// ===== Slash command: /cstask =====
app.command("/cstask", async ({ ack, body, client, logger }) => {
  await ack(); // must happen within ~3 seconds

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
        ],
      },
    });
  } catch (e) {
    logger.error(e);
    // best-effort DM if modal open fails
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

  // Inline validation (shows errors in the modal)
  const errors = {};
  if (!taskName) errors["task_name_block"] = "Task name is required.";
  if (!ownerSlackUserId) errors["owner_block"] = "Please select an owner.";
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  if (!ZAPIER_WEBHOOK_URL) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "❌ ZAPIER_WEBHOOK_URL is missing. Add it in Render Environment Variables and redeploy.",
    });
    return;
  }

  // Look up owner's email from Slack (requires users:read.email + reinstall)
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

  // Send to Zapier
  try {
    await axios.post(
      ZAPIER_WEBHOOK_URL,
      {
        source: "slack",
        task_name: taskName,
        description,
        task_owner_slack_user_id: ownerSlackUserId,
        task_owner_email: taskOwnerEmail,
        submitted_by_slack_user_id: body.user.id,
        submitted_at: new Date().toISOString(),
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );

    await client.chat.postMessage({
      channel: body.user.id,
      text: `✅ Task sent to Zapier!\n• *Task:* ${taskName}\n• *Owner email:* ${taskOwnerEmail}`,
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
  console.log("⚡️ SyllaBot is running");
})();
