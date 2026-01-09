const { App } = require("@slack/bolt");
const axios = require("axios");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;

app.command("/cstask", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "cstask_modal",
      title: { type: "plain_text", text: "Create CS Task" },
      submit: { type: "plain_text", text: "Create" },
      blocks: [
        {
          type: "input",
          block_id: "name",
          label: { type: "plain_text", text: "Task Name" },
          element: {
            type: "plain_text_input",
            action_id: "value"
          }
        },
        {
          type: "input",
          block_id: "desc",
          label: { type: "plain_text", text: "Description" },
          element: {
            type: "plain_text_input",
            action_id: "value",
            multiline: true
          }
        }
      ]
    }
  });
});

app.view("cstask_modal", async ({ ack, body, view, client }) => {
  await ack();

  const taskName = view.state.values.name.value.value;
  const description = view.state.values.desc.value.value;

  await axios.post(ZAPIER_WEBHOOK_URL, {
    task_name: taskName,
    description,
    submitted_by: body.user.username
  });

  await client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Task sent: *${taskName}*`
  });
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡ Slack app running");
})();
