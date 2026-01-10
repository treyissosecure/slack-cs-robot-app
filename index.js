const { App } = require("@slack/bolt");
const axios = require("axios");
const express = require("express");
const crypto = require("crypto");

// ===== CONFIG =====
// Your Zapier catch hook (hardcoded per your request)
const ZAPIER_WEBHOOK_URL =
  process.env.ZAPIER_WEBHOOK_URL ||
  "https://hooks.zapier.com/hooks/catch/25767132/ug29zll/";

// Slack signing secret MUST be in env vars
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// ===== Slack signature verification =====
function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  if (!timestamp || !slackSignature) return false;

  // Prevent replay attacks (5 minutes)
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const sigBaseString = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(sigBaseString, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch {
    return false;
  }
}

// ===== Custom receiver with split endpoints =====
class SplitEndpointsReceiver {
  constructor() {
    this.expressApp = express();

    // IMPORTANT: Use raw body so signature verification works
    this.expressApp.use("/slack", express.raw({ type: "*/*" }));

    this.expressApp.post("/slack/commands", (req, res) =>
      this.handleSlack(req, res)
    );
    this.expressApp.post("/slack/interactions", (req, res) =>
      this.handleSlack(req, res)
    );

    // Simple health check
    this.expressApp.get("/", (req, res) => res.status(200).send("OK"));
  }

  init(boltApp) {
    this.bolt = boltApp;
  }

  start(port) {
    return new Promise((resolve) => {
      this.server = this.expressApp.listen(port, () => resolve(this.server));
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  async handleSlack(req, res) {
    const rawBody = (req.body || Buffer.from("")).toString("utf8");

    // Verify request came from Slack
    if (!SIGNING_SECRET || !verifySlackSignature(req, rawBody)) {
      res.status(401).send("Invalid signature");
      return;
    }

    // Provide Bolt what it needs: raw body + headers + ack
    const event = {
      body: rawBody,
      headers: req.headers, // ✅ critical so Bolt can classify the request
      ack: (response) => {
        if (res.headersSent) return;
        if (response === undefined) return res.status(200).send("");
        if (typeof response === "string") return res.status(200).send(response);
        return res.status(200).json(response);
      },
    };

    try {
      await this.bolt.processEvent(event);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).send("");
    }
  }
}

// ===== Bolt app using the custom receiver =====
const receiver = new SplitEndpointsReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN, // must be set in Render env vars
  receiver,
});

// ===== Slash command: /cstask =====
app.command("/cstask", async ({ ack, body, client }) => {
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
    console.error(e);
    try {
      await client.chat.postMessage({
        channel: body.user_id,
        text: "❌ I couldn’t open the task form. Please try again or contact an admin.",
      });
    } catch (err) {
      console.error(err);
    }
  }
});

// ===== Modal submit handler =====
app.view("cstask_modal_submit", async ({ ack, body, view, client }) => {
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

  // ACK immediately so Slack UI doesn't timeout
  await ack();

  // Look up owner's email from Slack (requires users:read.email scope + reinstall)
  let taskOwnerEmail = null;
  try {
    const userInfo = await client.users.info({ user: ownerSlackUserId });
    taskOwnerEmail = userInfo?.user?.profile?.email || null;
  } catch (e) {
    console.error(e);
  }

  if (!taskOwnerEmail) {
    await client.chat.postMessage({
      channel: body.user.id,
      text:
        "⚠️ I couldn’t retrieve the selected owner’s email from Slack.\n" +
        "An admin may need to grant SyllaBot the `users:read.email` permission and reinstall the app.",
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
    console.error(e);
    await client.chat.postMessage({
      channel: body.user.id,
      text:
        "❌ I couldn’t send that task to Zapier. Check your Zapier Catch Hook step is turned on and try again.",
    });
  }
});

// ===== Start server =====
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ SyllaBot is running");
})();
