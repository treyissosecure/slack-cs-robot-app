// features/hubtask.js
const crypto = require("crypto");

// Small helper to build Slack options
function option(text, value) {
  return { text: { type: "plain_text", text }, value: String(value) };
}

function buildHubtaskModal({ correlationId, originChannelId, originUserId }) {
  return {
    type: "modal",
    callback_id: "hubtask_modal_submit_v1",
    title: { type: "plain_text", text: "HubSpot Task" },
    submit: { type: "plain_text", text: "Create" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({
      correlationId,
      originChannelId,
      originUserId,

      // We'll store selections here as user interacts (optional pattern)
      // Example: recordType, recordId, etc.
    }),
    blocks: [
      {
        type: "input",
        block_id: "hubtask_queue_block",
        optional: true,
        label: { type: "plain_text", text: "Task Queue" },
        element: {
          type: "external_select",
          action_id: "hubtask_queue_select",
          placeholder: { type: "plain_text", text: "Search/select queue" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "hubtask_view_block",
        optional: true,
        label: { type: "plain_text", text: "Task View" },
        element: {
          type: "external_select",
          action_id: "hubtask_view_select",
          placeholder: { type: "plain_text", text: "Search/select view" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "hubtask_title_block",
        label: { type: "plain_text", text: "Task Title" },
        element: {
          type: "plain_text_input",
          action_id: "hubtask_title_input",
          placeholder: { type: "plain_text", text: "e.g., Follow up with principal" },
        },
      },
      {
        type: "input",
        block_id: "hubtask_status_block",
        label: { type: "plain_text", text: "Task Status" },
        element: {
          type: "external_select",
          action_id: "hubtask_status_select",
          placeholder: { type: "plain_text", text: "Search/select status" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "hubtask_type_block",
        optional: true,
        label: { type: "plain_text", text: "Task Type" },
        element: {
          type: "external_select",
          action_id: "hubtask_type_select",
          placeholder: { type: "plain_text", text: "Search/select type" },
          min_query_length: 0,
        },
      },
      {
        type: "input",
        block_id: "hubtask_priority_block",
        optional: true,
        label: { type: "plain_text", text: "Priority" },
        element: {
          type: "external_select",
          action_id: "hubtask_priority_select",
          placeholder: { type: "plain_text", text: "Search/select priority" },
          min_query_length: 0,
        },
      },

      // Associations (record type first, then record search)
      {
        type: "input",
        block_id: "hubtask_assoc_type_block",
        label: { type: "plain_text", text: "Associate With: Record Type" },
        element: {
          type: "static_select",
          action_id: "hubtask_assoc_type_select",
          options: [
            option("Contact", "contacts"),
            option("Company", "companies"),
            option("Deal", "deals"),
            option("Ticket", "tickets"),
          ],
        },
      },
      {
        type: "input",
        block_id: "hubtask_assoc_record_block",
        label: { type: "plain_text", text: "Associate With: Record" },
        element: {
          type: "external_select",
          action_id: "hubtask_assoc_record_select",
          placeholder: { type: "plain_text", text: "Search/select record" },
          min_query_length: 0,
        },
      },

      // Assigned to (owners)
      {
        type: "input",
        block_id: "hubtask_owner_block",
        label: { type: "plain_text", text: "Assigned To" },
        element: {
          type: "external_select",
          action_id: "hubtask_owner_select",
          placeholder: { type: "plain_text", text: "Search/select owner" },
          min_query_length: 0,
        },
      },

      // Due date + reminder
      {
        type: "input",
        block_id: "hubtask_due_block",
        optional: true,
        label: { type: "plain_text", text: "Due Date" },
        element: { type: "datepicker", action_id: "hubtask_due_date" },
      },
      {
        type: "input",
        block_id: "hubtask_reminder_block",
        optional: true,
        label: { type: "plain_text", text: "Reminder" },
        element: {
          type: "static_select",
          action_id: "hubtask_reminder_select",
          options: [
            option("No reminder", "none"),
            option("At time of due date", "at_due"),
            option("15 minutes before", "15m"),
            option("1 hour before", "1h"),
            option("1 day before", "1d"),
          ],
        },
      },

      // Notes
      {
        type: "input",
        block_id: "hubtask_notes_block",
        optional: true,
        label: { type: "plain_text", text: "Notes" },
        element: {
          type: "plain_text_input",
          action_id: "hubtask_notes_input",
          multiline: true,
          placeholder: { type: "plain_text", text: "These become the task notes in HubSpot." },
        },
      },
    ],
  };
}

/**
 * Register all /sylla hubtask behaviors on your existing Bolt app.
 * We inject helpers from index.js so we do NOT duplicate HubSpot auth code.
 */
function registerHubtask({
  app,
  hubspotRequest,
  parsePrivateMetadata,
  buildCleanViewPayload,
}) {
  // -------------------------
  // /sylla hubtask
  // -------------------------
  app.command("/sylla", async ({ ack, body, client, logger }) => {
    await ack();

    const text = (body.text || "").trim();
    const [subcommand] = text.split(/\s+/);

    if ((subcommand || "").toLowerCase() !== "hubtask") return;

    try {
      const correlationId = `hubtask_${crypto.randomBytes(12).toString("hex")}`;
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildHubtaskModal({
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
          text: "❌ I couldn’t open the HubSpot task form. Please try again.",
        });
      } catch (_) {}
    }
  });

  // -------------------------
  // Dynamic dropdowns
  // NOTE: We’ll wire these to HubSpot APIs next.
  // For now, they return placeholders so nothing breaks.
  // -------------------------

  app.options("hubtask_status_select", async ({ ack }) => {
    // Placeholder — next step we will fetch HubSpot task status options live
    await ack({
      options: [
        option("Not started", "NOT_STARTED"),
        option("In progress", "IN_PROGRESS"),
        option("Completed", "COMPLETED"),
      ],
    });
  });

  app.options("hubtask_type_select", async ({ ack }) => {
    await ack({
      options: [option("Call", "CALL"), option("Email", "EMAIL"), option("To do", "TODO")],
    });
  });

  app.options("hubtask_priority_select", async ({ ack }) => {
    await ack({
      options: [option("Low", "LOW"), option("Medium", "MEDIUM"), option("High", "HIGH")],
    });
  });

  app.options("hubtask_owner_select", async ({ ack }) => {
    // Placeholder — next step: fetch owners from HubSpot and filter by query
    await ack({ options: [option("Trey Simpson (placeholder)", "12345")] });
  });

  app.options("hubtask_assoc_record_select", async ({ body, options, ack }) => {
    // Placeholder — next step: search HubSpot objects based on assoc type + query
    const q = (options?.value || "").trim();
    await ack({
      options: [option(q ? `Match for "${q}" (placeholder)` : "Start typing to search (placeholder)", "0")],
    });
  });

  // Optional: when assoc type changes, store it so record search knows what to search
  app.action("hubtask_assoc_type_select", async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const selected = body?.actions?.[0]?.selected_option?.value || "contacts";
      const view = body?.view;
      if (!view?.id) return;

      const meta = parsePrivateMetadata(view.private_metadata);
      meta.hubtaskAssocType = selected;

      // reset downstream selection if you want (record)
      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: buildCleanViewPayload(view, JSON.stringify(meta)),
      });
    } catch (e) {
      logger.error(e);
    }
  });

  // -------------------------
  // Modal submit -> create task in HubSpot
  // -------------------------
  app.view("hubtask_modal_submit_v1", async ({ ack, body, view, client, logger }) => {
    try {
      const v = view.state.values || {};
      const title = (v.hubtask_title_block?.hubtask_title_input?.value || "").trim();

      const status = v.hubtask_status_block?.hubtask_status_select?.selected_option?.value || "";
      const type = v.hubtask_type_block?.hubtask_type_select?.selected_option?.value || "";
      const priority = v.hubtask_priority_block?.hubtask_priority_select?.selected_option?.value || "";

      const ownerId = v.hubtask_owner_block?.hubtask_owner_select?.selected_option?.value || "";

      const dueDate = v.hubtask_due_block?.hubtask_due_date?.selected_date || ""; // YYYY-MM-DD
      const notes = (v.hubtask_notes_block?.hubtask_notes_input?.value || "").trim();

      const assocType = v.hubtask_assoc_type_block?.hubtask_assoc_type_select?.selected_option?.value || "";
      const assocRecordId = v.hubtask_assoc_record_block?.hubtask_assoc_record_select?.selected_option?.value || "";

      const errors = {};
      if (!title) errors.hubtask_title_block = "Task title is required.";
      if (!status) errors.hubtask_status_block = "Task status is required.";
      if (!ownerId) errors.hubtask_owner_block = "Please select who it’s assigned to.";
      if (!assocType) errors.hubtask_assoc_type_block = "Select a record type.";
      if (!assocRecordId) errors.hubtask_assoc_record_block = "Select a record to associate.";

      if (Object.keys(errors).length) {
        await ack({ response_action: "errors", errors });
        return;
      }

      await ack();

      // Minimal HubSpot task create (we’ll align exact properties after we wire live option sources)
      // Note: dueDate from Slack is YYYY-MM-DD; HubSpot often expects ms epoch for date properties.
      const dueMs = dueDate ? Date.parse(`${dueDate}T12:00:00Z`) : null;

      const payload = {
        properties: {
          hs_task_subject: title,
          hs_task_status: status,
          ...(type ? { hs_task_type: type } : {}),
          ...(priority ? { hs_task_priority: priority } : {}),
          ...(notes ? { hs_task_body: notes } : {}),
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
          ...(dueMs ? { hs_timestamp: String(dueMs) } : {}),
        },
      };

      // Create task
      const created = await hubspotRequest("POST", "/crm/v3/objects/tasks", payload);
      const taskId = created?.id;

      // Associate task to selected object
      // CRM v4 association endpoint shape is nuanced; we’ll wire exact association type IDs next.
      // For now: just confirm creation in Slack so you can validate end-to-end.
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ HubSpot task created${taskId ? ` (Task ID: ${taskId})` : ""}. Association wiring is the next step.`,
      });
    } catch (e) {
      logger.error(e);
      await ack({
        response_action: "errors",
        errors: {
          hubtask_notes_block: "Something went wrong creating the task. Check Render logs and try again.",
        },
      });
    }
  });
}

module.exports = { registerHubtask };
