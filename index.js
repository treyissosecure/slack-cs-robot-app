app.view("cstask_modal_submit", async ({ ack, body, view, client }) => {
  const taskName = view.state.values.task_name_block.task_name_input.value?.trim() || "";
  const description = view.state.values.description_block?.description_input?.value?.trim() || "";
  const ownerSlackUserId = view.state.values.owner_block.owner_user_select.selected_user || "";

  // inline validation
  const errors = {};
  if (!taskName) errors["task_name_block"] = "Task name is required.";
  if (!ownerSlackUserId) errors["owner_block"] = "Please select an owner.";
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }

  await ack();

  // Look up owner's email from Slack
  const userInfo = await client.users.info({ user: ownerSlackUserId });
  const taskOwnerEmail = userInfo?.user?.profile?.email || null;

  // If we can't get an email, message the submitter and stop
  if (!taskOwnerEmail) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: "⚠️ I couldn’t retrieve the selected owner’s email from Slack. An admin may need to grant SyllaBot the users:read.email permission, or choose a different owner."
    });
    return;
  }

  // Send to Zapier
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

  // DM confirmation
  await client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Task sent to Zapier!\n• *Task:* ${taskName}`,
  });
});
